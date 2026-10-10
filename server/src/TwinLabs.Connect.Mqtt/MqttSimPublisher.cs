using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using MQTTnet;
using MQTTnet.Protocol;
using MQTTnet.Server;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt;

/// <summary>
/// Publishes the simulated line to MQTT and optionally hosts an embedded MQTTnet broker.
/// <para>Config section <c>Twin:Mqtt</c>:</para>
/// <list type="bullet">
/// <item><c>Broker:Enabled</c> (false), <c>Broker:Port</c> (1883): run an embedded broker, started in <see cref="StartAsync"/>.</item>
/// <item><c>Publish:Enabled</c> (false), <c>Publish:Host</c> (localhost), <c>Publish:Port</c> (= broker port),
/// <c>Publish:Retain</c> (true), <c>Publish:ClientId</c> (generated): publish the twin's values.</item>
/// </list>
/// <para>
/// <b>Topic rule</b> (see <see cref="MqttTopics"/>): <c>&lt;lineId-lowercase&gt;/&lt;assetId&gt;/&lt;name-lowercase&gt;</c>, where
/// lineId is the plant id with a trailing <c>-connected</c> dropped, split on <c>-</c>/<c>_</c> and PascalCased
/// (<c>line-a</c> → <c>LineA</c>), then lowercased → <c>linea/CNC-01/temp</c>. Asset names: state, good, scrap, wip, load,
/// wear. Sensor names: the sensor id suffix mapped by the contract table (temp, vib, power, current, speed, level,
/// rejects, good), lowercased; the asset segment is the sensor's <see cref="SensorDef.AssetId"/>.
/// Payload <c>{"value":x,"t":simMs}</c>, QoS 0; state is an integer in enum order (off=0 … maintenance=6).
/// Every value is republished every sim second (so shadow mode never sees it as stale).
/// </para>
/// <see cref="Publish"/> never blocks: it drops the frame into a 1-slot channel (the newest frame replaces an unsent
/// one) that a background loop drains, connecting with backoff (1 s … 30 s) when the broker is unreachable.
/// </summary>
public sealed class MqttSimPublisher : ITwinPublisher
{
    private sealed record Frame(long SimTimeMs, AssetState[] Assets, SensorValue[] Sensors);

    private readonly ILogger _log;
    private readonly object _gate = new();
    private readonly string _clientId;
    private MqttServer? _server;
    private IMqttClient? _client;
    private Channel<Frame>? _channel;
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private volatile Dictionary<string, string> _sensorTopics = new(StringComparer.Ordinal);
    private volatile string _plantId = "";
    private long _published;
    private long _dropped;

    public MqttSimPublisher(IConfiguration config, ILogger<MqttSimPublisher>? logger = null)
    {
        ArgumentNullException.ThrowIfNull(config);
        _log = (ILogger?)logger ?? NullLogger.Instance;
        var s = config.GetSection("Twin:Mqtt");
        BrokerEnabled = s.GetValue("Broker:Enabled", false);
        BrokerPort = s.GetValue("Broker:Port", 1883);
        PublishEnabled = s.GetValue("Publish:Enabled", false);
        PublishHost = s.GetValue("Publish:Host", "localhost") ?? "localhost";
        PublishPort = s.GetValue("Publish:Port", BrokerPort);
        Retain = s.GetValue("Publish:Retain", true);
        var cid = s.GetValue<string?>("Publish:ClientId", null);
        _clientId = string.IsNullOrWhiteSpace(cid) ? $"twinlabs-pub-{Guid.NewGuid():N}"[..24] : cid;
    }

    public string Name => "mqtt";
    public bool Enabled => BrokerEnabled || PublishEnabled;

    public bool BrokerEnabled { get; }
    public int BrokerPort { get; }
    public bool PublishEnabled { get; }
    public string PublishHost { get; }
    public int PublishPort { get; }
    public bool Retain { get; }

    /// <summary>True while the embedded broker is running.</summary>
    public bool BrokerRunning => _server?.IsStarted ?? false;
    /// <summary>True while the publishing client is connected.</summary>
    public bool PublisherConnected => _client?.IsConnected ?? false;
    /// <summary>Messages published since start.</summary>
    public long PublishedMessages => Interlocked.Read(ref _published);
    /// <summary>Frames replaced before they were sent (broker slow or unreachable).</summary>
    public long DroppedFrames => Interlocked.Read(ref _dropped);

