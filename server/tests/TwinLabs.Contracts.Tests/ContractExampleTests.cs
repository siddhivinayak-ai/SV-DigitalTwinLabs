using System.Text.Json;
using System.Text.Json.Nodes;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Contracts.Tests;

/// <summary>
/// Every file in contracts/examples must deserialize into the C# DTOs and serialize back to the
/// same JSON. If this fails, the C# contract and the documented wire format have drifted.
/// </summary>
public class ContractExampleTests
{
    private static string ContractsDir
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts")))
                dir = dir.Parent;
            return Path.Combine(dir?.FullName ?? throw new DirectoryNotFoundException("contracts/"), "contracts");
        }
    }

    public static TheoryData<string, Type> Examples => new()
    {
        { "snapshot.json", typeof(Envelope<SnapshotData>) },
        { "tick.json", typeof(Envelope<TickData>) },
        { "event.json", typeof(Envelope<EventRecord>) },
        { "alarm.json", typeof(Envelope<Alarm>) },
        { "kpi.json", typeof(Envelope<KpiReport>) },
        { "params.json", typeof(Envelope<ParamsData>) },
        { "ack.json", typeof(Envelope<AckData>) },
        { "command.sim.speed.json", typeof(Envelope<CommandData>) },
        { "command.asset.fault.json", typeof(Envelope<CommandData>) },
        { "command.asset.params.json", typeof(Envelope<CommandData>) },
        { "whatif.request.json", typeof(WhatIfRequest) },
        { "whatif.result.json", typeof(WhatIfResult) },
        { "history.json", typeof(HistorySeries) },
        // v0.2
        { "connection.json", typeof(Envelope<ConnectionStatus>) },
        { "command.twin.mode.json", typeof(Envelope<CommandData>) },
        { "alarm.deviation.json", typeof(Envelope<Alarm>) },
        { "scenario.json", typeof(Scenario) },
        // v0.3
        { "validation.json", typeof(ValidationResult) },
        { "mesh.json", typeof(MeshInfo) },
        { "layout.json", typeof(Layout) },
        { "template.info.json", typeof(TemplateInfo) },
        { "kpi.v03.json", typeof(Envelope<KpiReport>) },
        { "plant.v03.json", typeof(PlantModel) },
    };

    [Theory]
    [MemberData(nameof(Examples))]
    public void Example_round_trips(string file, Type type)
    {
        var json = File.ReadAllText(Path.Combine(ContractsDir, "examples", file));
        var obj = JsonSerializer.Deserialize(json, type, TwinJson.Options);
        Assert.NotNull(obj);

        var back = JsonSerializer.Serialize(obj, type, TwinJson.Options);
        var expected = JsonNode.Parse(json);
        var actual = JsonNode.Parse(back);
        Assert.True(JsonNode.DeepEquals(expected, actual),
            $"{file} did not round-trip.\nExpected:\n{expected}\nActual:\n{actual}");
    }

    [Fact]
    public void Every_example_file_is_covered()
    {
        var covered = Examples.Select(row => (string)row[0]).ToHashSet();
        var files = Directory.GetFiles(Path.Combine(ContractsDir, "examples"), "*.json").Select(Path.GetFileName);
        Assert.All(files, f => Assert.Contains(f!, covered));
    }

    [Fact]
    public void Sample_line_loads_and_is_consistent()
    {
        var plant = TwinJson.LoadPlant(Path.Combine(ContractsDir, "plant", "sample_line.json"));
        Assert.Equal("line-a", plant.Id);
        Assert.Equal(11, plant.Assets.Count);

        var ids = plant.Assets.Select(a => a.Id).ToHashSet();
        Assert.Equal(plant.Assets.Count, ids.Count);
        Assert.All(plant.Assets.SelectMany(a => a.Downstream), d => Assert.Contains(d, ids));
        Assert.All(plant.Sensors, s => Assert.Contains(s.AssetId, ids));
        Assert.Single(plant.Assets, a => a.Kind == AssetKind.Source);
        Assert.Single(plant.Assets, a => a.Kind == AssetKind.Sink);
        Assert.Equal(plant.Sensors.Count, plant.Sensors.Select(s => s.Id).Distinct().Count());
    }

    [Fact]
    public void Connected_sample_extends_sample_line()
    {
        var plain = TwinJson.LoadPlant(Path.Combine(ContractsDir, "plant", "sample_line.json"));
        var plant = TwinJson.LoadPlant(Path.Combine(ContractsDir, "plant", "sample_line.connected.json"));
        Assert.Equal(plain.Assets.Count, plant.Assets.Count);
        Assert.Equal(plain.Sensors.Count, plant.Sensors.Count);
        var conn = Assert.Single(plant.Connections!);
        Assert.Equal(ConnectionKind.Opcua, conn.Kind);
        Assert.Equal(plant.Assets.Count * 6 + plant.Sensors.Count, plant.Bindings!.Count);
        Assert.All(plant.Bindings, b => Assert.Equal(conn.Id, b.ConnectionId));
    }

    [Fact]
    public void V03_plant_example_uses_all_new_fields()
    {
        var plant = TwinJson.LoadPlant(Path.Combine(ContractsDir, "examples", "plant.v03.json"));
        Assert.Equal(2, plant.Lines!.Count);
        Assert.Equal(2, plant.Resources![0].Count);
        Assert.Equal(2, plant.Calendar!.Shifts.Count);
        var mill = plant.Assets.Single(a => a.Id == "CNC-A");
        Assert.Equal("op-pool", mill.ResourceId);
        Assert.Equal("day", mill.ShiftId);
        Assert.Equal("/api/meshes/a41b7e/file", mill.Mesh);
        Assert.Equal("line-a", mill.LineId);
    }

    [Fact]
    public void Simulate_mode_is_default_and_serialized()
    {
        var json = TwinJson.Serialize(new SimStatus(SimRunState.Stopped, 1, 0, 0, 7));
        Assert.Contains("\"mode\":\"simulate\"", json);
    }
}
