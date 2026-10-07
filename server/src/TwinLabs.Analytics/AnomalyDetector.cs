using System.Globalization;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Analytics;

/// <summary>
/// Limit, EWMA-anomaly and fault alarms (docs/V1-Spec.md §3). Stateful; one instance per engine.
/// Alarm ids are deterministic: <c>ALM-{sensorId}-limit</c>, <c>ALM-{sensorId}-anomaly</c>, <c>ALM-{assetId}-fault</c>.
/// Not thread-safe; callers serialise access.
/// </summary>
public sealed class AnomalyDetector(PlantModel plant) : IAnomalyDetector
{
    // ---- tuning (spec values) ----
    public const int LimitDebounceSamples = 3;
    public const double LimitClearFactor = 0.98;
    public const double EwmaAlpha = 0.05;
    public const int WarmupSamples = 50;
    public const double ZWarning = 4;
    public const double ZCritical = 6;
    public const int AnomalyDebounceSamples = 3;
    public const double ZClear = 2;
    public const int AnomalyClearSamples = 10;
    /// <summary>Off-delay (ISA-18.2): samples below the clear threshold before a limit alarm clears.</summary>
    public const int LimitClearSamples = 10;
    /// <summary>Samples an asset must have been Running before its sensors are judged for anomalies.</summary>
    public const int SettleSamples = 30;

    private readonly Dictionary<string, SensorDef> _defs = BuildDefs(plant);
    private readonly Dictionary<string, LimitState> _limit = new(StringComparer.Ordinal);
    private readonly Dictionary<string, EwmaState> _ewma = new(StringComparer.Ordinal);
    // Active alarms, in raise order (stable output order).
    private readonly Dictionary<string, Alarm> _active = new(StringComparer.Ordinal);
    private readonly List<string> _order = [];
    private long _lastT = long.MinValue;

    public PlantModel Plant { get; } = plant ?? throw new ArgumentNullException(nameof(plant));

    public IReadOnlyList<Alarm> Active => _order.Select(id => _active[id]).ToList();

    public IReadOnlyList<Alarm> Observe(long simTimeMs, IReadOnlyList<SensorValue> sensors, IReadOnlyList<AssetState> assets)
    {
        if (simTimeMs < _lastT) Reset(); // engine was reset underneath us
        _lastT = simTimeMs;

        sensors ??= [];
        assets ??= [];
        var changes = new List<Alarm>();

        var stateById = new Dictionary<string, AssetStateKind>(StringComparer.Ordinal);
        foreach (var a in assets) stateById[a.Id] = a.State;

        foreach (var sv in sensors)
        {
            if (!_defs.TryGetValue(sv.Id, out var def) || !double.IsFinite(sv.V)) continue;
            // Unknown asset state = assume Running.
            var running = !stateById.TryGetValue(def.AssetId, out var st) || st == AssetStateKind.Running;

            // Running-only signals (vibration, drive power/current, belt speed) drop to idle values whenever the
            // asset stops; judging them then makes limit alarms chatter. Hold the limit state instead.
            if (running || !IsRunningOnlySignal(def.Kind)) ObserveLimit(simTimeMs, def, sv.V, changes);

            // Statistical anomaly detection targets vibration (the condition-monitoring signal). Temperature,
            // power and current follow load steps by design and are covered by hi/hiHi limits instead.
            if (def.Kind is not SensorKind.Vibration) continue;
            if (!_ewma.TryGetValue(def.Id, out var e)) _ewma[def.Id] = e = new EwmaState();
            if (!running)
            {
                e.ResetCounters();
                e.RunStreak = 0;
                continue;
            }
            // Let the signal settle after the asset (re)starts before judging it.
            if (++e.RunStreak <= SettleSamples) continue;
            ObserveAnomaly(simTimeMs, def, sv.V, changes);
        }

        foreach (var a in assets) ObserveFault(simTimeMs, a, changes);
        return changes;
    }

    public Alarm? Acknowledge(string alarmId)
    {
        if (alarmId is null || !_active.TryGetValue(alarmId, out var a)) return null;
        if (!a.Acknowledged) _active[alarmId] = a = a with { Acknowledged = true };
        return a;
    }

    public void Reset()
    {
        _limit.Clear();
        _ewma.Clear();
        _active.Clear();
        _order.Clear();
        _lastT = long.MinValue;
    }

    // ---------------- limit ----------------

    private void ObserveLimit(long t, SensorDef def, double v, List<Alarm> changes)
    {
        if (def.Hi is null && def.HiHi is null) return;
        var id = $"ALM-{def.Id}-limit";
        if (!_limit.TryGetValue(def.Id, out var ls)) _limit[def.Id] = ls = new LimitState();

        var lowest = def.Hi ?? def.HiHi!.Value;
        var overHiHi = def.HiHi is { } hh && v > hh;
        var over = v > lowest;
        ls.Over = over ? ls.Over + 1 : 0;

        if (_active.TryGetValue(id, out var cur))
        {
            ls.Under = v < lowest * LimitClearFactor ? ls.Under + 1 : 0;
            if (ls.Under >= LimitClearSamples)
            {
                ls.Over = 0;
                ls.Under = 0;
                changes.Add(Clear(id, t));
            }
            else if (overHiHi && cur.Severity < Severity.Critical)
            {
                changes.Add(Upsert(cur with
                {
                    Severity = Severity.Critical,
                    Acknowledged = false,
                    Message = LimitMessage(def, "HIHI", v, def.HiHi!.Value),
                    Value = v,
                    Limit = def.HiHi,
                }));
            }
            return;
        }

        if (ls.Over < LimitDebounceSamples) return;
        var critical = overHiHi;
        var limit = critical ? def.HiHi!.Value : lowest;
        var tag = critical || def.Hi is null ? "HIHI" : "HI";
        changes.Add(Upsert(new Alarm(
            id, AlarmSource.Limit, critical || def.Hi is null ? Severity.Critical : Severity.Warning,
            def.AssetId, LimitMessage(def, tag, v, limit), t, Active: true, Acknowledged: false,
            SensorId: def.Id, Value: v, Limit: limit)));
    }

