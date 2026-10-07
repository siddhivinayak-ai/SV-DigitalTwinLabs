using System.Collections.Concurrent;
using System.Diagnostics;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using Xunit.Abstractions;

namespace TwinLabs.Connect.OpcUa.Tests;

/// <summary>Records everything a source raises and lets tests wait for conditions.</summary>
internal sealed class Recorder
{
    public readonly ConcurrentQueue<TagUpdate> Updates = new();
    public readonly ConcurrentQueue<ConnectionStatus> Statuses = new();
    public int Batches;

    public Recorder(ITagSource source)
    {
        source.Updates += batch =>
        {
            Interlocked.Increment(ref Batches);
            foreach (var u in batch) Updates.Enqueue(u);
        };
        source.StatusChanged += s => Statuses.Enqueue(s);
    }

    public bool HasValue(string address, double value) => Updates.Any(u => u.Address == address && u.Value == value);
}

// One class so tests run sequentially (they share the PKI folders and the machine's port range).
public sealed class OpcUaTagSourceTests(ITestOutputHelper output)
{
    private const string Temp = "ns=2;s=LineA.CNC-01.Temp";
    private const string State = "ns=2;s=LineA.CNC-01.State";
    private const string SinkGood = "ns=2;s=LineA.SNK-01.Good";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private static OpcUaTagSourceFactory Factory() => new(new OpcUaClientOptions
    {
        PkiRoot = Path.Combine(Path.GetTempPath(), "TwinLabs", "opcua-test-client-pki"),
        MinReconnectDelay = TimeSpan.FromMilliseconds(200),
        MaxReconnectDelay = TimeSpan.FromSeconds(1),
        KeepAliveIntervalMs = 300,
        OperationTimeoutMs = 2000,
        SessionTimeoutMs = 10000,
    });

    private static ConnectionDef Conn(int port) =>
        new("plc1", ConnectionKind.Opcua, $"opc.tcp://localhost:{port}/twinlabs", PublishingIntervalMs: 50);

    private static PlantModel Plant(ConnectionDef conn, params BindingDef[] bindings) =>
        new("line-a-connected", "test", 1, 1, [], [], [conn], bindings);

