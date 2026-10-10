using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Analytics;

/// <summary>
/// OEE / throughput / bottleneck calculator (docs/V1-Spec.md §3, docs/V0.3-PlantBuilder.md §2).
/// Stateful: keeps (simTime, good) samples for the rolling 1 h throughput window of the whole plant
/// and of every declared line, so use one instance per engine and call <see cref="Compute"/>
/// periodically (e.g. 1 Hz). Not thread-safe.
/// </summary>
public sealed class KpiCalculator : IKpiCalculator
{
    /// <summary>Rolling throughput window (sim ms).</summary>
    public const long WindowMs = 3_600_000;
    /// <summary>Throughput is reported as 0 until this much sim time has elapsed.</summary>
    public const long MinElapsedMs = 60_000;
    /// <summary>Active fractions within this distance of the best are a tie for bottleneck selection.</summary>
    public const double BottleneckTieTolerance = 0.01;

    private readonly ThroughputWindow _plantWindow = new();
    private readonly Dictionary<string, ThroughputWindow> _lineWindows = new(StringComparer.Ordinal);

    public KpiReport Compute(ISimulationEngine engine)
    {
        ArgumentNullException.ThrowIfNull(engine);

        var now = engine.SimTimeMs;
        var plant = engine.Plant;
        var stats = engine.GetAssetStats() ?? [];
        var byId = new Dictionary<string, AssetStats>(StringComparer.Ordinal);
        long scrap = 0;
        foreach (var s in stats)
        {
            if (s is null) continue;
            byId[s.AssetId] = s;
            scrap += Math.Max(0, s.Scrap);
        }

        var assetKpis = new List<AssetKpi>();
        var kpiById = new Dictionary<string, AssetKpi>(StringComparer.Ordinal);
        long sinkGood = 0;
        foreach (var a in plant.Assets)
        {
            if (a.Kind == AssetKind.Sink)
            {
                sinkGood += GoodOf(byId, a.Id);
            }
            else if (IsMachineLike(a.Kind))
            {
                var st = byId.TryGetValue(a.Id, out var x)
                    ? x
                    : new AssetStats(a.Id, StateBreakdown.Zero, 0, 0, 0, 0);
                var k = ComputeAsset(st);
                assetKpis.Add(k);
                kpiById.TryAdd(a.Id, k);
            }
        }

        // Time went backwards or the sink counter dropped: the engine was reset, start fresh windows.
        if (now < _plantWindow.LastT || sinkGood < _plantWindow.LastGood) Reset();
        var throughput = _plantWindow.Update(now, sinkGood);

        var line = BuildLineKpi(assetKpis, sinkGood, scrap, throughput, Math.Max(0, engine.Wip));
        var lines = plant.Lines is { Count: > 0 } defs
            ? ComputeLines(engine, plant, defs, byId, kpiById, now)
            : null;
        var resources = plant.Resources is { Count: > 0 } res
            ? ComputeResources(res, engine.GetResourceStats() ?? [], now)
            : null;

        return new KpiReport(now, line, assetKpis, lines, resources);
    }

