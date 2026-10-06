using TwinLabs.Core.Contracts;
using static TwinLabs.Analytics.Tests.TestPlant;

namespace TwinLabs.Analytics.Tests;

public class WhatIfRunnerTests
{
    private static readonly PlantModel Plant = Create(seed: 42);

    /// <summary>
    /// Scripted engine: the sink produces 100 good/h (baseline) or 150 good/h once any override was applied.
    /// M1 has 2 scrap/h; WIP is 10 vs 12.
    /// </summary>
    private static void Script(FakeEngine e) => e.OnAdvance = eng =>
    {
        var h = eng.SimTimeMs / 3_600_000.0;
        var scenario = eng.ParamCalls.Count > 0;
        var good = (long)Math.Round((scenario ? 150 : 100) * h);
        var scrap = (long)Math.Round(2 * h);
        var secs = eng.SimTimeMs / 1000.0;
        eng.Wip = scenario ? 12 : 10;
        eng.Stats =
        [
            new("M1", States(running: secs * (scenario ? 0.9 : 0.8), starved: secs * (scenario ? 0.1 : 0.2)), good + scrap, good, scrap, 10),
            new("R1", States(running: secs * 0.5, starved: secs * 0.5), good, good, 0, 5),
            new("QC", States(running: secs * 0.3, starved: secs * 0.7), good, good, 0, 3),
            new("SNK", States(idle: secs), good, good, 0, 0),
        ];
    };

    private static WhatIfRequest Req(double durationS = 7200, int? seed = null, params WhatIfOverride[] o) =>
        new(durationS, o, seed);

    private static WhatIfOverride Ov(string id, string key, double v) => new(id, new Dictionary<string, double> { [key] = v });

    [Theory]
    [InlineData(59)]
    [InlineData(7 * 86400 + 1)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(-100)]
    public void Validation_RejectsBadDuration(double durationS)
    {
        var f = new FakeFactory();
        var ex = Assert.Throws<ArgumentException>(() => new WhatIfRunner(f).Run(Req(durationS), Plant));
        Assert.Contains("durationS", ex.Message);
        Assert.Empty(f.Created);
    }

    [Fact]
    public void Validation_AcceptsDurationBounds()
    {
        var f = new FakeFactory(Script);
        new WhatIfRunner(f).Run(Req(60), Plant);
        new WhatIfRunner(f).Run(Req(7 * 86400), Plant);
        Assert.Equal(4, f.Created.Count);
    }

    [Fact]
    public void Validation_RejectsUnknownAsset()
    {
        var f = new FakeFactory();
        var ex = Assert.Throws<ArgumentException>(() =>
            new WhatIfRunner(f).Run(Req(3600, null, Ov("NOPE-01", "cycleTimeS", 10)), Plant));
        Assert.Contains("NOPE-01", ex.Message);
        Assert.Empty(f.Created);
    }

    [Fact]
    public void Validation_EngineRejectionBecomesArgumentException()
    {
        var f = new FakeFactory(e => e.ValidateParams = (id, p) =>
        {
            if (p.TryGetValue("cycleTimeS", out var v) && v <= 0)
                throw new ArgumentOutOfRangeException("cycleTimeS", v, "cycleTimeS must be > 0");
        });
        var ex = Assert.Throws<ArgumentException>(() =>
            new WhatIfRunner(f).Run(Req(3600, null, Ov("M1", "cycleTimeS", -1)), Plant));
        Assert.Contains("M1", ex.Message);
        Assert.Contains("cycleTimeS must be > 0", ex.Message);
        Assert.All(f.Created, c => Assert.Empty(c.Engine.AdvanceCalls)); // failed before running
    }

