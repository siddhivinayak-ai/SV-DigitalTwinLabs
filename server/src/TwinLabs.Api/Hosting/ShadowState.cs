using System.Globalization;
using TwinLabs.Connect;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Shadow-mode bookkeeping for one plant: the latest actual value of every bound target, per-connection liveness,
/// counter baselines for KPIs and the deviation trackers. Not thread-safe; the host lock guards it.
/// <para>
/// Freshness: a value is fresh when it is at most <see cref="StaleAfterMs"/> old (wall clock), or when its
/// connection delivered any update in that window. The second rule covers report-by-exception sources (OPC UA
/// subscriptions only send changes), where a constant tag would otherwise go stale although the link is alive.
/// </para>
/// </summary>
internal sealed class ShadowState
{
    public const long StaleAfterMs = 5000;

    private readonly record struct Key(TargetKind Kind, string Id);

    private sealed class Actual
    {
        public double Value;
        public AssetStateKind? State;
        public long WallMs;
        public required string ConnectionId;
    }

    private readonly Dictionary<Key, string> _bound = new();
    private readonly Dictionary<Key, Actual> _actual = new();
    private readonly Dictionary<string, long> _connectionLastMs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (AssetStateKind State, long SinceMs)> _states = new(StringComparer.Ordinal);
    private readonly Dictionary<Key, double> _counterBase = new();
    private readonly Dictionary<string, DeviationTracker> _trackers = new(StringComparer.Ordinal);

    public ShadowState(PlantModel plant, ShadowState? previous = null)
    {
        foreach (var b in plant.Bindings ?? [])
            if (BindingResolver.TryParseTarget(b.Target, out var kind, out var id))
                _bound.TryAdd(new Key(kind, id), b.ConnectionId);

        var sensors = plant.Sensors.ToDictionary(s => s.Id, StringComparer.Ordinal);
        foreach (var k in _bound.Keys)
            if (k.Kind == TargetKind.Sensor && sensors.TryGetValue(k.Id, out var def) && def.Kind != SensorKind.Count)
                _trackers[k.Id] = new DeviationTracker(def);

        if (previous is null) return;
        // Keep live values across a plant edit when the target is still bound to the same connection.
        foreach (var (k, a) in previous._actual)
            if (_bound.TryGetValue(k, out var c) && c == a.ConnectionId) _actual[k] = a;
        foreach (var (c, t) in previous._connectionLastMs) _connectionLastMs[c] = t;
        foreach (var (id, s) in previous._states)
            if (_bound.ContainsKey(new Key(TargetKind.AssetState, id))) _states[id] = s;
    }

    public int BindingCount => _bound.Count;

    public bool IsStateBound(string assetId) => _bound.ContainsKey(new Key(TargetKind.AssetState, assetId));

    public IEnumerable<Alarm> ActiveDeviations => _trackers.Values.Select(t => t.Active).OfType<Alarm>();

    /// <summary>Store one resolved value. Returns the actual state transition when an asset state changed.</summary>
    public (AssetStateKind From, AssetStateKind To)? Apply(string connectionId, ResolvedUpdate u, long simMs)
    {
        var key = new Key(u.Kind, u.Id);
        if (!_bound.TryGetValue(key, out var conn) || conn != connectionId) return null;

        if (!_actual.TryGetValue(key, out var a)) _actual[key] = a = new Actual { ConnectionId = connectionId };
        a.Value = u.Value;
        a.State = u.State;
        a.WallMs = u.WallTimeMs;
        if (!_connectionLastMs.TryGetValue(connectionId, out var last) || u.WallTimeMs > last)
            _connectionLastMs[connectionId] = u.WallTimeMs;
        if (u.Kind is TargetKind.AssetGood or TargetKind.AssetScrap) _counterBase.TryAdd(key, u.Value);

        if (u.State is not { } st) return null;
        if (_states.TryGetValue(u.Id, out var prev))
        {
            if (prev.State == st) return null;
            _states[u.Id] = (st, simMs);
            return (prev.State, st);
        }
        _states[u.Id] = (st, simMs);
        return null;
    }

