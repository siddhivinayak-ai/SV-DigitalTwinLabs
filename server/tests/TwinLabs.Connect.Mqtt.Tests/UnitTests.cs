using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt.Tests;

public class TopicRuleTests
{
    [Theory]
    [InlineData("line-a", "LineA")]
    [InlineData("line-a-connected", "LineA")]
    [InlineData("my_plant-2", "MyPlant2")]
    [InlineData("line", "Line")]
    public void LineId_follows_contract(string plantId, string expected) => Assert.Equal(expected, MqttTopics.LineId(plantId));

    [Fact]
    public void Topics_are_lowercase_line_and_name_with_asset_id_verbatim()
    {
        Assert.Equal("linea/CNC-01/state", MqttTopics.AssetTopic("line-a-connected", "CNC-01", "state"));
        Assert.Equal("linea/CNC-01/temp", MqttTopics.SensorTopic("line-a", new SensorDef("CNC-01.temp", "CNC-01", SensorKind.Temperature, "C", 0)));
        Assert.Equal("linea/SNK-01/good", MqttTopics.SensorTopic("line-a", "SNK-01.good"));
        Assert.Equal("{\"value\":61.25,\"t\":5000}", MqttTopics.Payload(61.25, 5000));
        Assert.Equal("{\"value\":5,\"t\":0}", MqttTopics.Payload(5L, 0));
    }

    [Fact]
    public void Publisher_builds_one_message_per_asset_field_and_sensor()
    {
        var pub = new MqttSimPublisher(TestSupport.Config());
        Assert.False(pub.Enabled);
        var plant = TestSupport.LoadPlant("sample_line.json");
        pub.StartAsync(plant, default).GetAwaiter().GetResult();
        var assets = new[] { new AssetState("CNC-01", AssetStateKind.Fault, 0, 0.5, 0.1, 1, 7, 2, 0) };
        var sensors = new[] { new SensorValue("CNC-01.temp", 61.5), new SensorValue("CNC-01.vib", double.NaN) };
        var msgs = pub.BuildMessages(3000, assets, sensors).ToDictionary(m => m.Topic, m => m.Payload);
        Assert.Equal(7, msgs.Count); // 6 asset fields + temp (NaN vib skipped)
        Assert.Equal("{\"value\":5,\"t\":3000}", msgs["linea/CNC-01/state"]);
        Assert.Equal("{\"value\":7,\"t\":3000}", msgs["linea/CNC-01/good"]);
        Assert.Equal("{\"value\":61.5,\"t\":3000}", msgs["linea/CNC-01/temp"]);
    }
}

public class PayloadTests
{
    [Theory]
    [InlineData("42.5", null, 42.5)]
    [InlineData(" 7 ", null, 7)]
    [InlineData("-1e3", null, -1000)]
    [InlineData("true", null, 1)]
    [InlineData("false", null, 0)]
    [InlineData("{\"value\":3.5,\"t\":1}", "$.value", 3.5)]
    [InlineData("{\"a\":{\"b\":true}}", "$.a.b", 1)]
    [InlineData("{\"a\":{\"b\":\"12\"}}", "$.a.b", 12)]
    public void Accepts(string payload, string? path, double expected)
    {
        Assert.True(MqttPayload.TryParse(payload, path, out var v));
        Assert.Equal(expected, v);
    }

    [Theory]
    [InlineData("", null)]
    [InlineData("abc", null)]
    [InlineData("NaN", null)]
    [InlineData("Infinity", null)]
    [InlineData("{\"value\":1}", null)]
    [InlineData("{bad json", "$.value")]
    [InlineData("12", "$.value")]
    [InlineData("{\"value\":\"x\"}", "$.value")]
    [InlineData("{\"value\":null}", "$.value")]
    [InlineData("{\"value\":{\"a\":1}}", "$.value")]
    [InlineData("{\"other\":1}", "$.value")]
    [InlineData("{\"value\":1}", "value")]
    public void Rejects(string payload, string? path) => Assert.False(MqttPayload.TryParse(payload, path, out _));