    /// <summary>Starts the broker and/or publishing loop. Calling it again (plant changed) only swaps the topic map.</summary>
    public async Task StartAsync(PlantModel plant, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(plant);
        _sensorTopics = plant.Sensors.ToDictionary(x => x.Id, x => MqttTopics.SensorTopic(plant.Id, x), StringComparer.Ordinal);
        _plantId = plant.Id;
        if (!Enabled) return;

        if (BrokerEnabled && _server is null)
        {
            var sf = new MqttServerFactory();
            var opts = sf.CreateServerOptionsBuilder().WithDefaultEndpoint().WithDefaultEndpointPort(BrokerPort).Build();
            var server = sf.CreateMqttServer(opts);
            try
            {
                await server.StartAsync().ConfigureAwait(false);
                _server = server;
                _log.LogInformation("Embedded MQTT broker listening on port {Port}", BrokerPort);
            }
            catch (Exception ex)
            {
                // Never take the host down because the port is taken; the publisher can still use another broker.
                _log.LogError(ex, "Embedded MQTT broker failed to start on port {Port}", BrokerPort);
                server.Dispose();
            }
        }

        lock (_gate)
        {
            if (!PublishEnabled || _loop is not null) return;
            _channel = Channel.CreateBounded<Frame>(new BoundedChannelOptions(1)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false,
            }, _ => Interlocked.Increment(ref _dropped));
            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            var reader = _channel.Reader;
            _loop = Task.Run(() => PublishLoopAsync(reader, token), CancellationToken.None);
        }
    }

    /// <summary>Non-blocking: queues the latest values; an unsent older frame is dropped.</summary>
    public void Publish(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors)
    {
        var ch = _channel;
        if (ch is null) return;
        ch.Writer.TryWrite(new Frame(simTimeMs, assets?.ToArray() ?? [], sensors?.ToArray() ?? []));
    }

    private async Task PublishLoopAsync(ChannelReader<Frame> reader, CancellationToken ct)
    {
        var factory = new MqttClientFactory();
        var client = factory.CreateMqttClient();
        _client = client;
        var backoff = MqttTagSource.MinBackoff;
        var nextAttempt = DateTime.MinValue;
        try
        {
            while (await reader.WaitToReadAsync(ct).ConfigureAwait(false))
            {
                if (!reader.TryRead(out var frame)) continue;
                if (!client.IsConnected)
                {
                    if (DateTime.UtcNow < nextAttempt) continue; // drop frames while backing off
                    try
                    {
                        var opts = new MqttClientOptionsBuilder()
                            .WithTcpServer(PublishHost, PublishPort)
                            .WithClientId(_clientId)
                            .WithCleanSession()
                            .WithTimeout(TimeSpan.FromSeconds(5))
                            .Build();
                        using var attempt = CancellationTokenSource.CreateLinkedTokenSource(ct);
                        attempt.CancelAfter(TimeSpan.FromSeconds(5));
                        await client.ConnectAsync(opts, attempt.Token).ConfigureAwait(false);
                        backoff = MqttTagSource.MinBackoff;
                        _log.LogInformation("MQTT publisher connected to {Host}:{Port}", PublishHost, PublishPort);
                    }
                    catch (Exception ex) when (!ct.IsCancellationRequested)
                    {
                        _log.LogDebug(ex, "MQTT publisher cannot reach {Host}:{Port}; retrying in {Backoff}", PublishHost, PublishPort, backoff);
                        nextAttempt = DateTime.UtcNow + backoff;
                        backoff = TimeSpan.FromTicks(Math.Min(MqttTagSource.MaxBackoff.Ticks, backoff.Ticks * 2));
                        client.Dispose();
                        client = factory.CreateMqttClient();
                        _client = client;
                        continue;
                    }
                }
                try
                {
                    foreach (var (topic, payload) in BuildMessages(frame))
                    {
                        var msg = new MqttApplicationMessageBuilder()
                            .WithTopic(topic)
                            .WithPayload(Encoding.UTF8.GetBytes(payload))
                            .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtMostOnce)
                            .WithRetainFlag(Retain)
                            .Build();
                        await client.PublishAsync(msg, ct).ConfigureAwait(false);
                        Interlocked.Increment(ref _published);
                    }
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    _log.LogWarning(ex, "MQTT publish failed; reconnecting");
                    nextAttempt = DateTime.UtcNow + backoff;
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (ChannelClosedException) { }
        finally
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
            client.Dispose();
            _client = null;
        }
    }

    /// <summary>The (topic, payload) pairs for one frame, per the topic rule in the class summary.</summary>
    public IEnumerable<(string Topic, string Payload)> BuildMessages(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors) =>
        BuildMessages(new Frame(simTimeMs, assets.ToArray(), sensors.ToArray()));

    private IEnumerable<(string, string)> BuildMessages(Frame f)
    {
        var plantId = _plantId;
        var sensorTopics = _sensorTopics;
        var t = f.SimTimeMs;
        foreach (var a in f.Assets)
        {
            yield return (MqttTopics.AssetTopic(plantId, a.Id, "state"), MqttTopics.Payload((long)a.State, t));
            yield return (MqttTopics.AssetTopic(plantId, a.Id, "good"), MqttTopics.Payload(a.Good, t));
            yield return (MqttTopics.AssetTopic(plantId, a.Id, "scrap"), MqttTopics.Payload(a.Scrap, t));
            yield return (MqttTopics.AssetTopic(plantId, a.Id, "wip"), MqttTopics.Payload((long)a.Wip, t));
            if (double.IsFinite(a.Load)) yield return (MqttTopics.AssetTopic(plantId, a.Id, "load"), MqttTopics.Payload(a.Load, t));
            if (double.IsFinite(a.Wear)) yield return (MqttTopics.AssetTopic(plantId, a.Id, "wear"), MqttTopics.Payload(a.Wear, t));
        }
        foreach (var s in f.Sensors)
        {
            if (!double.IsFinite(s.V)) continue;
            var topic = sensorTopics.TryGetValue(s.Id, out var tp) ? tp : MqttTopics.SensorTopic(plantId, s.Id);
            yield return (topic, MqttTopics.Payload(s.V, t));
        }
    }

    public async Task StopAsync()
    {
        Channel<Frame>? ch;
        CancellationTokenSource? cts;
        Task? loop;
        MqttServer? server;
        lock (_gate)
        {
            ch = _channel; cts = _cts; loop = _loop; server = _server;
            _channel = null; _cts = null; _loop = null; _server = null;
        }
        ch?.Writer.TryComplete();
        cts?.Cancel();
        if (loop is not null) { try { await loop.ConfigureAwait(false); } catch { /* never faults by design */ } }
        cts?.Dispose();
        if (server is not null)
        {
            try { await server.StopAsync().ConfigureAwait(false); } catch (Exception ex) { _log.LogWarning(ex, "Stopping MQTT broker"); }
            server.Dispose();
        }
    }
}