    public void Reset()
    {
        _plantWindow.Reset();
        _lineWindows.Clear();
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
    /// then plant order. Assets with no planned time (no time at all, or Off for all of it, e.g. a
    /// shift asset that has never been on shift) are never candidates. Null when there is no candidate.
    /// </summary>
    public static AssetKpi? SelectBottleneck(IReadOnlyList<AssetKpi> assets)
    {
        var timed = assets.Where(HasPlannedTime).ToList();
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

    /// <summary>
    /// v0.3 resource KPI: utilization = busy unit-seconds / (count × elapsed sim seconds), clamped to [0,1];
    /// 0 when nothing has elapsed or the pool is empty. Count is the engine's when it reports one, else the plant's.
    /// </summary>
    public static ResourceKpi ComputeResource(ResourceDef def, ResourceStats? stats, long simTimeMs)
    {
        var count = stats is { Count: > 0 } ? stats.Count : Math.Max(0, def.Count);
        var elapsedS = Math.Max(0, simTimeMs) / 1000.0;
        var utilization = Ratio(NonNeg(stats?.BusySeconds ?? 0), count * elapsedS, whenZero: 0);
        return new ResourceKpi(def.Id, count, utilization, NonNeg(stats?.WaitSeconds ?? 0));
    }

    /// <summary>
    /// Plant assets in flow order: a topological sort of the Downstream graph, ties resolved by plant
    /// order, assets on cycles appended at the end in plant order. Unknown downstream ids are ignored.
    /// </summary>
    public static IReadOnlyList<AssetDef> FlowOrder(IReadOnlyList<AssetDef> assets)
    {
        var n = assets.Count;
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < n; i++) index.TryAdd(assets[i].Id, i);

        var edges = new List<int>[n];
        var indeg = new int[n];
        for (var i = 0; i < n; i++)
        {
            edges[i] = [];
            foreach (var d in assets[i].Downstream ?? [])
            {
                if (d is null || !index.TryGetValue(d, out var j) || j == i || edges[i].Contains(j)) continue;
                edges[i].Add(j);
                indeg[j]++;
            }
        }

        var done = new bool[n];
        var order = new List<AssetDef>(n);
        while (true)
        {
            var next = -1;
            for (var i = 0; i < n; i++)
                if (!done[i] && indeg[i] == 0) { next = i; break; }
            if (next < 0) break;
            done[next] = true;
            order.Add(assets[next]);
            foreach (var j in edges[next]) indeg[j]--;
        }
        for (var i = 0; i < n; i++)
            if (!done[i]) order.Add(assets[i]);
        return order;
    }

    private List<LineKpiEntry> ComputeLines(
        ISimulationEngine engine, PlantModel plant, IReadOnlyList<LineDef> defs,
        Dictionary<string, AssetStats> byId, Dictionary<string, AssetKpi> kpiById, long now)
    {
        var wipById = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var st in engine.GetAssetStates() ?? [])
            if (st is not null) wipById[st.Id] = Math.Max(0, st.Wip);

        IReadOnlyList<AssetDef>? flow = null;
        var entries = new List<LineKpiEntry>(defs.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var def in defs)
        {
            if (def is null) continue;
            var members = plant.Assets
                .Where(a => a.LineId is not null && string.Equals(a.LineId, def.Id, StringComparison.Ordinal))
                .ToList();

            var machines = members.Where(a => IsMachineLike(a.Kind) && kpiById.ContainsKey(a.Id))
                .Select(a => kpiById[a.Id]).ToList();
            long scrap = 0;
            var wip = 0;
            foreach (var a in members)
            {
                if (byId.TryGetValue(a.Id, out var s)) scrap += Math.Max(0, s.Scrap);
                if (wipById.TryGetValue(a.Id, out var w)) wip += w;
            }

            long good;
            var sinks = members.Where(a => a.Kind == AssetKind.Sink).ToList();
            if (sinks.Count > 0)
            {
                good = sinks.Sum(a => GoodOf(byId, a.Id));
            }
            else
            {
                // No sink in this line: its output is its most downstream machine-like asset.
                flow ??= FlowOrder(plant.Assets);
                var last = flow.LastOrDefault(a => IsMachineLike(a.Kind)
                                                   && string.Equals(a.LineId, def.Id, StringComparison.Ordinal));
                good = last is null ? 0 : GoodOf(byId, last.Id);
            }

            if (!_lineWindows.TryGetValue(def.Id, out var window))
                _lineWindows[def.Id] = window = new ThroughputWindow();
            double throughput;
            if (seen.Add(def.Id))
            {
                // This line's counter dropped (e.g. its sink was moved to another line): fresh window.
                if (good < window.LastGood || now < window.LastT) window.Reset();
                throughput = window.Update(now, good);
            }
            else
            {
                throughput = window.LastRate; // duplicate line id: same window, already updated this call
            }

            entries.Add(new LineKpiEntry(def.Id, BuildLineKpi(machines, good, scrap, throughput, wip)));
        }

        // Forget the windows of lines that no longer exist (plant edited).
        if (_lineWindows.Count > seen.Count)
            foreach (var id in _lineWindows.Keys.Where(k => !seen.Contains(k)).ToList())
                _lineWindows.Remove(id);
        return entries;
    }