    [Theory]
    [InlineData("mqtt://localhost:1883", "localhost", 1883, false)]
    [InlineData("tcp://10.0.0.5:1884", "10.0.0.5", 1884, false)]
    [InlineData("mqtt://broker", "broker", 1883, false)]
    [InlineData("mqtts://broker.example.com", "broker.example.com", 8883, true)]
    [InlineData("mqtts://broker:9999", "broker", 9999, true)]
    public void Endpoints(string ep, string host, int port, bool tls)
    {
        Assert.True(MqttEndpoint.TryParse(ep, out var r, out _));
        Assert.Equal(new MqttEndpoint(host, port, tls), r);
    }

    [Theory]
    [InlineData("http://x:1")]
    [InlineData("nonsense")]
    [InlineData("")]
    public void Bad_endpoints(string ep) => Assert.False(MqttEndpoint.TryParse(ep, out _, out _));

    [Theory]
    [InlineData("a/b/c", "a/b/c", true)]
    [InlineData("a/+/c", "a/b/c", true)]
    [InlineData("a/#", "a/b/c", true)]
    [InlineData("a/#", "a", true)]
    [InlineData("#", "a/b", true)]
    [InlineData("a/+", "a/b/c", false)]
    [InlineData("a/b", "a/c", false)]
    public void Topic_filters(string filter, string topic, bool match) => Assert.Equal(match, MqttTagSource.TopicMatches(filter, topic));
}

public class SourceConfigTests
{
    [Fact]
    public async Task Conflicting_jsonPaths_on_one_topic_are_reported_and_not_subscribed()
    {
        var conn = new ConnectionDef("b", ConnectionKind.Mqtt, "mqtt://localhost:18839");
        await using var src = (MqttTagSource)new MqttTagSourceFactory().Create(conn);
        await src.StartAsync(
        [
            new("sensor:A.temp", "b", "x/A/both", "$.temp"),
            new("sensor:A.vib", "b", "x/A/both", "$.vib"),
            new("sensor:A.power", "b", "x/A/power", "$.value"),
            new("asset:A.good", "b", "x/A/good"),
            new("asset:A.scrap", "other", "x/A/scrap"),
        ], default);
        Assert.Equal(["x/A/good", "x/A/power"], src.Topics.Order());
        Assert.Single(src.Warnings);
        Assert.Contains("x/A/both", src.Status.Error);
        Assert.Equal(2, src.Status.BoundTags);
        await src.StopAsync();
        await src.StopAsync();
        Assert.Equal(ConnectionState.Disabled, src.Status.Status);
    }

    [Fact]
    public async Task Bad_endpoint_reports_error_without_throwing()
    {
        await using var src = new MqttTagSourceFactory().Create(new ConnectionDef("b", ConnectionKind.Mqtt, "http://nope"));
        await src.StartAsync([new("asset:A.good", "b", "t")], default);
        Assert.Equal(ConnectionState.Error, src.Status.Status);
        Assert.NotNull(src.Status.Error);
    }

    [Fact]
    public void Factory_rejects_other_kinds() =>
        Assert.Throws<ArgumentException>(() => new MqttTagSourceFactory().Create(new ConnectionDef("p", ConnectionKind.Opcua, "opc.tcp://x")));

    [Fact]
    public void Config_defaults()
    {
        var p = new MqttSimPublisher(TestSupport.Config(("Twin:Mqtt:Broker:Enabled", "true"), ("Twin:Mqtt:Broker:Port", "1999")));
        Assert.True(p.Enabled);
        Assert.False(p.PublishEnabled);
        Assert.Equal(1999, p.PublishPort);
        Assert.Equal("localhost", p.PublishHost);
        Assert.True(p.Retain);
        Assert.Equal("mqtt", p.Name);
    }
}
