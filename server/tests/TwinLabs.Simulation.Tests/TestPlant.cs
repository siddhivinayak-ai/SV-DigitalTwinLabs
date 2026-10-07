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

    public static SimulationEngine NewEngine(int? seed = null) => new(Sample, seed ?? Sample.Seed);

    public static AssetState State(this ISimulationEngine e, string id) => e.GetAssetStates().Single(s => s.Id == id);
    public static AssetStats Stats(this ISimulationEngine e, string id) => e.GetAssetStats().Single(s => s.AssetId == id);

    public static long SinkGood(this ISimulationEngine e) => e.State("SNK-01").Good;
    public static long Released(this ISimulationEngine e) => e.State("SRC-01").Good;
    public static long TotalScrap(this ISimulationEngine e) => e.GetAssetStates().Sum(s => s.Scrap);

    public static Dictionary<string, double> P(params (string Key, double Value)[] kv) =>
        kv.ToDictionary(x => x.Key, x => x.Value);
}
