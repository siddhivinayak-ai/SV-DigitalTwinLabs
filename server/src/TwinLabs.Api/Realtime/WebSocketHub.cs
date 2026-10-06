using System.Buffers;
using System.Net.WebSockets;
using System.Text.Json;
using TwinLabs.Api.Hosting;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Realtime;

public static class WebSocketHub
{
    public const int MaxInboundBytes = 64 * 1024;

    public static IEndpointRouteBuilder MapTwinHub(this IEndpointRouteBuilder app, string pattern = "/ws")
    {
        app.Map(pattern, async (HttpContext ctx, SimulationHost host, IHostApplicationLifetime lifetime, ILoggerFactory lf) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
                return Results.Problem(detail: "Expected a WebSocket upgrade request.", statusCode: StatusCodes.Status400BadRequest, title: "Bad Request");

            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            var session = new WebSocketSession(ws, host, lf.CreateLogger("TwinLabs.Api.WebSocket"));
            await session.RunAsync(ctx.RequestAborted, lifetime.ApplicationStopping);
            return Results.Empty;
        });
        return app;
    }
}

/// <summary>
/// One client connection: a send loop draining the <see cref="ClientOutbox"/> (assigning <c>seq</c> as frames go
/// out) and a receive loop handling <c>command</c> envelopes. The sim loop only ever enqueues, so a slow client
/// can only stall its own send loop.
/// </summary>
internal sealed class WebSocketSession(WebSocket ws, SimulationHost host, ILogger log)
{
    private static readonly TimeSpan DrainTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(2);

    private readonly ClientOutbox _outbox = new();
    private long _seq;

    public async Task RunAsync(CancellationToken aborted, CancellationToken stopping)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(aborted);
        // On shutdown: send a close frame after the queue drains, then give the client a moment to answer.
        using var onStop = stopping.Register(() =>
        {
            _outbox.Complete(WebSocketCloseStatus.EndpointUnavailable, "Server shutting down");
            try { cts.CancelAfter(CloseHandshakeTimeout); } catch (ObjectDisposedException) { }
        });

        host.Connect(_outbox);
        var send = SendLoopAsync(cts);
        try
        {
            await ReceiveLoopAsync(cts.Token);
        }
        finally
        {
            host.Disconnect(_outbox);
            _outbox.Complete();
            try
            {
                await send.WaitAsync(DrainTimeout, CancellationToken.None);
            }
            catch (TimeoutException)
            {
                cts.Cancel();
                ws.Abort();
            }
            catch { /* logged in the loop */ }
        }
    }

    private async Task SendLoopAsync(CancellationTokenSource cts)
    {
        var ct = cts.Token;
        var buffer = new ArrayBufferWriter<byte>(16 * 1024);
        try
        {
            while (await _outbox.WaitToReadAsync(ct))
            {
                while (_outbox.TryDequeue(out var frame))
                {
                    buffer.ResetWrittenCount();
                    frame.WriteEnvelope(buffer, ++_seq);
                    await ws.SendAsync(buffer.WrittenMemory, WebSocketMessageType.Text, endOfMessage: true, ct);
                }
            }

            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var closeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                closeCts.CancelAfter(CloseHandshakeTimeout);
                await ws.CloseOutputAsync(_outbox.CloseStatus ?? WebSocketCloseStatus.NormalClosure, _outbox.CloseReason, closeCts.Token);
            }

            // We initiated the close (overflow / shutdown): don't wait forever for the client's reply.
            if (_outbox.CloseStatus is not WebSocketCloseStatus.NormalClosure)
                cts.CancelAfter(CloseHandshakeTimeout);
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            // client went away or we are shutting down
            _outbox.Complete();
            try { cts.Cancel(); } catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            log.LogError(ex, "WebSocket send loop failed");
            _outbox.Complete();
            try { cts.Cancel(); } catch (ObjectDisposedException) { }
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var chunk = new byte[4096];
        var message = new ArrayBufferWriter<byte>(4096);
        try
        {
            while (ws.State is WebSocketState.Open)
            {
                message.ResetWrittenCount();
                var tooBig = false;
                ValueWebSocketReceiveResult r;
                do
                {
                    r = await ws.ReceiveAsync(chunk.AsMemory(), ct);
                    if (r.MessageType == WebSocketMessageType.Close) return;
                    if (message.WrittenCount + r.Count > WebSocketHub.MaxInboundBytes) tooBig = true;
                    else message.Write(chunk.AsSpan(0, r.Count));
                } while (!r.EndOfMessage);

                if (tooBig) Reply(new AckData("", false, $"Message exceeds {WebSocketHub.MaxInboundBytes} bytes"));
                else if (r.MessageType == WebSocketMessageType.Binary) Reply(new AckData("", false, "Binary frames are not supported; send JSON text"));
                else Reply(Handle(message.WrittenSpan));
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            // disconnect / shutdown: nothing to report
        }
    }

    private void Reply(AckData ack) => _outbox.Enqueue(Frame.Create(MessageTypes.Ack, host.SimTimeMs, ack));

    /// <summary>Parse one inbound frame and execute it. Never throws: every failure becomes an ok=false ack.</summary>
    internal AckData Handle(ReadOnlySpan<byte> json)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json.ToArray());
        }
        catch (JsonException ex)
        {
            return new AckData("", false, $"Malformed JSON: {ex.Message}");
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return new AckData("", false, "Expected an envelope object {type, data}");

            var data = root.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object ? d : default;
            var id = data.ValueKind == JsonValueKind.Object && data.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String
                ? idEl.GetString() ?? ""
                : "";

            var type = root.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            if (type != MessageTypes.Command)
                return new AckData(id, false, $"Unsupported message type '{type ?? "(missing)"}'; expected 'command'");
            if (data.ValueKind != JsonValueKind.Object)
                return new AckData(id, false, "Command envelope needs a 'data' object");

            CommandData? cmd;
            try
            {
                cmd = data.Deserialize<CommandData>(TwinJson.Options);
            }
            catch (JsonException ex)
            {
                return new AckData(id, false, $"Invalid command: {ex.Message}");
            }

            if (cmd is null || string.IsNullOrWhiteSpace(cmd.Id)) return new AckData(id, false, "Command needs a non-empty 'data.id'");
            if (string.IsNullOrWhiteSpace(cmd.Action)) return new AckData(cmd.Id, false, "Command needs 'data.action'");
            return host.Execute(cmd);
        }
    }
}
