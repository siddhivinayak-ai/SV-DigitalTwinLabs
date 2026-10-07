using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using static TwinLabs.Simulation.Tests.TestPlant;

namespace TwinLabs.Simulation.Tests;

public class PlantFeatureTests
{
    // ------------------------------------------------------------------ pass-through

    private static PlantModel WithConnections(PlantModel p) => p with
    {
        Connections = [new ConnectionDef("plc", ConnectionKind.Opcua, "opc.tcp://plc:4840", 250, "twin")],
        Bindings = [new BindingDef("asset:CNC-A.state", "plc", "ns=2;s=CNC_A.State", null, 1, 0,
                                   new Dictionary<string, AssetStateKind> { ["1"] = AssetStateKind.Running })],
    };

    [Fact]
    public void V03_example_round_trips_through_the_engine()
    {
        var original = WithConnections(V03Example);
        var e = new SimulationEngine(original, original.Seed);
        e.Advance(TimeSpan.FromHours(1));

        Assert.Equal(TwinJson.Serialize(original), TwinJson.Serialize(e.Plant));
        var plant = e.Plant;
        Assert.Same(original.Connections, plant.Connections);
        Assert.Same(original.Bindings, plant.Bindings);
        Assert.Same(original.Lines, plant.Lines);
        Assert.Same(original.Resources, plant.Resources);
        Assert.Same(original.Calendar, plant.Calendar);
        var cnc = plant.Assets.Single(a => a.Id == "CNC-A");
        Assert.Equal(("line-a", "op-pool", "day", "/api/meshes/a41b7e/file"), (cnc.LineId, cnc.ResourceId, cnc.ShiftId, cnc.Mesh));
    }

    [Fact]
    public void New_fields_survive_UpdateParams()
    {
        var original = WithConnections(V03Example);
        var e = new SimulationEngine(original, 1);
        var def = e.UpdateParams("CNC-A", P(("cycleTimeS", 55)));
        Assert.Equal(("line-a", "op-pool", "day", "/api/meshes/a41b7e/file"), (def.LineId, def.ResourceId, def.ShiftId, def.Mesh));

        var expected = original with
        {
            Assets = original.Assets.Select(a => a.Id != "CNC-A" ? a : a with
            {
                Params = new Dictionary<string, double>(a.Params) { ["cycleTimeS"] = 55 },
            }).ToList(),
        };
        Assert.Equal(TwinJson.Serialize(expected), TwinJson.Serialize(e.Plant));
        Assert.Equal(40, original.Assets.Single(a => a.Id == "CNC-A").Params["cycleTimeS"]); // original untouched
    }

    [Fact]
    public void V03_example_runs_with_its_resource_and_day_shift()
    {
        var e = new SimulationEngine(V03Example, V03Example.Seed);
        e.Advance(TimeSpan.FromHours(10));
        var op = Assert.Single(e.GetResourceStats());
        Assert.Equal(("op-pool", 2), (op.ResourceId, op.Count));
        Assert.True(op.BusySeconds > 0);
        Assert.Equal(AssetStateKind.Off, e.State("CNC-A").State);  // 16:00, day shift ended at 14:00
        Assert.True(e.State("SNK").Good > 0);
        Assert.Contains(e.DrainEvents(), x => x.Message == "Shift 'Day shift' ended (1 asset)");
    }

    // ------------------------------------------------------------------ validation

    private static readonly ResourceDef Op = new("op", "Operators", ResourceKind.Operator, 1);

    private static PlantModel Line(string? machineResource = null, string? machineShift = null, string? machineLine = null,
                                   string? sourceResource = null, IReadOnlyList<ResourceDef>? resources = null,
                                   CalendarDef? calendar = null, IReadOnlyList<LineDef>? lines = null) =>
        Plant(
            [
                Asset("SRC", AssetKind.Source, ["M"], P(("arrivalIntervalS", 10)), resourceId: sourceResource),
                Asset("M", AssetKind.Machine, ["SNK"], P(("cycleTimeS", 5)), machineResource, machineShift, machineLine),
                Asset("SNK", AssetKind.Sink, []),
            ],
            resources, calendar, lines);

    private static CalendarDef Cal(double start, double end, double startHourOfDay = 6) =>
        new(startHourOfDay, [new ShiftDef("s", "S", start, end)]);

    public static TheoryData<string, PlantModel> InvalidPlants => new()
    {
        { "unknown resource", Line(machineResource: "nope", resources: [Op]) },
        { "resource without pools", Line(machineResource: "op") },
        { "resource on a source", Line(sourceResource: "op", resources: [Op]) },
        { "count 0", Line(machineResource: "op", resources: [Op with { Count = 0 }]) },
        { "count -1", Line(resources: [Op with { Count = -1 }]) },
        { "duplicate resource", Line(resources: [Op, Op]) },
        { "unknown shift", Line(machineShift: "nope", calendar: Cal(6, 14)) },
        { "shift without calendar", Line(machineShift: "s") },
        { "start = end", Line(machineShift: "s", calendar: Cal(8, 8)) },
        { "start < 0", Line(calendar: Cal(-1, 8)) },
        { "end > 24", Line(calendar: Cal(6, 25)) },
        { "NaN hour", Line(calendar: Cal(double.NaN, 8)) },
        { "startHourOfDay > 24", Line(calendar: Cal(6, 14, 30)) },
        { "duplicate shift", Line(calendar: new CalendarDef(6, [new ShiftDef("s", "A", 6, 14), new ShiftDef("s", "B", 14, 22)])) },
        { "unknown line", Line(machineLine: "nope", lines: [new LineDef("l1", "Line 1")]) },
        { "duplicate line", Line(lines: [new LineDef("l1", "A"), new LineDef("l1", "B")]) },
    };

    [Theory]
    [MemberData(nameof(InvalidPlants))]
    public void Constructor_rejects_invalid_v03_fields(string _, PlantModel plant) =>
        Assert.Throws<ArgumentException>(() => new SimulationEngine(plant, 1));

    [Fact]
    public void Valid_v03_fields_are_accepted()
    {
        _ = new SimulationEngine(Line(machineResource: "op", resources: [Op]), 1);
        _ = new SimulationEngine(Line(machineShift: "s", calendar: Cal(22, 6)), 1);       // wraps midnight
        _ = new SimulationEngine(Line(machineShift: "s", calendar: Cal(0, 24, 24)), 1);   // all day, 0..24 inclusive
        _ = new SimulationEngine(Line(machineLine: "l1", lines: [new LineDef("l1", "Line 1")]), 1);
        _ = new SimulationEngine(Line(machineLine: "free-label"), 1);                     // no lines declared: not checked
        foreach (var kind in new[] { AssetKind.Robot, AssetKind.Inspection })
            _ = new SimulationEngine(Plant(
                [
                    Asset("SRC", AssetKind.Source, ["M"], P(("arrivalIntervalS", 10))),
                    Asset("M", kind, ["SNK"], P(("cycleTimeS", 5)), resourceId: "op"),
                    Asset("SNK", AssetKind.Sink, []),
                ], [Op]), 1);
    }

    [Fact]
    public void All_day_shift_is_never_off()
    {
        var e = new SimulationEngine(Line(machineShift: "s", calendar: Cal(0, 24, 0)), 1);
        e.Advance(TimeSpan.FromHours(49));
        Assert.Equal(0, e.Stats("M").StateSeconds.Off);
        Assert.DoesNotContain(e.DrainEvents(), x => x.Message.StartsWith("Shift "));
    }
}
