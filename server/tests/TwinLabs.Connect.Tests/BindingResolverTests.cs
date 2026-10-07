using TwinLabs.Connect;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Tests;

public class BindingResolverTests
{
    private static string ContractsDir
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts"))) dir = dir.Parent;
            return Path.Combine(dir?.FullName ?? throw new DirectoryNotFoundException("contracts/"), "contracts");
        }
    }

    private static PlantModel Connected() => TwinJson.LoadPlant(Path.Combine(ContractsDir, "plant", "sample_line.connected.json"));

    [Fact]
    public void Connected_sample_is_valid() => Assert.Empty(BindingResolver.Validate(Connected()));

    [Fact]
    public void Plant_without_connections_is_valid() =>
        Assert.Empty(BindingResolver.Validate(TwinJson.LoadPlant(Path.Combine(ContractsDir, "plant", "sample_line.json"))));

    [Theory]
    [InlineData("sensor:CNC-01.temp", TargetKind.Sensor, "CNC-01.temp")]
    [InlineData("asset:CNC-01.state", TargetKind.AssetState, "CNC-01")]
    [InlineData("asset:SNK-01.good", TargetKind.AssetGood, "SNK-01")]
    [InlineData("asset:A.B-1.wear", TargetKind.AssetWear, "A.B-1")]
    public void Parses_targets(string target, TargetKind kind, string id)
    {
        Assert.True(BindingResolver.TryParseTarget(target, out var k, out var i));
        Assert.Equal(kind, k);
        Assert.Equal(id, i);
    }

    [Theory]
    [InlineData("")]
    [InlineData("sensor:")]
    [InlineData("asset:CNC-01")]
    [InlineData("asset:CNC-01.colour")]
    [InlineData("tag:CNC-01.temp")]
    public void Rejects_bad_targets(string target) => Assert.False(BindingResolver.TryParseTarget(target, out _, out _));

    [Fact]
    public void Resolves_state_with_default_enum_order()
    {
        var r = new BindingResolver(Connected());
        var res = r.Resolve(new TagUpdate("plc1", "ns=2;s=LineA.CNC-01.State", 5, 123));
        var u = Assert.Single(res);
        Assert.Equal(TargetKind.AssetState, u.Kind);
        Assert.Equal("CNC-01", u.Id);
        Assert.Equal(AssetStateKind.Fault, u.State);
        Assert.Equal(123, u.WallTimeMs);
        Assert.Empty(r.Resolve(new TagUpdate("plc1", "ns=2;s=LineA.CNC-01.State", 9, 1))); // out of range
    }

    [Fact]
    public void Same_address_can_feed_two_targets()
    {
        var r = new BindingResolver(Connected());
        var res = r.Resolve(new TagUpdate("plc1", "ns=2;s=LineA.SNK-01.Good", 42, 1));
        Assert.Equal(2, res.Count);
        Assert.Contains(res, x => x.Kind == TargetKind.Sensor && x.Id == "SNK-01.good" && x.Value == 42);
        Assert.Contains(res, x => x.Kind == TargetKind.AssetGood && x.Id == "SNK-01" && x.Value == 42);
    }

    [Fact]
    public void Applies_scale_offset_and_custom_state_map()
    {
        var plant = Connected() with
        {
            Bindings =
            [
                new("sensor:CNC-01.temp", "plc1", "t", Scale: 0.1, Offset: -40),
                new("asset:CNC-01.state", "plc1", "s", StateMap: new Dictionary<string, AssetStateKind> { ["10"] = AssetStateKind.Running, ["20"] = AssetStateKind.Fault }),
            ],
        };
        var r = new BindingResolver(plant);
        Assert.Equal(60.0, Assert.Single(r.Resolve(new TagUpdate("plc1", "t", 1000, 1))).Value, 9);
        Assert.Equal(AssetStateKind.Fault, Assert.Single(r.Resolve(new TagUpdate("plc1", "s", 20.2, 1))).State);
        Assert.Empty(r.Resolve(new TagUpdate("plc1", "s", 3, 1))); // not in custom map
        Assert.Empty(r.Resolve(new TagUpdate("plc1", "unknown", 3, 1)));
        Assert.Empty(r.Resolve(new TagUpdate("other", "t", 3, 1)));
        Assert.Empty(r.Resolve(new TagUpdate("plc1", "t", double.NaN, 1)));
    }

    [Fact]
    public void Validate_reports_every_kind_of_problem()
    {
        var plant = Connected() with
        {
            Connections = [new("plc1", ConnectionKind.Opcua, "opc.tcp://x"), new("plc1", ConnectionKind.Mqtt, "")],
            Bindings =
            [
                new("sensor:NOPE.temp", "plc1", "a"),
                new("asset:NOPE.state", "plc1", "b"),
                new("sensor:CNC-01.temp", "ghost", "c"),
                new("sensor:CNC-01.temp", "plc1", "d"),           // duplicate target
                new("junk", "plc1", "e"),
                new("sensor:CNC-01.vib", "plc1", "f", JsonPath: "$.v"), // jsonPath on OPC UA
                new("sensor:CNC-01.power", "plc1", "g", StateMap: new Dictionary<string, AssetStateKind>()),
                new("sensor:CNC-02.temp", "plc1", ""),
            ],
        };
        var errs = BindingResolver.Validate(plant);
        Assert.Contains(errs, e => e.Contains("Duplicate connection"));
        Assert.Contains(errs, e => e.Contains("no endpoint"));
        Assert.Contains(errs, e => e.Contains("'sensor:NOPE.temp'") && e.Contains("does not exist"));
        Assert.Contains(errs, e => e.Contains("'asset:NOPE.state'"));
        Assert.Contains(errs, e => e.Contains("unknown connection 'ghost'"));
        Assert.Contains(errs, e => e.Contains("more than once"));
        Assert.Contains(errs, e => e.Contains("Bad binding target 'junk'"));
        Assert.Contains(errs, e => e.Contains("jsonPath"));
        Assert.Contains(errs, e => e.Contains("stateMap"));
        Assert.Contains(errs, e => e.Contains("no address"));
    }

    [Fact]
    public void Mqtt_jsonpath_subset()
    {
        var ok = Connected() with
        {
            Connections = [new("m", ConnectionKind.Mqtt, "mqtt://localhost")],
            Bindings = [new("sensor:CNC-01.vib", "m", "t/v", JsonPath: "$.a.b")],
        };
        Assert.Empty(BindingResolver.Validate(ok));
        var bad = ok with { Bindings = [new("sensor:CNC-01.vib", "m", "t/v", JsonPath: "$..a[0]")] };
        Assert.Single(BindingResolver.Validate(bad));
    }

    [Fact]
    public void BindingsFor_groups_by_connection()
    {
        var r = new BindingResolver(Connected());
        Assert.Equal(98, r.BindingsFor("plc1").Count);
        Assert.Empty(r.BindingsFor("none"));
        Assert.Equal(98, r.BindingCount);
    }
}