    private static string LimitMessage(SensorDef def, string tag, double v, double limit) =>
        $"{def.Id} {tag} {Fmt(v)} {def.Unit} > {Fmt(limit)}";

    // ---------------- anomaly ----------------

    private void ObserveAnomaly(long t, SensorDef def, double v, List<Alarm> changes)
    {
        var id = $"ALM-{def.Id}-anomaly";
        if (!_ewma.TryGetValue(def.Id, out var e)) _ewma[def.Id] = e = new EwmaState();

        if (e.N < WarmupSamples)
        {
            e.Update(v);
            return;
        }

        var std = Math.Max(Math.Sqrt(Math.Max(e.Var, 0)), 1e-4 * Math.Abs(e.Mean) + 1e-9);
        var z = (v - e.Mean) / std;
        var absZ = Math.Abs(z);

        if (_active.TryGetValue(id, out var cur))
        {
            // Anomalous: the baseline is frozen until the alarm clears.
            if (absZ < ZClear)
            {
                if (++e.Calm >= AnomalyClearSamples)
                {
                    e.ResetCounters();
                    changes.Add(Clear(id, t));
                }
            }
            else
            {
                e.Calm = 0;
                if (absZ > ZCritical && cur.Severity < Severity.Critical)
                    changes.Add(Upsert(cur with
                    {
                        Severity = Severity.Critical,
                        Acknowledged = false,
                        Message = AnomalyMessage(def, z, v, e.Mean),
                        Value = v,
                        Limit = Boundary(e, std, z, ZCritical),
                    }));
            }
            return;
        }

        if (absZ > ZWarning)
        {
            // Pending: don't learn from a suspect sample.
            if (++e.Over >= AnomalyDebounceSamples)
            {
                var critical = absZ > ZCritical;
                e.Over = 0;
                e.Calm = 0;
                changes.Add(Upsert(new Alarm(
                    id, AlarmSource.Anomaly, critical ? Severity.Critical : Severity.Warning, def.AssetId,
                    AnomalyMessage(def, z, v, e.Mean), t, Active: true, Acknowledged: false,
                    SensorId: def.Id, Value: v, Limit: Boundary(e, std, z, critical ? ZCritical : ZWarning))));
            }
            return;
        }

        e.Over = 0;
        e.Update(v);
    }

    private static double Boundary(EwmaState e, double std, double z, double k) => e.Mean + Math.Sign(z) * k * std;

    private static string AnomalyMessage(SensorDef def, double z, double v, double mean) =>
        $"{def.Id} ANOMALY z={z.ToString("+0.0;-0.0", CultureInfo.InvariantCulture)} {Fmt(v)} {def.Unit} (baseline {Fmt(mean)})";

    // ---------------- fault ----------------

    private void ObserveFault(long t, AssetState a, List<Alarm> changes)
    {
        var id = $"ALM-{a.Id}-fault";
        var active = _active.ContainsKey(id);
        if (a.State == AssetStateKind.Fault && !active)
            changes.Add(Upsert(new Alarm(id, AlarmSource.Fault, Severity.Critical, a.Id,
                $"{a.Id} in FAULT", t, Active: true, Acknowledged: false)));
        else if (a.State != AssetStateKind.Fault && active)
            changes.Add(Clear(id, t));
    }

    // ---------------- bookkeeping ----------------

    private Alarm Upsert(Alarm a)
    {
        if (!_active.ContainsKey(a.Id)) _order.Add(a.Id);
        _active[a.Id] = a;
        return a;
    }

    private Alarm Clear(string id, long t)
    {
        var a = _active[id] with { Active = false, ClearedAtMs = t };
        _active.Remove(id);
        _order.Remove(id);
        return a;
    }

    private static string Fmt(double v) => v.ToString("0.##", CultureInfo.InvariantCulture);

    private static Dictionary<string, SensorDef> BuildDefs(PlantModel plant)
    {
        ArgumentNullException.ThrowIfNull(plant);
        var d = new Dictionary<string, SensorDef>(StringComparer.Ordinal);
        foreach (var s in plant.Sensors ?? []) d[s.Id] = s;
        return d;
    }

    private static bool IsRunningOnlySignal(SensorKind k) =>
        k is SensorKind.Vibration or SensorKind.Power or SensorKind.Current or SensorKind.Speed;

    private sealed class LimitState
    {
        public int Over;
        public int Under;
    }

    /// <summary>Exponentially weighted mean/variance (West/Finch incremental form).</summary>
    private sealed class EwmaState
    {
        public double Mean;
        public double Var;
        public int N;
        public int Over;
        public int Calm;
        public int RunStreak;

        public void Update(double x)
        {
            if (N == 0)
            {
                Mean = x;
                Var = 0;
            }
            else
            {
                var diff = x - Mean;
                var incr = EwmaAlpha * diff;
                Mean += incr;
                Var = (1 - EwmaAlpha) * (Var + diff * incr);
            }
            if (N < int.MaxValue) N++;
        }

        public void ResetCounters()
        {
            Over = 0;
            Calm = 0;
        }
    }
}
