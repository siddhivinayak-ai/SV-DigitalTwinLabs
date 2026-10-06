using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Analytics;

/// <summary>
/// OEE / throughput / bottleneck calculator (docs/V1-Spec.md §3).
/// Stateful: keeps (simTime, sinkGood) samples for the rolling 1 h throughput window,
/// so use one instance per engine and call <see cref="Compute"/> periodically (e.g. 1 Hz).
/// Not thread-safe.
/// </summary>
public sealed class KpiCalculator : IKpiCalculator
{
    /// <summary>Rolling throughput window (sim ms).</summary>
    public const long WindowMs = 3_600_000;
    /// <summary>Throughput is reported as 0 until this much sim time has elapsed.</summary>
    public const long MinElapsedMs = 60_000;
    /// <summary>Active fractions within this distance of the best are a tie for bottleneck selection.</summary>
    public const double BottleneckTieTolerance = 0.01;

    // Samples ordered by time. Index 0 is always the window base: the newest sample at or before
    // (now - 1h), or the implicit origin (0, 0) because engine counters start at zero at t = 0.
    private readonly List<(long T, long Good)> _samples = [(0, 0)];
    private long _lastT = -1;
    private long _lastGood;

    public KpiReport Compute(ISimulationEngine engine)
    {
        ArgumentNullException.ThrowIfNull(engine);

        var now = engine.SimTimeMs;
        var stats = engine.GetAssetStats() ?? [];
        var byId = new Dictionary<string, AssetStats>(StringComparer.Ordinal);
        long scrap = 0;
        foreach (var s in stats)
        {
            byId[s.AssetId] = s;
            scrap += Math.Max(0, s.Scrap);
        }

        var assetKpis = new List<AssetKpi>();
        long sinkGood = 0;
        foreach (var a in engine.Plant.Assets)
        {
            if (a.Kind == AssetKind.Sink)
            {
                if (byId.TryGetValue(a.Id, out var sk)) sinkGood += Math.Max(0, sk.Good);
            }
            else if (IsMachineLike(a.Kind))
            {
                var st = byId.TryGetValue(a.Id, out var x)
                    ? x
                    : new AssetStats(a.Id, StateBreakdown.Zero, 0, 0, 0, 0);
                assetKpis.Add(ComputeAsset(st));
            }
        }

        // Time went backwards or the sink counter dropped: the engine was reset, start a fresh window.
        if (now < _lastT || sinkGood < _lastGood) Reset();
        var throughput = UpdateThroughput(now, sinkGood);

        var bottleneck = SelectBottleneck(assetKpis);
        var lineQ = Ratio(sinkGood, sinkGood + scrap, whenZero: 1);
        var lineA = bottleneck?.Availability ?? 0;
        var lineP = bottleneck?.Performance ?? 0;

        var line = new LineKpi(
            Oee: Clamp01(lineA * lineP * lineQ),
            Availability: lineA,
            Performance: lineP,
            Quality: lineQ,
            ThroughputPerHour: throughput,
            Wip: Math.Max(0, engine.Wip),
            Good: sinkGood,
            Scrap: scrap,
            BottleneckAssetId: bottleneck?.AssetId);

        return new KpiReport(now, line, assetKpis);
    }

    public void Reset()
    {
        _samples.Clear();
        _samples.Add((0, 0));
        _lastT = -1;
        _lastGood = 0;
    }

    public static bool IsMachineLike(AssetKind kind) =>
        kind is AssetKind.Machine or AssetKind.Robot or AssetKind.Inspection;