    private static async Task WaitUntil(Func<bool> condition, string what, TimeSpan? timeout = null)
    {
        var sw = Stopwatch.StartNew();
        while (!condition())
        {
            if (sw.Elapsed > (timeout ?? Timeout)) throw new TimeoutException($"Timed out waiting for {what}");
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task Values_flow_as_tag_updates_and_resolve()
    {
        await using var server = await TestOpcUaServer.StartAsync(48411);
        var conn = Conn(48411);
        var plant = Plant(conn,
            new BindingDef("sensor:CNC-01.temp", "plc1", Temp),
            new BindingDef("asset:CNC-01.state", "plc1", State));
        var resolver = new BindingResolver(plant);

        await using var source = Factory().Create(conn);
        var rec = new Recorder(source);
        var sw = Stopwatch.StartNew();
        await source.StartAsync(resolver.BindingsFor("plc1"), CancellationToken.None);

        await WaitUntil(() => source.Status.Status == ConnectionState.Connected, "connected");
        output.WriteLine($"connected after {sw.ElapsedMilliseconds} ms");
        await WaitUntil(() => rec.HasValue(Temp, 61.5) && rec.HasValue(State, 2), "initial values");
        output.WriteLine($"first values after {sw.ElapsedMilliseconds} ms");

        Assert.Equal(2, source.Status.BoundTags);
        Assert.Null(source.Status.Error);
        Assert.NotNull(source.Status.LastValueMs);
        Assert.Contains(rec.Statuses, s => s.Status == ConnectionState.Connecting);

        server.SetValue("LineA.CNC-01.Temp", 70.25);
        server.SetValue("LineA.CNC-01.State", 3);
        await WaitUntil(() => rec.HasValue(Temp, 70.25) && rec.HasValue(State, 3), "changed values");

        var temp = rec.Updates.Last(u => u.Address == Temp);
        Assert.Equal("plc1", temp.ConnectionId);
        Assert.InRange(temp.WallTimeMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 10_000, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var r = Assert.Single(resolver.Resolve(temp));
        Assert.Equal(TargetKind.Sensor, r.Kind);
        Assert.Equal("CNC-01.temp", r.Id);
        Assert.Equal(70.25, r.Value);

        var st = Assert.Single(resolver.Resolve(rec.Updates.Last(u => u.Address == State)));
        Assert.Equal(TargetKind.AssetState, st.Kind);
        Assert.Equal("CNC-01", st.Id);
        Assert.Equal((AssetStateKind)3, st.State);
    }

    [Fact]
    public async Task Shared_address_uses_one_monitored_item_and_feeds_both_targets()
    {
        await using var server = await TestOpcUaServer.StartAsync(48412);
        var conn = Conn(48412);
        var plant = Plant(conn,
            new BindingDef("sensor:SNK-01.good", "plc1", SinkGood),
            new BindingDef("asset:SNK-01.good", "plc1", SinkGood, Scale: 2));
        var resolver = new BindingResolver(plant);

        await using var source = (OpcUaTagSource)Factory().Create(conn);
        var rec = new Recorder(source);
        await source.StartAsync(resolver.BindingsFor("plc1"), CancellationToken.None);
        await WaitUntil(() => source.Status.Status == ConnectionState.Connected, "connected");

        Assert.Equal(2, source.Status.BoundTags);
        Assert.Equal(1, source.MonitoredItemCount);

        server.SetValue("LineA.SNK-01.Good", 5.0);
        await WaitUntil(() => rec.HasValue(SinkGood, 5.0), "value 5");
        var update = rec.Updates.Last(u => u.Address == SinkGood);
        var resolved = resolver.Resolve(update);
        Assert.Equal(2, resolved.Count);
        Assert.Contains(resolved, x => x is { Kind: TargetKind.Sensor, Id: "SNK-01.good", Value: 5.0 });
        Assert.Contains(resolved, x => x is { Kind: TargetKind.AssetGood, Id: "SNK-01", Value: 10.0 });
    }

    [Fact]
    public async Task Unreachable_endpoint_reports_error_without_throwing_then_connects_when_server_starts()
    {
        var conn = Conn(48413);
        await using var source = Factory().Create(conn);
        var rec = new Recorder(source);

        var sw = Stopwatch.StartNew();
        await source.StartAsync([new BindingDef("sensor:CNC-01.temp", "plc1", Temp)], CancellationToken.None);
        Assert.True(sw.ElapsedMilliseconds < 2000, $"StartAsync took {sw.ElapsedMilliseconds} ms");

        await WaitUntil(() => source.Status.Status == ConnectionState.Error, "error status");
        output.WriteLine($"error status after {sw.ElapsedMilliseconds} ms: {source.Status.Error}");
        Assert.False(string.IsNullOrWhiteSpace(source.Status.Error));
        Assert.Equal(1, source.Status.BoundTags);
        // Keeps retrying: Connecting -> Error -> Connecting ...
        await WaitUntil(() => rec.Statuses.Count(s => s.Status == ConnectionState.Connecting) >= 2, "a retry");

        await using var server = await TestOpcUaServer.StartAsync(48413);
        sw.Restart();
        await WaitUntil(() => source.Status.Status == ConnectionState.Connected, "connected after server start");
        output.WriteLine($"connected {sw.ElapsedMilliseconds} ms after the server started");
        Assert.Null(source.Status.Error);
        await WaitUntil(() => rec.HasValue(Temp, 61.5), "initial value");
    }

    [Fact]
    public async Task Server_restart_reconnects_and_values_resume()
    {
        var conn = Conn(48414);
        var server = await TestOpcUaServer.StartAsync(48414);
        await using var source = Factory().Create(conn);
        var rec = new Recorder(source);
        try
        {
            await source.StartAsync([new BindingDef("sensor:CNC-01.temp", "plc1", Temp)], CancellationToken.None);
            await WaitUntil(() => rec.HasValue(Temp, 61.5), "initial value");

            var sw = Stopwatch.StartNew();
            await server.DisposeAsync();
            await WaitUntil(() => source.Status.Status != ConnectionState.Connected, "connection loss detected");
            output.WriteLine($"loss detected {sw.ElapsedMilliseconds} ms after server stop: {source.Status.Status} {source.Status.Error}");

            server = await TestOpcUaServer.StartAsync(48414, new Dictionary<string, object>(TestOpcUaServer.DefaultNodes())
            {
                ["LineA.CNC-01.Temp"] = 99.0,
            });
            sw.Restart();
            await WaitUntil(() => rec.HasValue(Temp, 99.0), "value from restarted server", TimeSpan.FromSeconds(20));
            output.WriteLine($"values resumed {sw.ElapsedMilliseconds} ms after server restart");
            await WaitUntil(() => source.Status.Status == ConnectionState.Connected, "connected");

            server.SetValue("LineA.CNC-01.Temp", 100.5);
            await WaitUntil(() => rec.HasValue(Temp, 100.5), "live value after restart");
        }
        finally
        {
            await source.StopAsync();
            await server.DisposeAsync();
        }
    }

    [Fact]
    public async Task Stop_and_dispose_are_idempotent_and_stop_updates()
    {
        await using var server = await TestOpcUaServer.StartAsync(48415);
        var conn = Conn(48415);
        var source = Factory().Create(conn);
        var rec = new Recorder(source);

        await source.StopAsync(); // before start: no-op
        await source.StartAsync([new BindingDef("sensor:CNC-01.temp", "plc1", Temp)], CancellationToken.None);
        await WaitUntil(() => rec.HasValue(Temp, 61.5), "initial value");

        await Task.WhenAll(source.StopAsync(), source.StopAsync(), source.DisposeAsync().AsTask());
        await source.StopAsync();
        await source.DisposeAsync();
        Assert.Equal(ConnectionState.Disabled, source.Status.Status);
        Assert.Single(rec.Statuses, s => s.Status == ConnectionState.Disabled);

        var count = rec.Updates.Count;
        server.SetValue("LineA.CNC-01.Temp", 1.0);
        await Task.Delay(300);
        Assert.Equal(count, rec.Updates.Count);
        await Assert.ThrowsAsync<ObjectDisposedException>(() => source.StartAsync([], CancellationToken.None));
    }

    [Fact]
    public async Task Invalid_node_ids_are_summarised_while_staying_connected()
    {
        await using var server = await TestOpcUaServer.StartAsync(48416);
        var conn = Conn(48416);
        await using var source = Factory().Create(conn);
        var rec = new Recorder(source);
        await source.StartAsync(
        [
            new BindingDef("sensor:CNC-01.temp", "plc1", Temp),
            new BindingDef("sensor:CNC-01.vib", "plc1", "ns=2;s=LineA.CNC-01.Missing"),
            new BindingDef("sensor:CNC-01.power", "plc1", "not a node id"),
        ], CancellationToken.None);

        await WaitUntil(() => source.Status.Status == ConnectionState.Connected, "connected");
        output.WriteLine(source.Status.Error);
        Assert.StartsWith("2 of 3 node ids invalid:", source.Status.Error);
        Assert.Contains("LineA.CNC-01.Missing", source.Status.Error);
        Assert.Contains("not a node id", source.Status.Error);
        await WaitUntil(() => rec.HasValue(Temp, 61.5), "value for the valid node");

        // Bad-status values are skipped.
        var count = rec.Updates.Count;
        server.SetBad("LineA.CNC-01.Temp");
        await Task.Delay(300);
        Assert.Equal(count, rec.Updates.Count);
        server.SetValue("LineA.CNC-01.Temp", 12.0);
        await WaitUntil(() => rec.HasValue(Temp, 12.0), "good value after bad");
    }

    [Theory]
    [InlineData(1.5, 1.5)]
    [InlineData(3.25f, 3.25)]
    [InlineData(42, 42.0)]
    [InlineData((byte)7, 7.0)]
    [InlineData((ushort)9, 9.0)]
    [InlineData(10L, 10.0)]
    [InlineData(11UL, 11.0)]
    [InlineData(true, 1.0)]
    [InlineData(false, 0.0)]
    [InlineData("12.5", 12.5)]
    [InlineData(" -3 ", -3.0)]
    [InlineData(AssetStateKind.Fault, (double)(int)AssetStateKind.Fault)]
    public void Converts_supported_values(object raw, double expected)
    {
        Assert.True(OpcUaTagSource.TryConvert(raw, out var v));
        Assert.Equal(expected, v);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("abc")]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void Skips_unsupported_values(object? raw) => Assert.False(OpcUaTagSource.TryConvert(raw, out _));

    [Fact]
    public void Skips_non_scalar_values()
    {
        Assert.False(OpcUaTagSource.TryConvert(new[] { 1.0, 2.0 }, out _));
        Assert.False(OpcUaTagSource.TryConvert(DateTime.UtcNow, out _));
        Assert.True(OpcUaTagSource.TryConvert(new Opc.Ua.Variant(5), out var v));
        Assert.Equal(5.0, v);
    }

    [Fact]
    public void Factory_creates_opcua_sources_only()
    {
        var factory = new OpcUaTagSourceFactory();
        Assert.Equal(ConnectionKind.Opcua, factory.Kind);
        var src = factory.Create(Conn(48419));
        Assert.Equal(ConnectionState.Disabled, src.Status.Status);
        Assert.Equal("plc1", src.Status.Id);
        Assert.Throws<ArgumentException>(() => factory.Create(new ConnectionDef("m", ConnectionKind.Mqtt, "mqtt://x")));
    }
}