    /// <summary>A new shadow session (mode switch / reset): counters restart from the current actual values, deviation trackers start over.</summary>
    public void ResetSession(long simMs)
    {
        _counterBase.Clear();
        foreach (var (k, a) in _actual)
            if (k.Kind is TargetKind.AssetGood or TargetKind.AssetScrap) _counterBase[k] = a.Value;
        foreach (var id in _states.Keys.ToList()) _states[id] = (_states[id].State, simMs);
        foreach (var t in _trackers.Values) t.Reset();
    }

    private bool TryFresh(TargetKind kind, string id, long nowMs, out Actual actual)
    {
        if (_actual.TryGetValue(new Key(kind, id), out actual!))
        {
            if (nowMs - actual.WallMs <= StaleAfterMs) return true;
            if (_connectionLastMs.TryGetValue(actual.ConnectionId, out var last) && nowMs - last <= StaleAfterMs) return true;
        }
        return false;
    }

    /// <summary>Predicted asset states with every fresh actual value applied. Cycle progress stays predicted.</summary>
    public IReadOnlyList<AssetState> MergeAssets(IReadOnlyList<AssetState> predicted, long nowMs)
    {
        var res = new AssetState[predicted.Count];
        for (var i = 0; i < res.Length; i++)
        {
            var a = predicted[i];
            if (TryFresh(TargetKind.AssetState, a.Id, nowMs, out var st) && st.State is { } s)
                a = a with { State = s, StateSinceMs = _states.TryGetValue(a.Id, out var since) ? since.SinceMs : a.StateSinceMs };
            if (TryFresh(TargetKind.AssetGood, a.Id, nowMs, out var g)) a = a with { Good = ToLong(g.Value) };
            if (TryFresh(TargetKind.AssetScrap, a.Id, nowMs, out var sc)) a = a with { Scrap = ToLong(sc.Value) };
            if (TryFresh(TargetKind.AssetWip, a.Id, nowMs, out var w)) a = a with { Wip = (int)Math.Clamp(Math.Round(w.Value), 0, int.MaxValue) };
            if (TryFresh(TargetKind.AssetLoad, a.Id, nowMs, out var l)) a = a with { Load = l.Value };
            if (TryFresh(TargetKind.AssetWear, a.Id, nowMs, out var we)) a = a with { Wear = we.Value };
            res[i] = a;
        }
        return res;
    }

    public IReadOnlyList<SensorValue> MergeSensors(IReadOnlyList<SensorValue> predicted, long nowMs)
    {
        var res = new SensorValue[predicted.Count];
        for (var i = 0; i < res.Length; i++)
        {
            var p = predicted[i];
            res[i] = TryFresh(TargetKind.Sensor, p.Id, nowMs, out var a) ? new SensorValue(p.Id, a.Value) : p;
        }
        return res;
    }

    /// <summary>
    /// KPI counters: fresh actual counters relative to the session baseline, predicted otherwise. Only assets with at
    /// least one actual counter are returned. <paramref name="wipDelta"/> = Σ(actual − predicted) WIP of bound assets.
    /// </summary>
    public Dictionary<string, (long Good, long Scrap)> KpiCounts(IReadOnlyList<AssetState> predicted, long nowMs, out int wipDelta)
    {
        var res = new Dictionary<string, (long, long)>(StringComparer.Ordinal);
        wipDelta = 0;
        foreach (var p in predicted)
        {
            var hasGood = TryFresh(TargetKind.AssetGood, p.Id, nowMs, out var g);
            var hasScrap = TryFresh(TargetKind.AssetScrap, p.Id, nowMs, out var s);
            if (hasGood || hasScrap)
                res[p.Id] = (hasGood ? Since(TargetKind.AssetGood, p.Id, g.Value) : p.Good,
                             hasScrap ? Since(TargetKind.AssetScrap, p.Id, s.Value) : p.Scrap);
            if (TryFresh(TargetKind.AssetWip, p.Id, nowMs, out var w)) wipDelta += (int)Math.Round(w.Value) - p.Wip;
        }
        return res;
    }

    private long Since(TargetKind kind, string id, double value) =>
        Math.Max(0, ToLong(value - _counterBase.GetValueOrDefault(new Key(kind, id))));

