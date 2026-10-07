using System.Text.Json;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using static TwinLabs.Analytics.Tests.TestPlant;

namespace TwinLabs.Analytics.Tests;

/// <summary>v0.3: per-line KPIs, resource KPIs, shifts and what-if (docs/V0.3-PlantBuilder.md §2).</summary>
public class KpiV03Tests
{
    private const double Eps = 1e-9;
    private static readonly Vec3 V = new(0, 0, 0);

    private static AssetDef In(string line, string id, AssetKind kind, params string[] downstream) =>
        Asset(id, kind, downstream) with { LineId = line };

    /// <summary>
    /// line-a: SRC-A → A1 (machine) → A2 (robot) → SNK-A
    /// line-b: SRC-B → B1 (machine) → B2 (inspection) → SNK-B
    /// unlined: X1 (machine) → SNK-X
    /// </summary>
    private static PlantModel TwoLines(IReadOnlyList<ResourceDef>? resources = null) => new(
        "two", "Two lines", 1, 42,
        [
            In("line-a", "SRC-A", AssetKind.Source, "A1"),
            In("line-a", "A1", AssetKind.Machine, "A2"),
            In("line-a", "A2", AssetKind.Robot, "SNK-A"),
            In("line-a", "SNK-A", AssetKind.Sink),
            In("line-b", "SRC-B", AssetKind.Source, "B1"),
            In("line-b", "B1", AssetKind.Machine, "B2"),
            In("line-b", "B2", AssetKind.Inspection, "SNK-B"),
            In("line-b", "SNK-B", AssetKind.Sink),
            Asset("X1", AssetKind.Machine, "SNK-X"),
            Asset("SNK-X", AssetKind.Sink),
        ],
        [],
        Lines: [new LineDef("line-a", "Line A"), new LineDef("line-b", "Line B")],
        Resources: resources);

    private static List<AssetStats> TwoLineStats() =>
    [
        new("A1", States(running: 500, starved: 500), 50, 48, 2, 10),
        new("A2", States(running: 900, fault: 50, starved: 50), 48, 45, 3, 18),
        new("SNK-A", States(idle: 1000), 45, 45, 0, 0),
        new("B1", States(running: 950, blocked: 50), 95, 90, 5, 10),
        new("B2", States(running: 400, starved: 600), 90, 80, 10, 4),
        new("SNK-B", States(idle: 1000), 80, 80, 0, 0),
        new("X1", States(running: 990, fault: 10), 99, 99, 0, 10),
        new("SNK-X", States(idle: 1000), 99, 99, 0, 0),
    ];

    [Fact]
    public void TwoLines_EachGetOwnBottleneckQualityAndThroughput()
    {
        var e = new FakeEngine(TwoLines())
        {
            SimTimeMs = 1_000_000,
            Wip = 17,
            Stats = TwoLineStats(),
            States =
            [
                new("A1", AssetStateKind.Running, 0, 0, 0, 2, 0, 0, 0),
                new("A2", AssetStateKind.Running, 0, 0, 0, 1, 0, 0, 0),
                new("B1", AssetStateKind.Running, 0, 0, 0, 3, 0, 0, 0),
                new("B2", AssetStateKind.Running, 0, 0, 0, 1, 0, 0, 0),
                new("X1", AssetStateKind.Running, 0, 0, 0, 9, 0, 0, 0),
            ],
        };

        var r = new KpiCalculator().Compute(e);

        Assert.NotNull(r.Lines);
        Assert.Equal(["line-a", "line-b"], r.Lines!.Select(l => l.LineId));
        var a = r.Lines[0].Kpi;
        var b = r.Lines[1].Kpi;

        // line-a: A2 active 0.95 vs A1 0.5 → A2.
        Assert.Equal("A2", a.BottleneckAssetId);
        var a2 = r.Assets.Single(x => x.AssetId == "A2");
        Assert.Equal(45, a.Good);
        Assert.Equal(5, a.Scrap);
        Assert.Equal(45.0 / 50, a.Quality, Eps);
        Assert.Equal(a2.Availability, a.Availability);
        Assert.Equal(a2.Performance, a.Performance);
        Assert.Equal(a2.Availability * a2.Performance * 0.9, a.Oee, Eps);
        Assert.Equal(3, a.Wip);
        Assert.Equal(45 * 3600.0 / 1000, a.ThroughputPerHour, 6);

        // line-b: B1 active 0.95 vs B2 0.4 → B1.
        Assert.Equal("B1", b.BottleneckAssetId);
        Assert.Equal(80, b.Good);
        Assert.Equal(15, b.Scrap);
        Assert.Equal(80.0 / 95, b.Quality, Eps);
        Assert.Equal(4, b.Wip);
        Assert.Equal(80 * 3600.0 / 1000, b.ThroughputPerHour, 6);

        // Whole plant still covers everything, including the unlined X1 (active 1.0 → bottleneck).
        Assert.Equal("X1", r.Line.BottleneckAssetId);
        Assert.Equal(45 + 80 + 99, r.Line.Good);
        Assert.Equal(20, r.Line.Scrap);
        Assert.Equal(17, r.Line.Wip);
        Assert.Contains(r.Assets, x => x.AssetId == "X1");
    }

