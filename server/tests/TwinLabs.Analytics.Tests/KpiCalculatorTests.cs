using TwinLabs.Core.Contracts;
using static TwinLabs.Analytics.Tests.TestPlant;

namespace TwinLabs.Analytics.Tests;

public class KpiCalculatorTests
{
    private const double Eps = 1e-9;

    private static void AssertFinite01(double v) => Assert.True(double.IsFinite(v) && v >= 0 && v <= 1, $"value {v}");

    [Fact]
    public void AssetOee_MatchesHandComputedCase()
    {
        // total 1000 s, off 100 → planned 900; fault+maint 100 → runTime 800
        var s = new AssetStats("M1", States(off: 100, running: 700, starved: 50, blocked: 50, fault: 80, maintenance: 20),
            Total: 70, Good: 63, Scrap: 7, IdealCycleTimeS: 10);

        var k = KpiCalculator.ComputeAsset(s);

        Assert.Equal(800.0 / 900, k.Availability, Eps);
        Assert.Equal(700.0 / 800, k.Performance, Eps);
        Assert.Equal(0.9, k.Quality, Eps);
        Assert.Equal(800.0 / 900 * 0.875 * 0.9, k.Oee, Eps);
        Assert.Equal(0.78, k.Utilization, Eps);
        Assert.Equal(0.7, k.States.Running, Eps);
        Assert.Equal(0.1, k.States.Off, Eps);
        Assert.Equal(1.0, k.States.Total, Eps);
        Assert.Equal(63, k.Good);
        Assert.Equal(7, k.Scrap);
    }

    [Fact]
    public void AssetOee_AllZero_NoNaN()
    {
        var k = KpiCalculator.ComputeAsset(new AssetStats("M1", StateBreakdown.Zero, 0, 0, 0, 10));

        Assert.Equal(0, k.Availability);
        Assert.Equal(0, k.Performance);
        Assert.Equal(1, k.Quality);
        Assert.Equal(0, k.Oee);
        Assert.Equal(0, k.Utilization);
        Assert.Equal(StateBreakdown.Zero, k.States);
    }

    [Fact]
    public void AssetOee_AllOff_PlannedZero()
    {
        var k = KpiCalculator.ComputeAsset(new AssetStats("M1", States(off: 500), 0, 0, 0, 10));
        Assert.Equal(0, k.Availability);
        Assert.Equal(0, k.Performance);
        Assert.Equal(1, k.States.Off, Eps);
    }

    [Fact]
    public void AssetOee_AllFault_RunTimeZero()
    {
        var k = KpiCalculator.ComputeAsset(new AssetStats("M1", States(fault: 100), 3, 3, 0, 10));
        Assert.Equal(0, k.Availability);
        Assert.Equal(0, k.Performance);
        Assert.Equal(1, k.Utilization, Eps);
    }

    [Fact]
    public void AssetOee_ClampsAndIgnoresGarbage()
    {
        // ideal 20 × 70 / 800 = 1.75 → clamped to 1
        var k = KpiCalculator.ComputeAsset(new AssetStats("M1", States(running: 800), 70, 80, -1, 20));
        Assert.Equal(1, k.Performance);
        Assert.Equal(1, k.Quality); // good > total clamped
        Assert.Equal(0, k.Scrap);

        var nan = KpiCalculator.ComputeAsset(new AssetStats("M1", States(running: double.NaN, idle: 10), 1, 1, 0, double.NaN));
        AssertFinite01(nan.Availability);
        AssertFinite01(nan.Performance);
        AssertFinite01(nan.Oee);
        AssertFinite01(nan.Utilization);
    }

    [Fact]
    public void Compute_AtTimeZero_DoesNotThrowOrNaN()
    {
        var e = new FakeEngine(Create());
        var r = new KpiCalculator().Compute(e);

        Assert.Equal(0, r.SimTimeMs);
        Assert.Equal(3, r.Assets.Count); // M1, R1, QC
        Assert.Equal(["M1", "R1", "QC"], r.Assets.Select(a => a.AssetId));
        Assert.Null(r.Line.BottleneckAssetId);
        Assert.Equal(0, r.Line.Oee);
        Assert.Equal(1, r.Line.Quality);
        Assert.Equal(0, r.Line.ThroughputPerHour);
        foreach (var a in r.Assets)
        {
            AssertFinite01(a.Oee);
            AssertFinite01(a.Availability);
            AssertFinite01(a.Performance);
        }
    }

    [Fact]
    public void Compute_LineKpis_UseBottleneckAAndPWithLineQuality()
    {
        var e = new FakeEngine(Create())
        {
            SimTimeMs = 1_000_000,
            Wip = 7,
            Stats =
            [
                new("M1", States(running: 600, starved: 300, fault: 100), 60, 55, 5, 10),
                new("R1", States(running: 900, fault: 100), 100, 98, 2, 8),
                new("QC", States(running: 300, starved: 700), 95, 92, 3, 3),
                new("SNK", States(idle: 1000), 90, 90, 0, 0),
                new("BUF", States(idle: 1000), 0, 0, 0, 0),
            ],
        };

        var r = new KpiCalculator().Compute(e);

        Assert.Equal("R1", r.Line.BottleneckAssetId);
        var r1 = r.Assets.Single(a => a.AssetId == "R1");
        Assert.Equal(0.9, r1.Availability, Eps);
        Assert.Equal(800.0 / 900, r1.Performance, Eps);
        Assert.Equal(90.0 / 100, r.Line.Quality, Eps); // 90 / (90 + 5 + 2 + 3)
        Assert.Equal(r1.Availability * r1.Performance * 0.9, r.Line.Oee, Eps);
        Assert.Equal(r1.Availability, r.Line.Availability);
        Assert.Equal(90, r.Line.Good);
        Assert.Equal(10, r.Line.Scrap);
        Assert.Equal(7, r.Line.Wip);
    }

