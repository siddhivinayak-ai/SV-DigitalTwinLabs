using System.Buffers;
using System.Text.Json;
using MQTTnet;
using MQTTnet.Protocol;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt;

/// <summary>
/// MQTT client tag source. Subscribes to every unique binding address (an MQTT topic filter; <c>+</c>/<c>#</c> work) and
/// emits one <see cref="TagUpdate"/> per received message whose <see cref="TagUpdate.Address"/> is the binding address,
/// so <see cref="BindingResolver"/> resolves it by (connection, address).
/// <para>
/// <b>Shared topics:</b> <see cref="TagUpdate"/> carries no jsonPath and the resolver applies one raw value to every binding
/// on an address, so all bindings on one address must use the same jsonPath (or none). An address whose bindings disagree
/// is not subscribed (it would feed the wrong field into some targets); it is reported in <see cref="Warnings"/> and in
/// <see cref="ConnectionStatus.Error"/>, and those bindings do not count towards <see cref="ConnectionStatus.BoundTags"/>.
/// </para>
/// Never throws for connection problems: it retries with exponential backoff (1 s … 30 s) and reports through
/// <see cref="Status"/>/<see cref="StatusChanged"/>.
/// </summary>
public sealed class MqttTagSource : ITagSource
{
    private sealed record Sub(string Filter, string[]? Path, bool Wildcard);

    public static readonly TimeSpan MinBackoff = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(5);

    private readonly object _gate = new();
    private readonly MqttClientFactory _factory = new();
    private readonly string _clientId;
    private IMqttClient? _client;
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private TaskCompletionSource _disconnected = NewTcs();
    private Dictionary<string, Sub> _subs = new(StringComparer.Ordinal);
    private Sub[] _wildcards = [];
    private List<string> _warnings = [];
    private ConnectionState _state = ConnectionState.Disabled;
    private string? _error;
    private int _bound;
    private long? _lastValueMs;
    private bool _stopped;
    private bool _disposed;

    public MqttTagSource(ConnectionDef definition)
    {
        Definition = definition;
        _clientId = string.IsNullOrWhiteSpace(definition.ClientId)
            ? $"twinlabs-{definition.Id}-{Guid.NewGuid():N}"[..Math.Min(64, 10 + definition.Id.Length + 33)]
            : definition.ClientId!;
    }

    public ConnectionDef Definition { get; }

    public ConnectionStatus Status
    {
        get
        {
            lock (_gate)
                return new(Definition.Id, ConnectionKind.Mqtt, Definition.Endpoint, _state, _bound, _lastValueMs, _error);
        }
    }

    /// <summary>Binding problems found at start (addresses with conflicting jsonPaths, bad jsonPaths).</summary>
    public IReadOnlyList<string> Warnings { get { lock (_gate) return _warnings.ToArray(); } }

    /// <summary>The topic filters this source subscribes to.</summary>
    public IReadOnlyCollection<string> Topics { get { lock (_gate) return _subs.Keys.ToArray(); } }

    public event Action<ConnectionStatus>? StatusChanged;
    public event Action<IReadOnlyList<TagUpdate>>? Updates;