    [Fact]
    public void UnlinedAssets_ExcludedFromEveryLine()
    {
        var stats = TwoLineStats();
        // Make the unlined X1 the worst scrapper and busiest asset; no line may see it.
        stats[6] = new("X1", States(running: 1000), 200, 100, 100, 10);
        var e = new FakeEngine(TwoLines())
        {
            SimTimeMs = 1_000_000,
            Stats = stats,
            States = [new("X1", AssetStateKind.Running, 0, 0, 0, 50, 0, 0, 0)],
        };

        var r = new KpiCalculator().Compute(e);

        Assert.All(r.Lines!, l => Assert.NotEqual("X1", l.Kpi.BottleneckAssetId));
        Assert.All(r.Lines!, l => Assert.Equal(0, l.Kpi.Wip));
        Assert.Equal(5, r.Lines![0].Kpi.Scrap);
        Assert.Equal(15, r.Lines[1].Kpi.Scrap);
        Assert.Equal(120, r.Line.Scrap);
        Assert.Equal("X1", r.Line.BottleneckAssetId);
    }

    [Fact]
    public void LineWithoutSink_UsesLastMachineInFlowOrder()
    {
        // Plant order deliberately differs from flow order: C2 is declared first but is downstream of C1.
        var plant = new PlantModel("nosink", "No sink", 1, 1,
        [
            In("line-c", "C2", AssetKind.Robot, "SNK"),
            In("line-c", "SRC", AssetKind.Source, "C1"),
            In("line-c", "C1", AssetKind.Machine, "C2"),
            Asset("SNK", AssetKind.Sink),
        ], [], Lines: [new LineDef("line-c", "C")]);
        var e = new FakeEngine(plant)
        {
            SimTimeMs = 1_800_000,
            Stats =
            [
                new("C1", States(running: 1500, starved: 300), 100, 95, 5, 10),
                new("C2", States(running: 1700, starved: 100), 95, 90, 5, 15),
                new("SNK", States(idle: 1800), 90, 90, 0, 0),
            ],
        };

        var c = new KpiCalculator().Compute(e).Lines!.Single().Kpi;

        Assert.Equal(90, c.Good); // C2's good, not C1's 95 and not the unlined sink
        Assert.Equal(10, c.Scrap);
        Assert.Equal(90.0 / 100, c.Quality, Eps);
        Assert.Equal(180, c.ThroughputPerHour, 6); // 90 in 0.5 h
        Assert.Equal("C2", c.BottleneckAssetId);
        Assert.Equal(["SRC", "C1", "C2", "SNK"], KpiCalculator.FlowOrder(plant.Assets).Select(a => a.Id));
    }