    /// <summary>One per-second deviation sample for every bound sensor with a fresh actual value.</summary>
    public List<Alarm> EvaluateDeviations(long simMs, IReadOnlyList<SensorValue> predicted, long nowMs)
    {
        var changed = new List<Alarm>();
        if (_trackers.Count == 0) return changed;
        foreach (var p in predicted)
        {
            if (!_trackers.TryGetValue(p.Id, out var tracker)) continue;
            if (!TryFresh(TargetKind.Sensor, p.Id, nowMs, out var a))
            {
                tracker.Skip(p.V);
                continue;
            }
            if (tracker.Observe(simMs, p.V, a.Value) is { } alarm) changed.Add(alarm);
        }
        return changed;
    }

    public Alarm? Acknowledge(string alarmId)
    {
        foreach (var t in _trackers.Values)
            if (t.Active?.Id == alarmId) return t.Acknowledge();
        return null;
    }

    /// <summary>Clear every active deviation (leaving shadow mode). Returns the cleared alarms.</summary>
    public List<Alarm> ClearDeviations(long simMs)
    {
        var res = new List<Alarm>();
        foreach (var t in _trackers.Values)
            if (t.ForceClear(simMs) is { } a) res.Add(a);
        return res;
    }

    private static long ToLong(double v) => double.IsFinite(v) ? (long)Math.Round(v) : 0;
}

/// <summary>
/// Deviation alarm for one sensor: raised when |actual − predicted| &gt; max(3σ, 10 % of |predicted|) for
/// <see cref="Samples"/> consecutive samples, cleared after as many calm samples. σ is the EWMA standard deviation
/// of the predicted value (the prediction baseline), updated after each comparison.
/// </summary>
internal sealed class DeviationTracker(SensorDef sensor)
{
    public const int Samples = 10;
    public const double Relative = 0.10;
    public const double Alpha = 0.05;

    private double _mean, _var;
    private long _n;
    private int _over, _calm;

    public SensorDef Sensor { get; } = sensor;
    public Alarm? Active { get; private set; }

    public string AlarmId => $"ALM-{Sensor.Id}-deviation";

    public double Threshold(double predicted) => Math.Max(3 * Math.Sqrt(Math.Max(0, _var)), Relative * Math.Abs(predicted));

    public Alarm? Observe(long simMs, double predicted, double actual)
    {
        var deviates = Math.Abs(actual - predicted) > Threshold(predicted);
        Learn(predicted);

        if (deviates)
        {
            _calm = 0;
            _over++;
            if (Active is null && _over >= Samples)
            {
                Active = new Alarm(AlarmId, AlarmSource.Deviation, Severity.Warning, Sensor.AssetId,
                    $"{Sensor.Id} deviates from prediction: actual {Fmt(actual)} {Sensor.Unit}, predicted {Fmt(predicted)} {Sensor.Unit}",
                    simMs, true, false, Sensor.Id, actual, predicted);
                return Active;
            }
            return null;
        }

        _over = 0;
        if (Active is not null && ++_calm >= Samples)
        {
            var cleared = Active with { Active = false, ClearedAtMs = simMs, Value = actual, Limit = predicted };
            Active = null;
            _calm = 0;
            return cleared;
        }
        return null;
    }

    /// <summary>No fresh actual this second: keep learning the baseline, break the consecutive runs.</summary>
    public void Skip(double predicted)
    {
        Learn(predicted);
        _over = 0;
        _calm = 0;
    }

    public Alarm? Acknowledge() => Active is null ? null : Active = Active with { Acknowledged = true };

    public Alarm? ForceClear(long simMs)
    {
        if (Active is null) return null;
        var cleared = Active with { Active = false, ClearedAtMs = simMs };
        Reset();
        return cleared;
    }

    public void Reset()
    {
        _mean = _var = 0;
        _n = 0;
        _over = _calm = 0;
        Active = null;
    }

    private void Learn(double x)
    {
        if (!double.IsFinite(x)) return;
        if (_n++ == 0)
        {
            _mean = x;
            _var = 0;
            return;
        }
        var diff = x - _mean;
        var incr = Alpha * diff;
        _mean += incr;
        _var = (1 - Alpha) * (_var + diff * incr);
    }

    private static string Fmt(double v) => v.ToString("0.0", CultureInfo.InvariantCulture);
}