    /// <summary>Per-asset OEE from cumulative stats. Pure; every ratio is clamped to [0,1] and never NaN.</summary>
    public static AssetKpi ComputeAsset(AssetStats s)
    {
        var ss = s.StateSeconds ?? StateBreakdown.Zero;
        var total = NonNeg(ss.Off) + NonNeg(ss.Idle) + NonNeg(ss.Running) + NonNeg(ss.Starved)
                    + NonNeg(ss.Blocked) + NonNeg(ss.Fault) + NonNeg(ss.Maintenance);
        var planned = NonNeg(total - NonNeg(ss.Off));
        var runTime = NonNeg(planned - NonNeg(ss.Fault) - NonNeg(ss.Maintenance));
        var count = Math.Max(0, s.Total);

        var availability = Ratio(runTime, planned, whenZero: 0);
        var performance = Ratio(NonNeg(s.IdealCycleTimeS) * count, runTime, whenZero: 0);
        var quality = Ratio(Math.Max(0, s.Good), count, whenZero: 1);
        var utilization = Ratio(NonNeg(ss.Running) + NonNeg(ss.Fault), total, whenZero: 0);

        var states = total > 0
            ? new StateBreakdown(
                Ratio(ss.Off, total, 0), Ratio(ss.Idle, total, 0), Ratio(ss.Running, total, 0),
                Ratio(ss.Starved, total, 0), Ratio(ss.Blocked, total, 0), Ratio(ss.Fault, total, 0),
                Ratio(ss.Maintenance, total, 0))
            : StateBreakdown.Zero;

        return new AssetKpi(
            s.AssetId,
            Oee: Clamp01(availability * performance * quality),
            Availability: availability,
            Performance: performance,
            Quality: quality,
            Utilization: utilization,
            Good: Math.Max(0, s.Good),
            Scrap: Math.Max(0, s.Scrap),
            States: states);
    }

    /// <summary>
    /// Highest active fraction (Running + Fault). Candidates within <see cref="BottleneckTieTolerance"/>
    /// of the best are tie-broken by the lowest Blocked fraction, then the highest active fraction,
    /// then plant order. Null when no machine-like asset has accumulated any time yet.
    /// </summary>
    public static AssetKpi? SelectBottleneck(IReadOnlyList<AssetKpi> assets)
    {
        var timed = assets.Where(a => a.States.Total > 0).ToList();
        if (timed.Count == 0) return null;

        var maxActive = timed.Max(Active);
        AssetKpi? best = null;
        foreach (var a in timed)
        {
            if (Active(a) < maxActive - BottleneckTieTolerance - 1e-12) continue;
            if (best is null
                || a.States.Blocked < best.States.Blocked
                || (a.States.Blocked == best.States.Blocked && Active(a) > Active(best)))
                best = a;
        }
        return best;
    }

    private static double Active(AssetKpi a) => a.States.Running + a.States.Fault;

    private double UpdateThroughput(long now, long sinkGood)
    {
        if (now > _samples[^1].T) _samples.Add((now, sinkGood));
        else if (now == _samples[^1].T && _samples.Count > 1) _samples[^1] = (now, sinkGood);
        _lastT = now;
        _lastGood = sinkGood;

        // Drop everything older than the newest sample at or before (now - window).
        var cutoff = now - WindowMs;
        var baseIdx = 0;
        for (var i = 1; i < _samples.Count && _samples[i].T <= cutoff; i++) baseIdx = i;
        if (baseIdx > 0) _samples.RemoveRange(0, baseIdx);

        if (now < MinElapsedMs) return 0;
        var (bt, bg) = _samples[0];
        var dtMs = now - bt;
        if (dtMs <= 0) return 0;
        var rate = (sinkGood - bg) * 3_600_000.0 / dtMs;
        return double.IsFinite(rate) && rate > 0 ? rate : 0;
    }

    internal static double Ratio(double num, double den, double whenZero)
    {
        if (!(den > 0) || !double.IsFinite(num) || !double.IsFinite(den)) return whenZero;
        return Clamp01(num / den);
    }

    internal static double Clamp01(double v) => double.IsNaN(v) ? 0 : Math.Clamp(v, 0, 1);
    private static double NonNeg(double v) => double.IsFinite(v) && v > 0 ? v : 0;
}