    [Fact]
    public void LineWithoutMachines_OeeZeroAndNullBottleneck()
    {
        var plant = new PlantModel("nom", "No machines", 1, 1,
        [
            In("feed", "SRC", AssetKind.Source, "BUF"),
            In("feed", "BUF", AssetKind.Buffer, "M1"),
            Asset("M1", AssetKind.Machine, "SNK"),
            Asset("SNK", AssetKind.Sink),
        ], [], Lines: [new LineDef("feed", "Feed"), new LineDef("empty", "Nothing assigned")]);
        var e = new FakeEngine(plant)
        {
            SimTimeMs = 600_000,
            Stats = [new("M1", States(running: 600), 50, 50, 0, 10), new("SNK", StateBreakdown.Zero, 50, 50, 0, 0)],
            States = [new("BUF", AssetStateKind.Idle, 0, 0, 0, 6, 0, 0, 0)],
        };

        var r = new KpiCalculator().Compute(e);

        Assert.Equal(2, r.Lines!.Count);
        var feed = r.Lines[0].Kpi;
        Assert.Equal(0, feed.Oee);
        Assert.Null(feed.BottleneckAssetId);
        Assert.Equal(0, feed.Good);
        Assert.Equal(1, feed.Quality);
        Assert.Equal(0, feed.ThroughputPerHour);
        Assert.Equal(6, feed.Wip);
        var empty = r.Lines[1].Kpi;
        Assert.Equal(new LineKpi(0, 0, 0, 1, 0, 0, 0, 0, null), empty);
    }

    [Fact]
    public void LineThroughput_IsRollingWindowPerLine()
    {
        var e = new FakeEngine(TwoLines());
        var k = new KpiCalculator();
        KpiReport r = null!;
        // line-a: 60/h for hour 1 then 120/h; line-b: steady 30/h.
        for (var m = 0; m <= 120; m++)
        {
            long ga = m <= 60 ? m : 60 + (m - 60) * 2;
            long gb = m / 2;
            e.SimTimeMs = m * 60_000L;
            e.Stats = [new("SNK-A", StateBreakdown.Zero, ga, ga, 0, 0), new("SNK-B", StateBreakdown.Zero, gb, gb, 0, 0)];
            r = k.Compute(e);
            if (m == 60) Assert.Equal(60, r.Lines![0].Kpi.ThroughputPerHour, 6);
        }
        Assert.Equal(120, r.Lines![0].Kpi.ThroughputPerHour, 6);
        Assert.Equal(30, r.Lines[1].Kpi.ThroughputPerHour, 6);
        Assert.Equal(150, r.Line.ThroughputPerHour, 6);
    }

    [Fact]
    public void Resources_UtilizationMath()
    {
        var plant = TwoLines([
            new ResourceDef("ops", "Operators", ResourceKind.Operator, 2),
            new ResourceDef("agv", "AGVs", ResourceKind.Agv, 3),
            new ResourceDef("tool", "Tool", ResourceKind.Tool, 1),
        ]);
        var e = new FakeEngine(plant)
        {
            SimTimeMs = 1_000_000, // 1000 s
            ResourceStats =
            [
                new("ops", 2, 1500, 412.5),   // 1500 / (2 × 1000) = 0.75
                new("agv", 3, 9999, -5),      // > 1 → clamped; negative wait → 0
                new("ghost", 1, 10, 10),      // not declared → ignored
            ],
        };

        var res = new KpiCalculator().Compute(e).Resources!;

        Assert.Equal(["ops", "agv", "tool"], res.Select(x => x.ResourceId));
        Assert.Equal(new ResourceKpi("ops", 2, 0.75, 412.5), res[0]);
        Assert.Equal(1, res[1].Utilization);
        Assert.Equal(0, res[1].WaitSeconds);
        Assert.Equal(new ResourceKpi("tool", 1, 0, 0), res[2]); // no stats yet → plant count, zeros
    }

