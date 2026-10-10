using System.Diagnostics;
using TwinLabs.Core.Contracts;
using static TwinLabs.Connect.Mqtt.Tests.TestSupport;

namespace TwinLabs.Connect.Mqtt.Tests;

public class SampleLineMqttTests
{
    [Fact]
    public void Sample_line_mqtt_is_valid_and_matches_the_publisher_topic_rule()
    {
        var plain = LoadPlant("sample_line.json");
        var plant = LoadPlant("sample_line.mqtt.json");
        Assert.Empty(BindingResolver.Validate(plant));
        Assert.Equal(plain.Assets.Select(a => a.Id), plant.Assets.Select(a => a.Id));
        Assert.Equal(plain.Sensors.Select(s => s.Id), plant.Sensors.Select(s => s.Id));
        var conn = Assert.Single(plant.Connections!);
        Assert.Equal(ConnectionKind.Mqtt, conn.Kind);
        Assert.Equal("mqtt://localhost:1883", conn.Endpoint);
        Assert.Equal(plant.Assets.Count * 6 + plant.Sensors.Count, plant.Bindings!.Count);

        var expected = new Dictionary<string, string>();
        foreach (var a in plant.Assets)
            foreach (var f in MqttTopics.AssetNames) expected[$"asset:{a.Id}.{f}"] = MqttTopics.AssetTopic(plant.Id, a.Id, f);
        foreach (var s in plant.Sensors) expected[$"sensor:{s.Id}"] = MqttTopics.SensorTopic(plant.Id, s);
        Assert.All(plant.Bindings, b =>
        {
            Assert.Equal(conn.Id, b.ConnectionId);
            Assert.Equal("$.value", b.JsonPath);
            Assert.Equal(expected[b.Target], b.Address);
        });
        // The simulated plain line publishes under the same topics as the -connected plant.
        Assert.Equal(MqttTopics.LinePrefix(plain.Id), MqttTopics.LinePrefix(plant.Id));
        Assert.Equal("linea", MqttTopics.LinePrefix(plant.Id));
    }
}

public class EndToEndTests
{
    [Fact]
    public async Task Publisher_to_embedded_broker_to_source_resolves_every_binding()
    {
        const int port = 18831;
        var plant = LoadPlant("sample_line.mqtt.json");
        var conn = plant.Connections![0] with { Endpoint = $"mqtt://localhost:{port}", ClientId = null };
        plant = plant with { Connections = [conn] };
        var resolver = new BindingResolver(plant);

        var pub = new MqttSimPublisher(Config(
            ("Twin:Mqtt:Broker:Enabled", "true"), ("Twin:Mqtt:Broker:Port", port.ToString()),
            ("Twin:Mqtt:Publish:Enabled", "true")));
        await pub.StartAsync(plant, default);
        Assert.True(pub.BrokerRunning);

        await using var src = new MqttTagSourceFactory().Create(conn);
        var got = new Dictionary<(TargetKind, string), ResolvedUpdate>();
        src.Updates += list =>
        {
            lock (got) foreach (var u in list) foreach (var r in resolver.Resolve(u)) got[(r.Kind, r.Id)] = r;
        };
        await src.StartAsync(resolver.BindingsFor(conn.Id), default);
        Assert.Equal(plant.Bindings!.Count, src.Status.BoundTags);

        var states = Enum.GetValues<AssetStateKind>();
        var assets = plant.Assets.Select((a, i) => new AssetState(a.Id, states[i % states.Length], 0, 0.25 + i / 100.0, i / 10.0, i, 100 + i, i % 3, 0)).ToArray();
        var sensors = plant.Sensors.Select((s, i) => new SensorValue(s.Id, 10.5 + i)).ToArray();
        // The SNK-01 good sensor and asset counter share a topic, so their published values must agree.
        sensors = sensors.Select(s => s.Id == "SNK-01.good" ? s with { V = assets.Single(a => a.Id == "SNK-01").Good } : s).ToArray();

        var targets = plant.Assets.Count * 6 + plant.Sensors.Count;
        var ok = await WaitUntil(() =>
        {
            pub.Publish(1000, assets, sensors);
            lock (got) return got.Count == targets;
        }, TimeSpan.FromSeconds(15));
        Assert.True(ok, $"received {got.Count}/{targets} targets; source {src.Status.Status} {src.Status.Error}");
        Assert.Equal(ConnectionState.Connected, src.Status.Status);
        Assert.NotNull(src.Status.LastValueMs);

        for (var i = 0; i < assets.Length; i++)
        {
            var a = assets[i];
            Assert.Equal(a.State, got[(TargetKind.AssetState, a.Id)].State);
            Assert.Equal(a.Good, got[(TargetKind.AssetGood, a.Id)].Value);
            Assert.Equal(a.Scrap, got[(TargetKind.AssetScrap, a.Id)].Value);
            Assert.Equal(a.Wip, got[(TargetKind.AssetWip, a.Id)].Value);
            Assert.Equal(a.Load, got[(TargetKind.AssetLoad, a.Id)].Value);
            Assert.Equal(a.Wear, got[(TargetKind.AssetWear, a.Id)].Value);
        }
        foreach (var s in sensors) Assert.Equal(s.V, got[(TargetKind.Sensor, s.Id)].Value);

        await src.StopAsync();
        await pub.StopAsync();
        await pub.StopAsync();
        Assert.False(pub.BrokerRunning);
    }

