using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Analytics.Tests;

/// <summary>Scriptable stand-in for the real simulation engine. Mutators only record their calls.</summary>
public sealed class FakeEngine(PlantModel plant, int seed = 42) : ISimulationEngine
{
    public PlantModel Plant { get; set; } = plant;
    public int Seed { get; set; } = seed;
    public long Tick { get; set; }
    public long SimTimeMs { get; set; }
    public double Dt => 0.1;
    public int Wip { get; set; }

    public List<AssetStats> Stats { get; set; } = [];
    public List<AssetState> States { get; set; } = [];
    public List<SensorValue> Sensors { get; set; } = [];
    /// <summary>Scripted v0.3 resource counters returned by GetResourceStats.</summary>
    public List<ResourceStats> ResourceStats { get; set; } = [];
    public int ResourceStatsCalls { get; private set; }

    /// <summary>Called after every Advance/Step with the new time, to script stats over time.</summary>
    public Action<FakeEngine>? OnAdvance { get; set; }
    /// <summary>Optional validation hook for UpdateParams (throw to reject).</summary>
    public Action<string, IReadOnlyDictionary<string, double>>? ValidateParams { get; set; }

    public List<TimeSpan> AdvanceCalls { get; } = [];
    public List<(string AssetId, IReadOnlyDictionary<string, double> Changes)> ParamCalls { get; } = [];
    public List<(string AssetId, double? DurationS)> FaultCalls { get; } = [];
    public int ResetCalls { get; private set; }

    public void Step()
    {
        Tick++;
        SimTimeMs += 100;
        OnAdvance?.Invoke(this);
    }

    public void Advance(TimeSpan simTime)
    {
        AdvanceCalls.Add(simTime);
        SimTimeMs += (long)Math.Round(simTime.TotalMilliseconds);
        Tick = SimTimeMs / 100;
        OnAdvance?.Invoke(this);
    }

    public IReadOnlyList<AssetState> GetAssetStates() => States;
    public IReadOnlyList<SensorValue> GetSensorValues() => Sensors;
    public IReadOnlyList<PartPosition> GetParts() => [];
    public IReadOnlyList<AssetStats> GetAssetStats() => Stats;
    public IReadOnlyList<ResourceStats> GetResourceStats() { ResourceStatsCalls++; return ResourceStats; }
    public IReadOnlyList<EventRecord> DrainEvents() => [];

    public AssetDef UpdateParams(string assetId, IReadOnlyDictionary<string, double> changes)
    {
        var def = Plant.Assets.FirstOrDefault(a => a.Id == assetId)
                  ?? throw new KeyNotFoundException($"Unknown asset '{assetId}'");
        ValidateParams?.Invoke(assetId, changes);
        ParamCalls.Add((assetId, changes));
        var merged = new Dictionary<string, double>(def.Params);
        foreach (var (k, v) in changes) merged[k] = v;
        return def with { Params = merged };
    }

    public void InjectFault(string assetId, double? durationS = null) => FaultCalls.Add((assetId, durationS));
    public void ClearFault(string assetId) { }
    public void SetMaintenance(string assetId, bool on) { }
    public void SetEnabled(string assetId, bool enabled) { }

    public void Reset(int? seed = null)
    {
        ResetCalls++;
        SimTimeMs = 0;
        Tick = 0;
        if (seed is { } s) Seed = s;
    }
}

public sealed class FakeFactory(Action<FakeEngine>? configure = null) : ISimulationEngineFactory
{
    private readonly object _gate = new();
    public List<(PlantModel Plant, int Seed, FakeEngine Engine)> Created { get; } = [];

    public ISimulationEngine Create(PlantModel plant, int seed)
    {
        var e = new FakeEngine(plant, seed);
        configure?.Invoke(e);
        lock (_gate) Created.Add((plant, seed, e));
        return e;
    }
}

public static class TestPlant
{
    private static readonly Vec3 V = new(0, 0, 0);

    public static AssetDef Asset(string id, AssetKind kind, params string[] downstream) =>
        new(id, id, kind, V, 0, V, downstream, new Dictionary<string, double>());

    /// <summary>SRC → M1 (machine) → BUF → R1 (robot) → QC (inspection) → SNK.</summary>
    public static PlantModel Create(int seed = 42) => new(
        "test", "Test Line", 1, seed,
        [
            Asset("SRC", AssetKind.Source, "M1"),
            Asset("M1", AssetKind.Machine, "BUF"),
            Asset("BUF", AssetKind.Buffer, "R1"),
            Asset("R1", AssetKind.Robot, "QC"),
            Asset("QC", AssetKind.Inspection, "SNK"),
            Asset("SNK", AssetKind.Sink),
        ],
        [
            new SensorDef("M1.vib", "M1", SensorKind.Vibration, "mm/s", 0.04, Hi: 4.5, HiHi: 7.1),
            new SensorDef("M1.temp", "M1", SensorKind.Temperature, "°C", 0.005),
            new SensorDef("M1.power", "M1", SensorKind.Power, "kW", 0.02),
            new SensorDef("R1.hot", "R1", SensorKind.Temperature, "°C", 0.005, HiHi: 65),
            new SensorDef("BUF.level", "BUF", SensorKind.Level, "pcs", 0, Hi: 9),
            new SensorDef("SNK.good", "SNK", SensorKind.Count, "pcs", 0),
        ]);

    public static StateBreakdown States(
        double off = 0, double idle = 0, double running = 0, double starved = 0,
        double blocked = 0, double fault = 0, double maintenance = 0) =>
        new(off, idle, running, starved, blocked, fault, maintenance);

    public static AssetState State(string id, AssetStateKind s) => new(id, s, 0, 0, 0, 0, 0, 0, 0);
}