    [Fact]
    public void Resources_ZeroElapsed_NoNaN()
    {
        var def = new ResourceDef("ops", "Operators", ResourceKind.Operator, 2);
        var k = KpiCalculator.ComputeResource(def, new ResourceStats("ops", 2, 0, 0), 0);
        Assert.Equal(0, k.Utilization);
        Assert.Equal(0, KpiCalculator.ComputeResource(def, new ResourceStats("ops", 2, 5, 0), 0).Utilization);
        Assert.Equal(0, KpiCalculator.ComputeResource(def with { Count = 0 }, null, 1000).Utilization);
        Assert.Equal(0, KpiCalculator.ComputeResource(def, new ResourceStats("ops", 2, double.NaN, double.PositiveInfinity), 1000).Utilization);

        var e = new FakeEngine(TwoLines([def]));
        var r = new KpiCalculator().Compute(e);
        Assert.Equal(new ResourceKpi("ops", 2, 0, 0), Assert.Single(r.Resources!));
    }

    [Fact]
    public void LinesAndResources_NullWhenAbsent_OmittedFromJson()
    {
        var e = new FakeEngine(Create())
        {
            SimTimeMs = 120_000,
            ResourceStats = [new("ops", 1, 10, 0)], // engine data without plant resources is ignored
        };
        var r = new KpiCalculator().Compute(e);
        Assert.Null(r.Lines);
        Assert.Null(r.Resources);
        Assert.Equal(0, e.ResourceStatsCalls);

        using var doc = JsonDocument.Parse(TwinJson.Serialize(r));
        Assert.False(doc.RootElement.TryGetProperty("lines", out _));
        Assert.False(doc.RootElement.TryGetProperty("resources", out _));
        Assert.True(doc.RootElement.TryGetProperty("line", out _));

        // Empty lists count as absent too.
        e.Plant = Create() with { Lines = [], Resources = [] };
        var r2 = new KpiCalculator().Compute(e);
        Assert.Null(r2.Lines);
        Assert.Null(r2.Resources);
    }

    [Fact]
    public void LinesAndResources_SerializeLikeExample()
    {
        var e = new FakeEngine(TwoLines([new ResourceDef("op-pool", "Operators", ResourceKind.Operator, 2)]))
        {
            SimTimeMs = 1_000_000,
            Stats = TwoLineStats(),
            ResourceStats = [new("op-pool", 2, 1620, 412.5)],
        };
        var json = TwinJson.Serialize(new KpiCalculator().Compute(e));
        using var doc = JsonDocument.Parse(json);
        var lines = doc.RootElement.GetProperty("lines");
        Assert.Equal(2, lines.GetArrayLength());
        Assert.Equal("line-a", lines[0].GetProperty("lineId").GetString());
        Assert.Equal("A2", lines[0].GetProperty("kpi").GetProperty("bottleneckAssetId").GetString());
        var res = doc.RootElement.GetProperty("resources")[0];
        Assert.Equal("op-pool", res.GetProperty("resourceId").GetString());
        Assert.Equal(2, res.GetProperty("count").GetInt32());
        Assert.Equal(0.81, res.GetProperty("utilization").GetDouble(), 9);
        Assert.Equal(412.5, res.GetProperty("waitSeconds").GetDouble());
    }

    [Fact]
    public void Plant_WithoutLinesOrResources_WholeLineUnchanged()
    {
        // Same stats with and without v0.3 decorations: the whole-plant KPI must not move.
        var stats = new List<AssetStats>
        {
            new("M1", States(running: 600, starved: 300, fault: 100), 60, 55, 5, 10),
            new("R1", States(running: 900, fault: 100), 100, 98, 2, 8),
            new("QC", States(running: 300, starved: 700), 95, 92, 3, 3),
            new("SNK", States(idle: 1000), 90, 90, 0, 0),
        };
        var plain = new KpiCalculator().Compute(new FakeEngine(Create()) { SimTimeMs = 1_000_000, Wip = 7, Stats = stats });
        var decorated = Create() with
        {
            Assets = Create().Assets.Select((a, i) => i < 3 ? a with { LineId = "L" } : a).ToList(),
            Lines = [new LineDef("L", "L")],
            Resources = [new ResourceDef("ops", "Ops", ResourceKind.Operator, 1)],
        };
        var withV03 = new KpiCalculator().Compute(new FakeEngine(decorated) { SimTimeMs = 1_000_000, Wip = 7, Stats = stats });

        Assert.Equal(plain.Line, withV03.Line);
        Assert.Equal(plain.Assets, withV03.Assets);
        Assert.Null(plain.Lines);
        Assert.NotNull(withV03.Lines);
    }