    public Task StartAsync(IReadOnlyList<BindingDef> bindings, CancellationToken ct)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_loop is not null) return Task.CompletedTask; // already running
            BuildSubscriptions(bindings);
            _stopped = false;
            _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        }
        if (!MqttEndpoint.TryParse(Definition.Endpoint, out var ep, out var epError))
        {
            SetState(ConnectionState.Error, epError);
            return Task.CompletedTask;
        }
        var token = _cts!.Token;
        lock (_gate) _loop = Task.Run(() => RunAsync(ep, token), CancellationToken.None);
        return Task.CompletedTask;
    }

    private void BuildSubscriptions(IReadOnlyList<BindingDef> bindings)
    {
        var mine = bindings.Where(b => b.ConnectionId == Definition.Id && !string.IsNullOrWhiteSpace(b.Address)).ToList();
        var subs = new Dictionary<string, Sub>(StringComparer.Ordinal);
        var warnings = new List<string>();
        var bound = 0;
        foreach (var g in mine.GroupBy(b => b.Address, StringComparer.Ordinal))
        {
            var paths = g.Select(b => string.IsNullOrWhiteSpace(b.JsonPath) ? null : b.JsonPath.Trim()).Distinct().ToList();
            if (paths.Count > 1)
            {
                warnings.Add($"Topic '{g.Key}' ignored: its bindings use different jsonPaths ({string.Join(", ", paths.Select(p => p ?? "none"))}); bindings sharing a topic must share a jsonPath");
                continue;
            }
            string[]? parsed = null;
            if (paths[0] is { } p && (parsed = MqttPayload.ParsePath(p)) is null)
            {
                warnings.Add($"Topic '{g.Key}' ignored: unsupported jsonPath '{p}' (use $.a.b)");
                continue;
            }
            var wildcard = g.Key.Contains('+') || g.Key.Contains('#');
            subs[g.Key] = new Sub(g.Key, parsed, wildcard);
            bound += g.Count();
        }
        _subs = subs;
        _wildcards = subs.Values.Where(s => s.Wildcard).ToArray();
        _warnings = warnings;
        _bound = bound;
        _state = ConnectionState.Connecting;
        _error = WarningText();
    }

    private string? WarningText() => _warnings.Count == 0 ? null : string.Join("; ", _warnings);

    private async Task RunAsync(MqttEndpoint ep, CancellationToken ct)
    {
        var backoff = MinBackoff;
        while (!ct.IsCancellationRequested)
        {
            IMqttClient client;
            lock (_gate)
            {
                _client ??= CreateClient();
                client = _client;
                _disconnected = NewTcs();
            }
            SetState(ConnectionState.Connecting, null);
            try
            {
                var builder = new MqttClientOptionsBuilder()
                    .WithTcpServer(ep.Host, ep.Port)
                    .WithClientId(_clientId)
                    .WithCleanSession()
                    .WithKeepAlivePeriod(TimeSpan.FromSeconds(15))
                    .WithTimeout(ConnectTimeout);
                if (ep.Tls) builder = builder.WithTlsOptions(o => o.UseTls());
                using (var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    attempt.CancelAfter(ConnectTimeout);
                    await client.ConnectAsync(builder.Build(), attempt.Token).ConfigureAwait(false);
                    Sub[] subs;
                    lock (_gate) subs = _subs.Values.ToArray();
                    if (subs.Length > 0)
                    {
                        var sb = _factory.CreateSubscribeOptionsBuilder();
                        foreach (var s in subs) sb.WithTopicFilter(s.Filter, MqttQualityOfServiceLevel.AtMostOnce);
                        await client.SubscribeAsync(sb.Build(), attempt.Token).ConfigureAwait(false);
                    }
                }
                backoff = MinBackoff;
                SetState(ConnectionState.Connected, null);
                Task done;
                lock (_gate) done = _disconnected.Task;
                await done.WaitAsync(ct).ConfigureAwait(false);
                if (ct.IsCancellationRequested) break;
                SetState(ConnectionState.Error, "Disconnected from broker");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                SetState(ConnectionState.Error, Describe(ex));
                // A half-open client may refuse a new ConnectAsync; start the next attempt from a fresh one.
                IMqttClient? old;
                lock (_gate) { old = _client; _client = null; }
                DisposeClient(old);
            }
            try { await Task.Delay(backoff, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
            backoff = TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, backoff.Ticks * 2));
        }
    }

    private IMqttClient CreateClient()
    {
        var c = _factory.CreateMqttClient();
        c.ApplicationMessageReceivedAsync += e =>
        {
            OnMessage(e.ApplicationMessage.Topic, e.ApplicationMessage.Payload);
            return Task.CompletedTask;
        };
        c.DisconnectedAsync += _ =>
        {
            lock (_gate) _disconnected.TrySetResult();
            return Task.CompletedTask;
        };
        return c;
    }

    private void OnMessage(string topic, ReadOnlySequence<byte> payload)
    {
        List<Sub>? matches = null;
        lock (_gate)
        {
            if (_subs.TryGetValue(topic, out var exact)) (matches ??= []).Add(exact);
            foreach (var w in _wildcards)
                if (TopicMatches(w.Filter, topic)) (matches ??= []).Add(w);
        }
        if (matches is null) return;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var updates = new List<TagUpdate>(matches.Count);
        JsonDocument? doc = null;
        try
        {
            foreach (var m in matches)
            {
                double v;
                if (m.Path is null)
                {
                    if (!MqttPayload.TryParse(payload, null, out v)) continue;
                }
                else
                {
                    if (doc is null)
                    {
                        try
                        {
                            var reader = new Utf8JsonReader(payload);
                            doc = JsonDocument.ParseValue(ref reader);
                        }
                        catch (JsonException) { continue; }
                    }
                    if (!MqttPayload.TryEvaluate(doc.RootElement, m.Path, out v)) continue;
                }
                updates.Add(new TagUpdate(Definition.Id, m.Filter, v, now));
            }
        }
        finally
        {
            doc?.Dispose();
        }
        if (updates.Count == 0) return;
        lock (_gate) _lastValueMs = now;
        try { Updates?.Invoke(updates); } catch { /* subscriber bugs must not kill the MQTT client */ }
    }

    /// <summary>MQTT topic filter match (<c>+</c> = one level, <c>#</c> = this level and below).</summary>
    public static bool TopicMatches(string filter, string topic)
    {
        if (filter == topic) return true;
        var f = filter.Split('/');
        var t = topic.Split('/');
        for (var i = 0; i < f.Length; i++)
        {
            if (f[i] == "#") return i == f.Length - 1;
            if (i >= t.Length) return false;
            if (f[i] != "+" && f[i] != t[i]) return false;
        }
        return f.Length == t.Length;
    }

    private void SetState(ConnectionState state, string? error)
    {
        ConnectionStatus snapshot;
        lock (_gate)
        {
            if (_stopped && state != ConnectionState.Disabled) return;
            var combined = error ?? WarningText();
            if (error is not null && WarningText() is { } w) combined = $"{error}; {w}";
            if (_state == state && _error == combined) return;
            _state = state;
            _error = combined;
            snapshot = new(Definition.Id, ConnectionKind.Mqtt, Definition.Endpoint, _state, _bound, _lastValueMs, _error);
        }
        try { StatusChanged?.Invoke(snapshot); } catch { /* ignore subscriber errors */ }
    }

    private static string Describe(Exception ex)
    {
        var e = ex;
        while (e.InnerException is not null && (e is AggregateException || e.Message.Length == 0)) e = e.InnerException;
        return e is OperationCanceledException ? "Connection timed out" : $"{e.GetType().Name}: {e.Message}";
    }

    public async Task StopAsync()
    {
        CancellationTokenSource? cts;
        Task? loop;
        IMqttClient? client;
        lock (_gate)
        {
            if (_stopped || _loop is null && _cts is null) { _stopped = true; }
            cts = _cts; loop = _loop; client = _client;
            _cts = null; _loop = null; _client = null;
        }
        if (cts is not null) { try { cts.Cancel(); } catch (ObjectDisposedException) { } }
        if (loop is not null) { try { await loop.ConfigureAwait(false); } catch { /* loop never faults by design */ } }
        if (client is not null)
        {
            try
            {
                if (client.IsConnected)
                {
                    using var t = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await client.DisconnectAsync(new MqttClientDisconnectOptionsBuilder().Build(), t.Token).ConfigureAwait(false);
                }
            }
            catch { /* best effort */ }
            DisposeClient(client);
        }
        cts?.Dispose();
        SetState(ConnectionState.Disabled, null);
        lock (_gate) _stopped = true;
    }

    public async ValueTask DisposeAsync()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }
        await StopAsync().ConfigureAwait(false);
    }

    private static void DisposeClient(IMqttClient? c)
    {
        try { c?.Dispose(); } catch { /* ignore */ }
    }

    private static TaskCompletionSource NewTcs() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}