    [Fact]
    public async Task Plain_numeric_payloads_and_wildcards()
    {
        const int port = 18832;
        var broker = await StartBroker(port);
        try
        {
            var conn = new ConnectionDef("b", ConnectionKind.Mqtt, $"tcp://localhost:{port}", ClientId: "plain-test");
            await using var src = new MqttTagSourceFactory().Create(conn);
            var c = new Collector(src);
            await src.StartAsync(
            [
                new("sensor:A.temp", "b", "plant/A/temp"),
                new("asset:A.state", "b", "plant/A/state"),
                new("asset:A.good", "b", "plant/+/count"),
            ], default);
            Assert.True(await WaitUntil(() => src.Status.Status == ConnectionState.Connected, TimeSpan.FromSeconds(10)));

            using var client = await Client(port);
            await Send(client, "plant/A/temp", "42.5");
            await Send(client, "plant/A/state", "true");
            await Send(client, "plant/A/temp", "1e2");
            await Send(client, "plant/Z/count", "17");
            Assert.True(await WaitUntil(() => c.All.Count >= 4, TimeSpan.FromSeconds(5)));
            Assert.Equal([42.5, 100.0], c.For("plant/A/temp").Select(u => u.Value));
            Assert.Equal(1.0, Assert.Single(c.For("plant/A/state")).Value);
            Assert.Equal(17.0, Assert.Single(c.For("plant/+/count")).Value);
            Assert.All(c.All, u => Assert.Equal("b", u.ConnectionId));
        }
        finally { await StopBroker(broker); }
    }

    [Fact]
    public async Task Bad_payloads_are_ignored()
    {
        const int port = 18833;
        var broker = await StartBroker(port);
        try
        {
            var conn = new ConnectionDef("b", ConnectionKind.Mqtt, $"mqtt://localhost:{port}");
            await using var src = new MqttTagSourceFactory().Create(conn);
            var c = new Collector(src);
            await src.StartAsync([new("sensor:A.temp", "b", "j/A/temp", "$.value"), new("sensor:A.vib", "b", "p/A/vib")], default);
            Assert.True(await WaitUntil(() => src.Status.Status == ConnectionState.Connected, TimeSpan.FromSeconds(10)));

            using var client = await Client(port);
            foreach (var bad in new[] { "{bad", "42", "{\"value\":\"x\"}", "{\"value\":null}", "{\"t\":1}", "", "[1,2]" })
                await Send(client, "j/A/temp", bad);
            foreach (var bad in new[] { "abc", "NaN", "{\"value\":1}", "1,5" })
                await Send(client, "p/A/vib", bad);
            await Send(client, "j/A/temp", "{\"value\":3.25,\"t\":9}");
            await Send(client, "p/A/vib", "0.75");

            Assert.True(await WaitUntil(() => c.All.Count >= 2, TimeSpan.FromSeconds(5)));
            await Task.Delay(200);
            Assert.Equal(3.25, Assert.Single(c.For("j/A/temp")).Value);
            Assert.Equal(0.75, Assert.Single(c.For("p/A/vib")).Value);
            Assert.Equal(ConnectionState.Connected, src.Status.Status);
        }
        finally { await StopBroker(broker); }
    }

    [Fact]
    public async Task Unreachable_broker_reports_error_then_connects_when_it_starts()
    {
        const int port = 18834;
        var conn = new ConnectionDef("b", ConnectionKind.Mqtt, $"mqtt://localhost:{port}");
        await using var src = new MqttTagSourceFactory().Create(conn);
        var c = new Collector(src);
        await src.StartAsync([new("sensor:A.temp", "b", "u/A/temp")], default); // must not throw
        Assert.True(await WaitUntil(() => src.Status.Status == ConnectionState.Error, TimeSpan.FromSeconds(10)));
        Assert.NotNull(src.Status.Error);
        Assert.Equal(1, src.Status.BoundTags);
        Assert.Contains(c.Statuses, s => s.Status == ConnectionState.Connecting);

        var broker = await StartBroker(port);
        try
        {
            Assert.True(await WaitUntil(() => src.Status.Status == ConnectionState.Connected, TimeSpan.FromSeconds(15)),
                $"status {src.Status.Status} {src.Status.Error}");
            Assert.Null(src.Status.Error);
            using var client = await Client(port);
            await Send(client, "u/A/temp", "5");
            Assert.True(await WaitUntil(() => !c.All.IsEmpty, TimeSpan.FromSeconds(5)));
            await src.StopAsync();
        }
        finally { await StopBroker(broker); }
    }