    [Fact]
    public void OffShiftMachine_NoNaN_NotBottleneck()
    {
        // B2 is on a night shift that has not started yet: Off for its whole elapsed time.
        var stats = TwoLineStats();
        stats[4] = new("B2", States(off: 1000), 0, 0, 0, 4);
        stats[3] = new("B1", States(running: 3, blocked: 997), 0, 0, 0, 10); // near-zero active, would tie with B2
        var e = new FakeEngine(TwoLines()) { SimTimeMs = 1_000_000, Stats = stats };

        var r = new KpiCalculator().Compute(e);

        var b2 = r.Assets.Single(a => a.AssetId == "B2");
        foreach (var v in new[] { b2.Oee, b2.Availability, b2.Performance, b2.Quality, b2.Utilization })
            Assert.True(double.IsFinite(v) && v >= 0 && v <= 1, $"value {v}");
        Assert.Equal(0, b2.Availability);
        Assert.Equal(1, b2.States.Off, Eps);
        Assert.Equal("B1", r.Lines![1].Kpi.BottleneckAssetId); // B2 has the lower Blocked but no planned time
        Assert.NotEqual("B2", r.Line.BottleneckAssetId);

        // A line whose only machine is entirely off shift: no bottleneck, OEE 0, nothing NaN.
        var plant = new PlantModel("night", "Night", 1, 1,
            [In("n", "SRC", AssetKind.Source, "N1"), In("n", "N1", AssetKind.Machine, "SNK"), In("n", "SNK", AssetKind.Sink)],
            [], Lines: [new LineDef("n", "Night")]);
        var r2 = new KpiCalculator().Compute(new FakeEngine(plant)
        {
            SimTimeMs = 3_600_000,
            Stats = [new("N1", States(off: 3600), 0, 0, 0, 30)],
        });
        Assert.Null(r2.Line.BottleneckAssetId);
        Assert.Null(r2.Lines![0].Kpi.BottleneckAssetId);
        Assert.Equal(0, r2.Lines[0].Kpi.Oee);
        Assert.Equal(0, r2.Line.Oee);
        Assert.Equal(1, r2.Line.Quality);
        Assert.DoesNotContain("NaN", TwinJson.Serialize(r2));
    }

    [Fact]
    public void OffTime_ExcludedFromPlannedTime()
    {
        // 8 h shift in 24 h: 16 h Off, 7.5 h running, 0.5 h fault → A = 7.5 / 8.
        var k = KpiCalculator.ComputeAsset(new AssetStats("M1",
            States(off: 16 * 3600, running: 7.5 * 3600, fault: 0.5 * 3600), 2700, 2700, 0, 10));
        Assert.Equal(7.5 / 8, k.Availability, Eps);
        Assert.Equal(2700 * 10 / (7.5 * 3600), k.Performance, Eps);
    }

    // ---- what-if ----

    private static void ScriptV03(FakeEngine e) => e.OnAdvance = eng =>
    {
        var secs = eng.SimTimeMs / 1000.0;
        var h = secs / 3600;
        var scenario = eng.ParamCalls.Count > 0;
        long ga = (long)Math.Round((scenario ? 80 : 60) * h), gb = (long)Math.Round(40 * h), gx = (long)Math.Round(10 * h);
        eng.Stats =
        [
            new("A1", States(running: secs * (scenario ? 0.8 : 0.6), starved: secs * (scenario ? 0.2 : 0.4)), ga, ga, 0, 10),
            new("A2", States(running: secs * 0.5, starved: secs * 0.5), ga, ga, 0, 10),
            new("SNK-A", StateBreakdown.Zero, ga, ga, 0, 0),
            new("B1", States(running: secs * 0.7, starved: secs * 0.3), gb, gb, 0, 10),
            new("B2", States(running: secs * 0.2, starved: secs * 0.8), gb, gb, 0, 10),
            new("SNK-B", StateBreakdown.Zero, gb, gb, 0, 0),
            new("X1", States(running: secs * 0.1, idle: secs * 0.9), gx, gx, 0, 10),
            new("SNK-X", StateBreakdown.Zero, gx, gx, 0, 0),
        ];
        // 2 operators: 50% busy in baseline, 75% in the scenario.
        eng.ResourceStats = [new("ops", 2, 2 * secs * (scenario ? 0.75 : 0.5), scenario ? 100 : 20)];
    };

