using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Read-only <see cref="ISimulationEngine"/> over the shadow twin, so the unchanged <see cref="IKpiCalculator"/>
/// computes KPIs from the actual line. State-seconds are accumulated from the twin (actual where bound) asset
/// states once per sim second; counters are the actual counters since the shadow session started. Plant, time,
/// parts and resources come from the predictor (<see cref="Inner"/>). Every mutator throws.
/// Not thread-safe; the host lock guards it.
/// </summary>
public sealed class ShadowEngineView : ISimulationEngine
{
    private readonly Dictionary<string, StateBreakdown> _seconds = new(StringComparer.Ordinal);
    private Dictionary<string, (long Good, long Scrap)> _counts = new(StringComparer.Ordinal);
    private IReadOnlyList<AssetState> _assets = [];
    private IReadOnlyList<SensorValue> _sensors = [];
    private int _wipDelta;
    private long _lastMs;

    public ShadowEngineView(ISimulationEngine inner) => Reset(inner);

    public ISimulationEngine Inner { get; private set; } = null!;

    /// <summary>Start a new session on <paramref name="inner"/> (mode switch, reset, plant change).</summary>
    public void Reset(ISimulationEngine inner)
    {
        Inner = inner;
        _seconds.Clear();
        _counts = new(StringComparer.Ordinal);
        _assets = [];
        _sensors = [];
        _wipDelta = 0;
        _lastMs = inner.SimTimeMs;
    }

    /// <summary>One per-second sample of the twin. <paramref name="counts"/> are the actual KPI counters (see <see cref="ShadowState.KpiCounts"/>).</summary>
    public void Accumulate(long simMs, IReadOnlyList<AssetState> twinAssets, IReadOnlyList<SensorValue> twinSensors,
        Dictionary<string, (long Good, long Scrap)> counts, int wipDelta)
    {
        var dt = Math.Max(0, simMs - _lastMs) / 1000.0;
        _lastMs = simMs;
        foreach (var a in twinAssets)
            _seconds[a.Id] = _seconds.GetValueOrDefault(a.Id, StateBreakdown.Zero).Add(a.State, dt);
        _assets = twinAssets;
        _sensors = twinSensors;
        _counts = counts;
        _wipDelta = wipDelta;
    }

    public PlantModel Plant => Inner.Plant;
    public int Seed => Inner.Seed;
    public long Tick => Inner.Tick;
    public long SimTimeMs => Inner.SimTimeMs;
    public double Dt => Inner.Dt;
    public int Wip => Math.Max(0, Inner.Wip + _wipDelta);

    public IReadOnlyList<AssetState> GetAssetStates() => _assets.Count > 0 ? _assets : Inner.GetAssetStates();
    public IReadOnlyList<SensorValue> GetSensorValues() => _sensors.Count > 0 ? _sensors : Inner.GetSensorValues();
    public IReadOnlyList<PartPosition> GetParts() => Inner.GetParts();
    public IReadOnlyList<ResourceStats> GetResourceStats() => Inner.GetResourceStats();

    public IReadOnlyList<AssetStats> GetAssetStats()
    {
        var inner = (Inner.GetAssetStats() ?? []).ToDictionary(s => s.AssetId, StringComparer.Ordinal);
        var res = new List<AssetStats>(Plant.Assets.Count);
        foreach (var a in Plant.Assets)
        {
            var s = inner.TryGetValue(a.Id, out var x)
                ? x
                : new AssetStats(a.Id, StateBreakdown.Zero, 0, 0, 0, a.Params.GetValueOrDefault(ParamKeys.CycleTimeS));
            s = s with { StateSeconds = _seconds.GetValueOrDefault(a.Id, StateBreakdown.Zero) };
            if (_counts.TryGetValue(a.Id, out var c)) s = s with { Good = c.Good, Scrap = c.Scrap, Total = c.Good + c.Scrap };
            res.Add(s);
        }
        return res;
    }

    /// <summary>Engine events belong to the host; the view never drains them.</summary>
    public IReadOnlyList<EventRecord> DrainEvents() => [];

    public void Step() => throw ReadOnly();
    public void Advance(TimeSpan simTime) => throw ReadOnly();
    public AssetDef UpdateParams(string assetId, IReadOnlyDictionary<string, double> changes) => throw ReadOnly();
    public void InjectFault(string assetId, double? durationS = null) => throw ReadOnly();
    public void ClearFault(string assetId) => throw ReadOnly();
    public void SetMaintenance(string assetId, bool on) => throw ReadOnly();
    public void SetEnabled(string assetId, bool enabled) => throw ReadOnly();
    public void Reset(int? seed = null) => throw ReadOnly();

    private static NotSupportedException ReadOnly() => new("ShadowEngineView is read-only; mutate the predictor engine instead.");
}