    [Fact]
    public async Task Reconnects_and_resubscribes_after_broker_restart()
    {
        const int port = 18835;
        var broker = await StartBroker(port);
        var conn = new ConnectionDef("b", ConnectionKind.Mqtt, $"mqtt://localhost:{port}");
        await using var src = new MqttTagSourceFactory().Create(conn);
        var c = new Collector(src);
        try
        {
            await src.StartAsync([new("sensor:A.temp", "b", "r/A/temp", "$.value")], default);
            Assert.True(await WaitUntil(() => src.Status.Status == ConnectionState.Connected, TimeSpan.FromSeconds(10)));

            await StopBroker(broker);
            Assert.True(await WaitUntil(() => src.Status.Status != ConnectionState.Connected, TimeSpan.FromSeconds(10)));

            broker = await StartBroker(port);
            Assert.True(await WaitUntil(() => src.Status.Status == ConnectionState.Connected, TimeSpan.FromSeconds(15)),
                $"status {src.Status.Status} {src.Status.Error}");
            using var client = await Client(port);
            await Send(client, "r/A/temp", "{\"value\":8}");
            Assert.True(await WaitUntil(() => !c.All.IsEmpty, TimeSpan.FromSeconds(5)));
            Assert.Equal(8.0, c.All.Single().Value);
            await src.StopAsync();
        }
        finally { await StopBroker(broker); }
    }

    [Fact]
    public async Task Publish_never_blocks_without_a_broker()
    {
        const int port = 18836;
        var plant = LoadPlant("sample_line.json");
        var pub = new MqttSimPublisher(Config(("Twin:Mqtt:Publish:Enabled", "true"), ("Twin:Mqtt:Publish:Port", port.ToString())));
        Assert.True(pub.Enabled);
        await pub.StartAsync(plant, default);
        var assets = plant.Assets.Select(a => new AssetState(a.Id, AssetStateKind.Running, 0, 0.5, 0.1, 1, 2, 0, 0)).ToArray();
        var sensors = plant.Sensors.Select(s => new SensorValue(s.Id, 1)).ToArray();

        var sw = Stopwatch.StartNew();
        for (var i = 0; i < 2000; i++) pub.Publish(i * 1000L, assets, sensors);
        sw.Stop();
        Assert.True(sw.ElapsedMilliseconds < 500, $"2000 Publish calls took {sw.ElapsedMilliseconds} ms");
        Assert.True(await WaitUntil(() => pub.DroppedFrames > 0, TimeSpan.FromSeconds(2)));
        Assert.Equal(0, pub.PublishedMessages);
        Assert.False(pub.PublisherConnected);

        var stop = Stopwatch.StartNew();
        await pub.StopAsync();
        Assert.True(stop.ElapsedMilliseconds < 8000);
        pub.Publish(0, assets, sensors); // after stop: no-op, no throw
    }

    [Fact]
    public async Task Publisher_to_external_broker_retains_values()
    {
        const int port = 18837;
        var broker = await StartBroker(port);
        try
        {
            var plant = LoadPlant("sample_line.json");
            var pub = new MqttSimPublisher(Config(("Twin:Mqtt:Publish:Enabled", "true"), ("Twin:Mqtt:Publish:Port", port.ToString())));
            await pub.StartAsync(plant, default);
            var assets = new[] { new AssetState("CNC-01", AssetStateKind.Blocked, 0, 0.5, 0.1, 1, 2, 0, 0) };
            Assert.True(await WaitUntil(() => { pub.Publish(4000, assets, []); return pub.PublishedMessages >= 6; }, TimeSpan.FromSeconds(10)));
            await pub.StopAsync();

            // Subscribed after the publisher left: retained value is still delivered.
            await using var src = new MqttTagSourceFactory().Create(new ConnectionDef("b", ConnectionKind.Mqtt, $"mqtt://localhost:{port}"));
            var c = new Collector(src);
            await src.StartAsync([new("asset:CNC-01.state", "b", "linea/CNC-01/state", "$.value")], default);
            Assert.True(await WaitUntil(() => !c.All.IsEmpty, TimeSpan.FromSeconds(10)));
            Assert.Equal((double)AssetStateKind.Blocked, c.All.First().Value);
        }
        finally { await StopBroker(broker); }
    }
}