    [Fact]
    public void Bottleneck_HighestActiveFraction()
    {
        var e = new FakeEngine(Create())
        {
            SimTimeMs = 100_000,
            Stats =
            [
                new("M1", States(running: 85, fault: 5, blocked: 10), 0, 0, 0, 1),
                new("R1", States(running: 80, starved: 20), 0, 0, 0, 1),
                new("QC", States(running: 10, starved: 90), 0, 0, 0, 1),
            ],
        };
        Assert.Equal("M1", new KpiCalculator().Compute(e).Line.BottleneckAssetId);
    }

    [Fact]
    public void Bottleneck_TieWithinTolerance_PicksLowestBlocked()
    {
        // M1 active 0.800 blocked 0.15; R1 active 0.795 (within 0.01) blocked 0.02 → R1.
        var e = new FakeEngine(Create())
        {
            SimTimeMs = 1_000_000,
            Stats =
            [
                new("M1", States(running: 750, fault: 50, blocked: 150, starved: 50), 0, 0, 0, 1),
                new("R1", States(running: 795, blocked: 20, starved: 185), 0, 0, 0, 1),
                new("QC", States(running: 100, starved: 900), 0, 0, 0, 1),
            ],
        };
        Assert.Equal("R1", new KpiCalculator().Compute(e).Line.BottleneckAssetId);

        // Outside tolerance (0.02 apart) the blocked fraction doesn't matter.
        e.Stats[1] = new("R1", States(running: 780, blocked: 20, starved: 200), 0, 0, 0, 1);
        Assert.Equal("M1", new KpiCalculator().Compute(e).Line.BottleneckAssetId);
    }

    [Fact]
    public void Throughput_ZeroBefore60s_ThenAverage_ThenRollingWindow()
    {
        var e = new FakeEngine(Create());
        long good = 0;
        e.Stats = [new("SNK", StateBreakdown.Zero, 0, 0, 0, 0)];
        void Set(long t, long g) { e.SimTimeMs = t; good = g; e.Stats[0] = new("SNK", StateBreakdown.Zero, g, g, 0, 0); }
        var k = new KpiCalculator();

        Set(30_000, 1);
        Assert.Equal(0, k.Compute(e).Line.ThroughputPerHour);

        Set(1_800_000, 50); // 50 good in 0.5 h
        Assert.Equal(100, k.Compute(e).Line.ThroughputPerHour, 6);

        // 1 Hz-ish sampling (every minute): 100/h for hour 1, 200/h for hour 2.
        var k2 = new KpiCalculator();
        for (var m = 0; m <= 120; m++)
        {
            var g = m <= 60 ? m * 100 / 60.0 : 100 + (m - 60) * 200 / 60.0;
            Set(m * 60_000L, (long)Math.Round(g));
            var r = k2.Compute(e);
            if (m == 60) Assert.Equal(100, r.Line.ThroughputPerHour, 6);
        }
        Assert.Equal(200, k2.Compute(e).Line.ThroughputPerHour, 6);
        Assert.Equal(300, good);
    }

    [Fact]
    public void Throughput_SingleSampleAfterLongRun_IsCumulativeAverage()
    {
        var e = new FakeEngine(Create())
        {
            SimTimeMs = 8 * 3_600_000L,
            Stats = [new("SNK", StateBreakdown.Zero, 800, 800, 0, 0)],
        };
        Assert.Equal(100, new KpiCalculator().Compute(e).Line.ThroughputPerHour, 6);
    }

    [Fact]
    public void Throughput_TimeGoingBackwards_AutoResets()
    {
        var e = new FakeEngine(Create());
        var k = new KpiCalculator();
        for (var m = 0; m <= 120; m++)
        {
            e.SimTimeMs = m * 60_000L;
            e.Stats = [new("SNK", StateBreakdown.Zero, m * 10, m * 10, 0, 0)]; // 600/h
            k.Compute(e);
        }
        Assert.Equal(600, k.Compute(e).Line.ThroughputPerHour, 6);

        // Engine reset, now 30 min in with 10 good → 20/h (stale samples would give 0 or garbage).
        e.SimTimeMs = 1_800_000;
        e.Stats = [new("SNK", StateBreakdown.Zero, 10, 10, 0, 0)];
        Assert.Equal(20, k.Compute(e).Line.ThroughputPerHour, 6);

        // Explicit Reset behaves the same.
        k.Reset();
        Assert.Equal(20, k.Compute(e).Line.ThroughputPerHour, 6);
    }
}
