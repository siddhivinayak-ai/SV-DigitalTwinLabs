using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Simulation;

namespace TwinLabs.Simulation.Tests;

internal static class TestPlant
{
    private static readonly Lazy<PlantModel> s_sample = new(() =>
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "contracts", "plant", "sample_line.json")))
            dir = dir.Parent;
        if (dir is null) throw new DirectoryNotFoundException("contracts/plant/sample_line.json");
        return TwinJson.LoadPlant(Path.Combine(dir.FullName, "contracts", "plant", "sample_line.json"));
    });

    public static PlantModel Sample => s_sample.Value;

    private static readonly Lazy<PlantModel> s_v03 = new(() =>
        TwinJson.LoadPlant(Path.Combine(RepoRoot(), "contracts", "examples", "plant.v03.json")));

    /// <summary>contracts/examples/plant.v03.json: lines, a resource pool, a calendar and a mesh.</summary>
    public static PlantModel V03Example => s_v03.Value;

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts", "examples"))) dir = dir.Parent;
        return dir?.FullName ?? throw new DirectoryNotFoundException("contracts/examples");
    }

    private static readonly Vec3 Origin = new(0, 0, 0);
    private static readonly Vec3 Box = new(1, 1, 1);

    /// <summary>Compact asset def for hand-built test plants.</summary>
    public static AssetDef Asset(string id, AssetKind kind, string[] downstream, Dictionary<string, double>? p = null,
                                 string? resourceId = null, string? shiftId = null, string? lineId = null) =>
        new(id, id, kind, Origin, 0, Box, downstream, p ?? new Dictionary<string, double>(),
            LineId: lineId, ResourceId: resourceId, ShiftId: shiftId);

    public static PlantModel Plant(IReadOnlyList<AssetDef> assets, IReadOnlyList<ResourceDef>? resources = null,
                                   CalendarDef? calendar = null, IReadOnlyList<LineDef>? lines = null) =>
        new("test", "Test", 1, 1, assets, [], Lines: lines, Resources: resources, Calendar: calendar);

    public static SimulationEngine NewEngine(int? seed = null) => new(Sample, seed ?? Sample.Seed);

    public static AssetState State(this ISimulationEngine e, string id) => e.GetAssetStates().Single(s => s.Id == id);
    public static AssetStats Stats(this ISimulationEngine e, string id) => e.GetAssetStats().Single(s => s.AssetId == id);

    public static long SinkGood(this ISimulationEngine e) => e.State("SNK-01").Good;
    public static long Released(this ISimulationEngine e) => e.State("SRC-01").Good;
    public static long TotalScrap(this ISimulationEngine e) => e.GetAssetStates().Sum(s => s.Scrap);

    public static Dictionary<string, double> P(params (string Key, double Value)[] kv) =>
        kv.ToDictionary(x => x.Key, x => x.Value);
}
