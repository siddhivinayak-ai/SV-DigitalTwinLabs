using System.Collections.Concurrent;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

/// <summary>Deterministic stand-in for the real engine: t = tick × 100 ms, every sensor reads sim seconds.</summary>
public sealed class FakeEngine : ISimulationEngine
{
    private readonly Dictionary<string, AssetState> _states = new();
    private readonly List<EventRecord> _pending = new();

    public FakeEngine(PlantModel plant, int seed)
    {
        Plant = plant;
        Seed = seed;
        foreach (var a in plant.Assets) _states[a.Id] = new AssetState(a.Id, AssetStateKind.Idle, 0, 0, 0, 0, 0, 0, 0);
    }

    public PlantModel Plant { get; private set; }
    public int Seed { get; private set; }
    public long Tick { get; private set; }
    public long SimTimeMs => Tick * 100;
    public double Dt => 0.1;
    public int Wip => 0;
    public int ResetCount { get; private set; }
    public List<(string AssetId, double? DurationS)> Faults { get; } = new();

    public void Step() => Tick++;
    public void Advance(TimeSpan simTime) => Tick += (long)(simTime.TotalSeconds / Dt);

    public IReadOnlyList<AssetState> GetAssetStates() => [.. _states.Values];
    public IReadOnlyList<SensorValue> GetSensorValues() => [.. Plant.Sensors.Select(s => new SensorValue(s.Id, SimTimeMs / 1000.0))];
    public IReadOnlyList<PartPosition> GetParts() => [new PartPosition(1, Plant.Assets[0].Id, 0.5)];
    public IReadOnlyList<AssetStats> GetAssetStats() => [];

    public IReadOnlyList<EventRecord> DrainEvents()
    {
        var e = _pending.ToArray();
        _pending.Clear();
        return e;
    }

    public void Emit(EventRecord e) => _pending.Add(e);

    public AssetDef UpdateParams(string assetId, IReadOnlyDictionary<string, double> changes)
    {
        var def = Plant.Assets.FirstOrDefault(a => a.Id == assetId) ?? throw new KeyNotFoundException(assetId);
        if (changes.Any(kv => kv.Value < 0)) throw new ArgumentException("Parameters must be non-negative");
        var merged = new Dictionary<string, double>(def.Params);
        foreach (var (k, v) in changes) merged[k] = v;
        var updated = def with { Params = merged };
        Plant = Plant with { Assets = [.. Plant.Assets.Select(a => a.Id == assetId ? updated : a)] };
        _pending.Add(new EventRecord(999, SimTimeMs, EventKind.Info, Severity.Info, $"{assetId} params changed", assetId));
        return updated;
    }

    public void InjectFault(string assetId, double? durationS = null)
    {
        Faults.Add((assetId, durationS));
        SetState(assetId, AssetStateKind.Fault);
    }

    public void ClearFault(string assetId) => SetState(assetId, AssetStateKind.Idle);
    public void SetMaintenance(string assetId, bool on) => SetState(assetId, on ? AssetStateKind.Maintenance : AssetStateKind.Idle);
    public void SetEnabled(string assetId, bool enabled) => SetState(assetId, enabled ? AssetStateKind.Idle : AssetStateKind.Off);

    private void SetState(string id, AssetStateKind s)
    {
        var from = _states[id].State;
        _states[id] = _states[id] with { State = s, StateSinceMs = SimTimeMs };
        _pending.Add(new EventRecord(1, SimTimeMs, EventKind.State, Severity.Info, $"{id} {from} -> {s}", id, from, s));
    }

    public void Reset(int? seed = null)
    {
        Tick = 0;
        if (seed is { } s) Seed = s;
        ResetCount++;
        _pending.Clear();
        foreach (var id in _states.Keys.ToList()) _states[id] = _states[id] with { State = AssetStateKind.Idle, StateSinceMs = 0 };
    }
}

public sealed class FakeEngineFactory : ISimulationEngineFactory
{
    public ConcurrentQueue<FakeEngine> Created { get; } = new();
    public FakeEngine Last => Created.Last();

    public ISimulationEngine Create(PlantModel plant, int seed)
    {
        var e = new FakeEngine(plant, seed);
        Created.Enqueue(e);
        return e;
    }
}

public sealed class FakeKpiCalculator : IKpiCalculator
{
    public int ResetCount { get; private set; }

    public static LineKpi Line(int wip = 0) => new(0.712, 0.934, 0.861, 0.885, 132.4, wip, 23, 3, "ASSY-01");

    public KpiReport Compute(ISimulationEngine engine) => new(
        engine.SimTimeMs,
        Line(engine.Wip),
        [new AssetKpi("ASSY-01", 0.802, 0.951, 0.874, 0.965, 0.913, 27, 1, new StateBreakdown(0, 0.002, 0.862, 0.061, 0.024, 0.051, 0))]);

    public void Reset() => ResetCount++;
}

public sealed class FakeAnomalyDetector : IAnomalyDetector
{
    private readonly List<Alarm> _active = new();

    /// <summary>Alarms to "raise" on the next Observe call.</summary>
    public ConcurrentQueue<Alarm> Pending { get; } = new();
    public int Observations { get; private set; }
    public int ResetCount { get; private set; }

    public IReadOnlyList<Alarm> Observe(long simTimeMs, IReadOnlyList<SensorValue> sensors, IReadOnlyList<AssetState> assets)
    {
        Observations++;
        var raised = new List<Alarm>();
        while (Pending.TryDequeue(out var a))
        {
            var stamped = a with { RaisedAtMs = simTimeMs };
            _active.RemoveAll(x => x.Id == a.Id);
            _active.Add(stamped);
            raised.Add(stamped);
        }
        return raised;
    }

    public IReadOnlyList<Alarm> Active => [.. _active];

    public Alarm? Acknowledge(string alarmId)
    {
        var i = _active.FindIndex(a => a.Id == alarmId);
        if (i < 0) return null;
        _active[i] = _active[i] with { Acknowledged = true };
        return _active[i];
    }

    public void Reset()
    {
        ResetCount++;
        _active.Clear();
    }

    public static Alarm VibAlarm() => new("ALM-CNC-01.vib-limit", AlarmSource.Limit, Severity.Warning, "CNC-01",
        "CNC-01.vib HI 4.62 mm/s > 4.5", 0, true, false, "CNC-01.vib", 4.62, 4.5);
}

public sealed class FakeWhatIfRunner : IWhatIfRunner
{
    /// <summary>Closed = Run blocks until it is set (to test the one-at-a-time rule).</summary>
    public ManualResetEventSlim Release { get; } = new(true);
    public ManualResetEventSlim Entered { get; } = new(false);
    public WhatIfRequest? LastRequest { get; private set; }
    public PlantModel? LastBasePlant { get; private set; }
    public int? LastThreadId { get; private set; }

    public WhatIfResult Run(WhatIfRequest request, PlantModel basePlant)
    {
        LastRequest = request;
        LastBasePlant = basePlant;
        LastThreadId = Environment.CurrentManagedThreadId;
        Entered.Set();
        Release.Wait(TimeSpan.FromSeconds(10));

        var ms = (long)(request.DurationS * 1000);
        var baseline = new KpiReport(ms, FakeKpiCalculator.Line(19), []);
        var scenario = new KpiReport(ms, FakeKpiCalculator.Line(24) with { Oee = 0.751 }, []);
        return new WhatIfResult(request.DurationS, request.Seed ?? basePlant.Seed, baseline, scenario,
            [new KpiDelta("oee", 0.712, 0.751, 0.039, 5.48)], 12);
    }
}