    [Fact]
    public void Overrides_AppliedOnlyToScenario_SameSeed_FullDuration()
    {
        var f = new FakeFactory(Script);
        var r = new WhatIfRunner(f).Run(
            Req(7200, 7, Ov("M1", "cycleTimeS", 40), Ov("BUF", "capacity", 30)), Plant);

        Assert.Equal(2, f.Created.Count);
        Assert.All(f.Created, c => Assert.Equal(7, c.Seed));
        Assert.All(f.Created, c => Assert.Same(Plant, c.Plant));
        Assert.Equal(7, r.Seed);

        var withCalls = f.Created.Where(c => c.Engine.ParamCalls.Count > 0).ToList();
        var scenario = Assert.Single(withCalls).Engine;
        Assert.Equal(["M1", "BUF"], scenario.ParamCalls.Select(p => p.AssetId));
        Assert.Equal(40, scenario.ParamCalls[0].Changes["cycleTimeS"]);

        Assert.All(f.Created, c =>
            Assert.Equal(TimeSpan.FromSeconds(7200), c.Engine.AdvanceCalls.Aggregate(TimeSpan.Zero, (a, b) => a + b)));
        Assert.Equal(7200, r.DurationS);
        Assert.Equal(7_200_000, r.Baseline.SimTimeMs);
        Assert.Equal(7_200_000, r.Scenario.SimTimeMs);
        Assert.True(r.ElapsedMs >= 0);
    }

    [Fact]
    public void Seed_DefaultsToPlantSeed()
    {
        var f = new FakeFactory(Script);
        var r = new WhatIfRunner(f).Run(Req(600), Plant);
        Assert.Equal(42, r.Seed);
        Assert.All(f.Created, c => Assert.Equal(42, c.Seed));
    }

    [Fact]
    public void Deltas_AreCorrect()
    {
        var f = new FakeFactory(Script);
        var r = new WhatIfRunner(f).Run(Req(7200, null, Ov("M1", "cycleTimeS", 40)), Plant);

        Assert.Equal(WhatIfRunner.Metrics, r.Deltas.Select(d => d.Metric));
        KpiDelta D(string m) => r.Deltas.Single(d => d.Metric == m);

        var good = D("good");
        Assert.Equal(200, good.Baseline);
        Assert.Equal(300, good.Scenario);
        Assert.Equal(100, good.Delta);
        Assert.Equal(50, good.DeltaPct, 9);

        // Last hour's rate (warm-up excluded): 100/h vs 150/h.
        var tp = D("throughputPerHour");
        Assert.Equal(100, tp.Baseline, 6);
        Assert.Equal(150, tp.Scenario, 6);
        Assert.Equal(50, tp.DeltaPct, 6);

        var wip = D("wip");
        Assert.Equal(10, wip.Baseline);
        Assert.Equal(2, wip.Delta);
        Assert.Equal(20, wip.DeltaPct, 9);

        // Bottleneck is M1 in both: A = 1, P = 10 × total / run time.
        var oee = D("oee");
        Assert.Equal(r.Baseline.Line.Oee, oee.Baseline);
        Assert.Equal(r.Scenario.Line.Oee - r.Baseline.Line.Oee, oee.Delta, 12);
        Assert.Equal(oee.Delta / oee.Baseline * 100, oee.DeltaPct, 9);
        Assert.Equal("M1", r.Baseline.Line.BottleneckAssetId);

        // Each delta is consistent.
        Assert.All(r.Deltas, d => Assert.Equal(d.Scenario - d.Baseline, d.Delta, 12));
    }

    [Fact]
    public void Deltas_ZeroBaseline_GivesZeroPct()
    {
        var b = new LineKpi(0, 0, 0, 1, 0, 0, 0, 0, null);
        var s = b with { Good = 5, Scrap = 1 };
        var d = WhatIfRunner.BuildDeltas(b, s);
        Assert.All(d, x => Assert.True(double.IsFinite(x.DeltaPct)));
        Assert.Equal(0, d.Single(x => x.Metric == "good").DeltaPct);
        Assert.Equal(5, d.Single(x => x.Metric == "good").Delta);
    }

    [Fact]
    public void ShortRun_UsesSingleAdvance_AndAverageThroughput()
    {
        var f = new FakeFactory(Script);
        var r = new WhatIfRunner(f).Run(Req(1800), Plant);
        Assert.All(f.Created, c => Assert.Equal([TimeSpan.FromSeconds(1800)], c.Engine.AdvanceCalls));
        Assert.Equal(100, r.Baseline.Line.ThroughputPerHour, 6); // 50 good / 0.5 h
    }

    [Fact]
    public void NoOverrides_ScenarioEqualsBaseline()
    {
        var f = new FakeFactory(Script);
        var r = new WhatIfRunner(f).Run(new WhatIfRequest(3600, []), Plant);
        Assert.All(r.Deltas, d => Assert.Equal(0, d.Delta));
    }
}