    [Fact]
    public void WhatIf_CarriesLinesAndResources_AndResourceDeltas()
    {
        var plant = TwoLines([new ResourceDef("ops", "Operators", ResourceKind.Operator, 2)]);
        var f = new FakeFactory(ScriptV03);
        var r = new WhatIfRunner(f).Run(
            new WhatIfRequest(7200, [new WhatIfOverride("A1", new Dictionary<string, double> { ["cycleTimeS"] = 8 })]),
            plant);

        Assert.Equal(["line-a", "line-b"], r.Baseline.Lines!.Select(l => l.LineId));
        Assert.Equal(["line-a", "line-b"], r.Scenario.Lines!.Select(l => l.LineId));
        Assert.Equal(60, r.Baseline.Lines![0].Kpi.ThroughputPerHour, 6);
        Assert.Equal(80, r.Scenario.Lines![0].Kpi.ThroughputPerHour, 6);
        Assert.Equal("A1", r.Scenario.Lines[0].Kpi.BottleneckAssetId);
        Assert.Equal(0.5, Assert.Single(r.Baseline.Resources!).Utilization, 9);
        Assert.Equal(0.75, Assert.Single(r.Scenario.Resources!).Utilization, 9);

        // The v0.1 metrics first, unchanged, then one utilization delta per resource.
        Assert.Equal(WhatIfRunner.Metrics.Append("resource:ops:utilization"), r.Deltas.Select(d => d.Metric));
        var d = r.Deltas[^1];
        Assert.Equal(0.5, d.Baseline, 9);
        Assert.Equal(0.75, d.Scenario, 9);
        Assert.Equal(0.25, d.Delta, 9);
        Assert.Equal(50, d.DeltaPct, 6);
        Assert.Equal(WhatIfRunner.BuildDeltas(r.Baseline.Line, r.Scenario.Line), r.Deltas.Take(WhatIfRunner.Metrics.Count));
    }

    [Fact]
    public void WhatIf_WithoutResources_HasOnlyLineMetrics()
    {
        var f = new FakeFactory(ScriptV03);
        var r = new WhatIfRunner(f).Run(new WhatIfRequest(3600, []), TwoLines());
        Assert.Equal(WhatIfRunner.Metrics, r.Deltas.Select(d => d.Metric));
        Assert.NotNull(r.Baseline.Lines);
        Assert.Null(r.Baseline.Resources);
        Assert.Null(r.Scenario.Resources);
    }

    [Fact]
    public void ResourceDeltas_MissingSideCountsAsZero()
    {
        var line = new LineKpi(0, 0, 0, 1, 0, 0, 0, 0, null);
        var b = new KpiReport(0, line, [], Resources: [new ResourceKpi("a", 1, 0.4, 0)]);
        var s = new KpiReport(0, line, [], Resources: [new ResourceKpi("b", 1, 0.2, 0)]);
        var d = WhatIfRunner.BuildDeltas(b, s).Skip(WhatIfRunner.Metrics.Count).ToList();
        Assert.Equal(["resource:a:utilization", "resource:b:utilization"], d.Select(x => x.Metric));
        Assert.Equal(-0.4, d[0].Delta, 12);
        Assert.Equal(-100, d[0].DeltaPct, 9);
        Assert.Equal(0.2, d[1].Delta, 12);
        Assert.Equal(0, d[1].DeltaPct); // zero baseline
    }
}