    private static List<ResourceKpi> ComputeResources(
        IReadOnlyList<ResourceDef> defs, IReadOnlyList<ResourceStats> stats, long now)
    {
        var byId = new Dictionary<string, ResourceStats>(StringComparer.Ordinal);
        foreach (var s in stats)
            if (s is not null) byId.TryAdd(s.ResourceId, s);
        return defs.Where(d => d is not null)
            .Select(d => ComputeResource(d, byId.GetValueOrDefault(d.Id), now))
            .ToList();
    }

    private static LineKpi BuildLineKpi(IReadOnlyList<AssetKpi> machines, long good, long scrap, double throughput, int wip)
    {
        var bottleneck = SelectBottleneck(machines);
        var q = Ratio(good, good + scrap, whenZero: 1);
        var a = bottleneck?.Availability ?? 0;
        var p = bottleneck?.Performance ?? 0;
        return new LineKpi(
            Oee: Clamp01(a * p * q),
            Availability: a,
            Performance: p,
            Quality: q,
            ThroughputPerHour: throughput,
            Wip: wip,
            Good: good,
            Scrap: scrap,
            BottleneckAssetId: bottleneck?.AssetId);
    }

    private static long GoodOf(Dictionary<string, AssetStats> byId, string id) =>
        byId.TryGetValue(id, out var s) ? Math.Max(0, s.Good) : 0;

    private static bool HasPlannedTime(AssetKpi a) => a.States.Total > 0 && a.States.Total - a.States.Off > 1e-12;

    private static double Active(AssetKpi a) => a.States.Running + a.States.Fault;

    internal static double Ratio(double num, double den, double whenZero)
    {
        if (!(den > 0) || !double.IsFinite(num) || !double.IsFinite(den)) return whenZero;
        return Clamp01(num / den);
    }

    internal static double Clamp01(double v) => double.IsNaN(v) ? 0 : Math.Clamp(v, 0, 1);
    private static double NonNeg(double v) => double.IsFinite(v) && v > 0 ? v : 0;

    /// <summary>Rolling 1 h good-parts rate from cumulative (simTime, good) samples.</summary>
    private sealed class ThroughputWindow
    {
        // Samples ordered by time. Index 0 is always the window base: the newest sample at or before
        // (now - 1h), or the implicit origin (0, 0) because engine counters start at zero at t = 0.
        private readonly List<(long T, long Good)> _samples = [(0, 0)];

        public long LastT { get; private set; } = -1;
        public long LastGood { get; private set; }
        public double LastRate { get; private set; }

        public void Reset()
        {
            _samples.Clear();
            _samples.Add((0, 0));
            LastT = -1;
            LastGood = 0;
            LastRate = 0;
        }

        public double Update(long now, long good)
        {
            if (now > _samples[^1].T) _samples.Add((now, good));
            else if (now == _samples[^1].T && _samples.Count > 1) _samples[^1] = (now, good);
            LastT = now;
            LastGood = good;

            // Drop everything older than the newest sample at or before (now - window).
            var cutoff = now - WindowMs;
            var baseIdx = 0;
            for (var i = 1; i < _samples.Count && _samples[i].T <= cutoff; i++) baseIdx = i;
            if (baseIdx > 0) _samples.RemoveRange(0, baseIdx);

            return LastRate = Rate(now, good);
        }

        private double Rate(long now, long good)
        {
            if (now < MinElapsedMs) return 0;
            var (bt, bg) = _samples[0];
            var dtMs = now - bt;
            if (dtMs <= 0) return 0;
            var rate = (good - bg) * 3_600_000.0 / dtMs;
            return double.IsFinite(rate) && rate > 0 ? rate : 0;
        }
    }
}
