using System.Diagnostics;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Analytics;

/// <summary>
/// Headless baseline-vs-scenario comparison (docs/V1-Spec.md §3). Builds two fresh engines with the
/// same seed, applies overrides to the scenario only, runs both in parallel and diffs the line KPIs.
/// Stateless and thread-safe as long as the factory is.
/// </summary>
public sealed class WhatIfRunner(ISimulationEngineFactory factory) : IWhatIfRunner
{
    public const double MinDurationS = 60;
    public const double MaxDurationS = 7 * 86400;

    /// <summary>Metrics reported in <see cref="WhatIfResult.Deltas"/>, in this order.</summary>
    public static readonly IReadOnlyList<string> Metrics =
        ["oee", "availability", "performance", "quality", "throughputPerHour", "good", "scrap", "wip"];

    private readonly ISimulationEngineFactory _factory = factory ?? throw new ArgumentNullException(nameof(factory));

    public WhatIfResult Run(WhatIfRequest request, PlantModel basePlant)
    {
        var sw = Stopwatch.StartNew();
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(basePlant);
        var overrides = Validate(request, basePlant);
        var seed = request.Seed ?? basePlant.Seed;

        var baseline = _factory.Create(basePlant, seed);
        var scenario = _factory.Create(basePlant, seed);
        ApplyOverrides(scenario, overrides);

        var duration = TimeSpan.FromSeconds(request.DurationS);
        KpiReport? baseReport = null, scenReport = null;
        Parallel.Invoke(
            () => baseReport = RunHeadless(baseline, duration),
            () => scenReport = RunHeadless(scenario, duration));

        var deltas = BuildDeltas(baseReport!, scenReport!);
        sw.Stop();
        return new WhatIfResult(request.DurationS, seed, baseReport, scenReport, deltas, sw.ElapsedMilliseconds);
    }

    /// <summary>
    /// Runs the engine for <paramref name="duration"/> and computes KPIs with a fresh calculator.
    /// For runs longer than the 1 h throughput window the run is split so the calculator gets a sample
    /// one window before the end: throughputPerHour is then the last hour's rate (warm-up excluded),
    /// matching what the live console shows. Shorter runs report good / elapsed hours.
    /// </summary>
    public static KpiReport RunHeadless(ISimulationEngine engine, TimeSpan duration)
    {
        var kpi = new KpiCalculator();
        var window = TimeSpan.FromMilliseconds(KpiCalculator.WindowMs);
        if (duration > window)
        {
            engine.Advance(duration - window);
            kpi.Compute(engine);
            engine.Advance(window);
        }
        else
        {
            engine.Advance(duration);
        }
        return kpi.Compute(engine);
    }

    public static IReadOnlyList<KpiDelta> BuildDeltas(LineKpi b, LineKpi s) =>
        Metrics.Select(m => Delta(m, Value(b, m), Value(s, m))).ToList();

    /// <summary>
    /// The line <see cref="Metrics"/> followed, when the plant has resources, by one
    /// <c>resource:&lt;id&gt;:utilization</c> delta per resource (baseline order, then any scenario-only ids;
    /// a resource missing from one side counts as 0 there).
    /// </summary>
    public static IReadOnlyList<KpiDelta> BuildDeltas(KpiReport b, KpiReport s)
    {
        ArgumentNullException.ThrowIfNull(b);
        ArgumentNullException.ThrowIfNull(s);
        var deltas = BuildDeltas(b.Line, s.Line).ToList();
        if (b.Resources is null && s.Resources is null) return deltas;

        var ids = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in (b.Resources ?? []).Concat(s.Resources ?? []))
            if (seen.Add(r.ResourceId)) ids.Add(r.ResourceId);

        static double Util(KpiReport k, string id) =>
            k.Resources?.FirstOrDefault(r => r.ResourceId == id)?.Utilization ?? 0;
        foreach (var id in ids)
            deltas.Add(Delta(ResourceUtilizationMetric(id), Util(b, id), Util(s, id)));
        return deltas;
    }

    public static string ResourceUtilizationMetric(string resourceId) => $"resource:{resourceId}:utilization";

    private static KpiDelta Delta(string metric, double baseline, double scenario)
    {
        var delta = scenario - baseline;
        var pct = baseline != 0 ? delta / baseline * 100 : 0;
        return new KpiDelta(metric, baseline, scenario, delta, pct);
    }

    private static double Value(LineKpi k, string metric) => metric switch
    {
        "oee" => k.Oee,
        "availability" => k.Availability,
        "performance" => k.Performance,
        "quality" => k.Quality,
        "throughputPerHour" => k.ThroughputPerHour,
        "good" => k.Good,
        "scrap" => k.Scrap,
        "wip" => k.Wip,
        _ => throw new ArgumentOutOfRangeException(nameof(metric), metric, null),
    };

    private static IReadOnlyList<WhatIfOverride> Validate(WhatIfRequest r, PlantModel plant)
    {
        if (!double.IsFinite(r.DurationS) || r.DurationS < MinDurationS || r.DurationS > MaxDurationS)
            throw new ArgumentException(
                $"durationS must be between {MinDurationS} and {MaxDurationS} sim seconds (got {r.DurationS}).",
                nameof(r.DurationS));

        var ids = new HashSet<string>(plant.Assets.Select(a => a.Id), StringComparer.Ordinal);
        var overrides = r.Overrides ?? [];
        for (var i = 0; i < overrides.Count; i++)
        {
            var o = overrides[i] ?? throw new ArgumentException($"overrides[{i}] is null.", nameof(r.Overrides));
            if (string.IsNullOrWhiteSpace(o.AssetId))
                throw new ArgumentException($"overrides[{i}].assetId is required.", nameof(r.Overrides));
            if (!ids.Contains(o.AssetId))
                throw new ArgumentException($"overrides[{i}]: unknown asset '{o.AssetId}' in plant '{plant.Id}'.", nameof(r.Overrides));
            if (o.Params is null)
                throw new ArgumentException($"overrides[{i}] ({o.AssetId}): params is required.", nameof(r.Overrides));
            foreach (var (k, v) in o.Params)
                if (!double.IsFinite(v))
                    throw new ArgumentException($"overrides[{i}] ({o.AssetId}): param '{k}' must be a finite number.", nameof(r.Overrides));
        }
        return overrides;
    }

    private static void ApplyOverrides(ISimulationEngine engine, IReadOnlyList<WhatIfOverride> overrides)
    {
        foreach (var o in overrides)
        {
            if (o.Params.Count == 0) continue;
            try
            {
                engine.UpdateParams(o.AssetId, o.Params);
            }
            catch (Exception ex) when (ex is ArgumentException or KeyNotFoundException or InvalidOperationException)
            {
                throw new ArgumentException($"Invalid override for '{o.AssetId}': {ex.Message}", "overrides", ex);
            }
        }
    }
}
