using TwinLabs.Core.Contracts;

namespace TwinLabs.Core;

/// <summary>
/// Deterministic, single-threaded line simulator. Pure stepper: it has no notion of
/// running/paused or wall-clock speed. The API host owns that and calls <see cref="Step"/>.
/// Not thread-safe; callers serialise access.
/// </summary>
public interface ISimulationEngine
{
    /// <summary>Plant model with the current (possibly edited) params.</summary>
    PlantModel Plant { get; }
    int Seed { get; }
    long Tick { get; }
    long SimTimeMs { get; }
    /// <summary>Fixed tick size in sim seconds (0.1).</summary>
    double Dt { get; }
    /// <summary>Parts currently inside the line (released by the source, not yet in the sink or scrapped).</summary>
    int Wip { get; }

    /// <summary>Advance exactly one tick.</summary>
    void Step();
    /// <summary>Advance by <paramref name="simTime"/> as fast as possible (headless).</summary>
    void Advance(TimeSpan simTime);

    IReadOnlyList<AssetState> GetAssetStates();
    IReadOnlyList<SensorValue> GetSensorValues();
    IReadOnlyList<PartPosition> GetParts();
    IReadOnlyList<AssetStats> GetAssetStats();
    /// <summary>Events produced since the last call (faults, repairs, maintenance, param changes, enable/disable).</summary>
    IReadOnlyList<EventRecord> DrainEvents();

    /// <summary>Merge <paramref name="changes"/> into the asset's params. Throws <see cref="KeyNotFoundException"/> for unknown asset.</summary>
    AssetDef UpdateParams(string assetId, IReadOnlyDictionary<string, double> changes);
    /// <summary>Force a fault. <paramref name="durationS"/> null = draw repair time from MTTR.</summary>
    void InjectFault(string assetId, double? durationS = null);
    void ClearFault(string assetId);
    void SetMaintenance(string assetId, bool on);
    void SetEnabled(string assetId, bool enabled);
    /// <summary>Back to t=0 with all parts removed and counters cleared. Params are kept.</summary>
    void Reset(int? seed = null);
}

public interface ISimulationEngineFactory
{
    ISimulationEngine Create(PlantModel plant, int seed);
}

/// <summary>Computes OEE/throughput/bottleneck. Stateful (rolling throughput window); one instance per engine.</summary>
public interface IKpiCalculator
{
    KpiReport Compute(ISimulationEngine engine);
    void Reset();
}

/// <summary>Limit, EWMA-anomaly and fault alarms. Stateful; one instance per engine.</summary>
public interface IAnomalyDetector
{
    /// <summary>Feed one sample set. Returns alarms that were raised, escalated or cleared by this call.</summary>
    IReadOnlyList<Alarm> Observe(long simTimeMs, IReadOnlyList<SensorValue> sensors, IReadOnlyList<AssetState> assets);
    IReadOnlyList<Alarm> Active { get; }
    /// <summary>Returns the updated alarm, or null if no such active alarm.</summary>
    Alarm? Acknowledge(string alarmId);
    void Reset();
}

public interface IWhatIfRunner
{
    /// <param name="basePlant">Plant to start from (live params when request.FromLive, else the original model).</param>
    WhatIfResult Run(WhatIfRequest request, PlantModel basePlant);
}
