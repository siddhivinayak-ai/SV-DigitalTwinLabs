using System.Diagnostics;
using TwinLabs.Core.Contracts;
using Xunit.Abstractions;
using static TwinLabs.Simulation.Tests.TestPlant;

namespace TwinLabs.Simulation.Tests;

public class ResourceTests(ITestOutputHelper output)
{
    private static Dictionary<string, double> Machine(double cycleS) => P(("cycleTimeS", cycleS));

    /// <summary>SRC (every 5 s) → M1 | M2 (15 s, no faults) → SNK. <paramref name="operators"/> null = no resource.</summary>
    private static PlantModel TwoMachines(int? operators)
    {
        string? rid = operators is null ? null : "op";
        return Plant(
            [
                Asset("SRC", AssetKind.Source, ["M1", "M2"], P(("arrivalIntervalS", 5))),
                Asset("M1", AssetKind.Machine, ["SNK"], Machine(15), resourceId: rid),
                Asset("M2", AssetKind.Machine, ["SNK"], Machine(15), resourceId: rid),
                Asset("SNK", AssetKind.Sink, []),
            ],
            resources: operators is { } n ? [new ResourceDef("op", "Operators", ResourceKind.Operator, n)] : null);
    }

    private static ResourceStats Op(SimulationEngine e) => Assert.Single(e.GetResourceStats());

    [Fact]
    public void Shared_operator_limits_utilisation_and_throughput()
    {
        var one = new SimulationEngine(TwoMachines(1), 1);
        var two = new SimulationEngine(TwoMachines(2), 1);
        one.Advance(TimeSpan.FromHours(8));
        two.Advance(TimeSpan.FromHours(8));

        double elapsed = one.SimTimeMs / 1000.0;
        var s1 = Op(one);
        var s2 = Op(two);
        long g1 = one.State("SNK").Good, g2 = two.State("SNK").Good;
        output.WriteLine($"1 operator: {g1 / 8.0:F1}/h, busy {s1.BusySeconds:F0} unit-s ({s1.BusySeconds / elapsed:P1}), wait {s1.WaitSeconds:F0} s");
        output.WriteLine($"2 operators: {g2 / 8.0:F1}/h, busy {s2.BusySeconds:F0} unit-s ({s2.BusySeconds / (2 * elapsed):P1}), wait {s2.WaitSeconds:F0} s");

        Assert.Equal("op", s1.ResourceId);
        Assert.Equal(1, s1.Count);
        Assert.Equal(2, s2.Count);
        Assert.True(s1.BusySeconds <= 1 * elapsed + 1e-6);
        Assert.True(s1.BusySeconds > 0.95 * elapsed);   // the single operator is the bottleneck
        Assert.True(s1.WaitSeconds > 0);
        Assert.Equal(0, s2.WaitSeconds);                 // 2 machines, 2 operators: never waits

        // Combined machine Running time cannot exceed one unit.
        double run1 = one.Stats("M1").StateSeconds.Running + one.Stats("M2").StateSeconds.Running;
        Assert.True(run1 <= elapsed + 2 * one.Dt, $"running {run1} > {elapsed}");
        Assert.True(one.Stats("M1").StateSeconds.Starved > 0 && one.Stats("M2").StateSeconds.Starved > 0);

        Assert.InRange(g1 / 8.0, 230, 241);  // ≈ 3600/15
        Assert.InRange(g2 / 8.0, 470, 481);  // ≈ 2 × 3600/15
        Assert.True(g1 < 0.6 * g2);
    }

    [Fact]
    public void Uncontended_resource_changes_nothing()
    {
        var none = new SimulationEngine(TwoMachines(null), 3);
        var plenty = new SimulationEngine(TwoMachines(2), 3);
        none.Advance(TimeSpan.FromHours(2));
        plenty.Advance(TimeSpan.FromHours(2));
        Assert.Equal(none.GetAssetStats(), plenty.GetAssetStats());
        Assert.Equal(none.GetAssetStates(), plenty.GetAssetStates());
        Assert.Empty(none.GetResourceStats());
    }

    [Fact]
    public void Waiters_are_served_fifo_by_wait_start()
    {
        // The source releases one part per tick into M1, M2, M3 (round robin); one operator.
        var plant = Plant(
            [
                Asset("SRC", AssetKind.Source, ["M1", "M2", "M3"], P(("arrivalIntervalS", 0.1))),
                Asset("M1", AssetKind.Machine, ["SNK"], Machine(10), resourceId: "op"),
                Asset("M2", AssetKind.Machine, ["SNK"], Machine(10), resourceId: "op"),
                Asset("M3", AssetKind.Machine, ["SNK"], Machine(10), resourceId: "op"),
                Asset("SNK", AssetKind.Sink, []),
            ],
            resources: [new ResourceDef("op", "Operator", ResourceKind.Operator, 1)]);
        var e = new SimulationEngine(plant, 1);
        var starts = new List<string>();
        var prev = new Dictionary<string, double> { ["M1"] = 0, ["M2"] = 0, ["M3"] = 0 };
        while (starts.Count < 9)
        {
            e.Step();
            foreach (var id in prev.Keys.ToArray())
            {
                double p = e.State(id).CycleProgress;
                if (prev[id] == 0 && p > 0) starts.Add(id);
                prev[id] = p is > 0 and < 1 ? p : 0;
            }
            Assert.True(e.Tick < 2000, "no progress");
        }
        Assert.Equal(["M1", "M2", "M3", "M1", "M2", "M3", "M1", "M2", "M3"], starts);
    }

    [Fact]
    public void Equal_wait_start_is_broken_by_plant_order()
    {
        // Process order makes SRC-B hand its part to MB before SRC-A loads MA in the same tick,
        // so MB requests first; MA still wins because it comes first in plant order.
        var plant = Plant(
            [
                Asset("MA", AssetKind.Machine, ["SNK"], Machine(10), resourceId: "op"),
                Asset("MB", AssetKind.Machine, ["SNK"], Machine(10), resourceId: "op"),
                Asset("SRC-B", AssetKind.Source, ["MB"], P(("arrivalIntervalS", 60))),
                Asset("SRC-A", AssetKind.Source, ["MA"], P(("arrivalIntervalS", 60))),
                Asset("SNK", AssetKind.Sink, []),
            ],
            resources: [new ResourceDef("op", "Operator", ResourceKind.Operator, 1)]);
        var e = new SimulationEngine(plant, 1);
        e.Step(); // both loaded at t=0
        e.Step(); // grant
        Assert.True(e.State("MA").CycleProgress > 0);
        Assert.Equal(0, e.State("MB").CycleProgress);
        Assert.Equal(AssetStateKind.Starved, e.State("MB").State);
        e.Advance(TimeSpan.FromSeconds(11));
        Assert.True(e.State("MB").CycleProgress > 0);
    }

    [Fact]
    public void Unit_is_held_through_a_fault()
    {
        var e = new SimulationEngine(TwoMachines(1), 1);
        e.Advance(TimeSpan.FromSeconds(6)); // first part at 0 s, second at 5 s
        string running = e.State("M1").CycleProgress > 0 ? "M1" : "M2";
        string waiting = running == "M1" ? "M2" : "M1";
        Assert.Equal(AssetStateKind.Starved, e.State(waiting).State);

        var before = Op(e);
        double progress = e.State(running).CycleProgress;
        e.InjectFault(running, 60);
        for (int i = 0; i < 600; i++)
        {
            e.Step();
            Assert.Equal(AssetStateKind.Fault, e.State(running).State);
            Assert.Equal(AssetStateKind.Starved, e.State(waiting).State);
            Assert.Equal(0, e.State(waiting).CycleProgress);
        }
        var during = Op(e);
        Assert.Equal(before.BusySeconds + 60, during.BusySeconds, 6);
        Assert.Equal(before.WaitSeconds + 60, during.WaitSeconds, 6);
        Assert.Equal(progress, e.State(running).CycleProgress, 9); // paused, not lost

        // After repair the faulted machine finishes its cycle, then the waiter gets the unit.
        e.Advance(TimeSpan.FromSeconds(15));
        Assert.True(e.State(waiting).CycleProgress > 0);
    }

    [Fact]
    public void Reset_clears_resource_stats_and_replays()
    {
        var e = new SimulationEngine(TwoMachines(1), 5);
        e.Advance(TimeSpan.FromHours(1));
        var stats = e.GetResourceStats();
        var states = e.GetAssetStates();
        e.Reset();
        Assert.All(e.GetResourceStats(), s => Assert.Equal((0.0, 0.0), (s.BusySeconds, s.WaitSeconds)));
        e.Advance(TimeSpan.FromHours(1));
        Assert.Equal(stats, e.GetResourceStats());
        Assert.Equal(states, e.GetAssetStates());
    }

    // ------------------------------------------------------------------ sample line impact / perf

    /// <summary>The sample line with CNC-01/02 sharing <paramref name="operators"/> and every asset on a 06–12 shift.</summary>
    internal static PlantModel SampleWithFeatures(int operators, bool shifts)
    {
        var assets = Sample.Assets.Select(a => a with
        {
            ResourceId = a.Id is "CNC-01" or "CNC-02" ? "op" : null,
            ShiftId = shifts ? "morning" : null,
        }).ToList();
        return Sample with
        {
            Assets = assets,
            Resources = [new ResourceDef("op", "CNC operators", ResourceKind.Operator, operators)],
            Calendar = shifts ? new CalendarDef(6, [new ShiftDef("morning", "Morning", 6, 12)]) : null,
        };
    }

    [Fact]
    public void Sample_line_throughput_with_shared_cnc_operator()
    {
        var rows = new List<string>();
        double R(int ops, int seed)
        {
            var e = new SimulationEngine(SampleWithFeatures(ops, shifts: false), seed);
            e.Advance(TimeSpan.FromHours(8));
            var s = Op(e);
            rows.Add($"seed {seed}, {ops} op: {e.SinkGood() / 8.0:F1}/h, util {s.BusySeconds / (ops * 8 * 3600.0):P1}, wait {s.WaitSeconds:F0} s");
            return e.SinkGood() / 8.0;
        }
        double one = Enumerable.Range(1, 3).Average(s => R(1, s));
        double two = Enumerable.Range(1, 3).Average(s => R(2, s));
        rows.ForEach(output.WriteLine);
        output.WriteLine($"mean: 1 operator {one:F1}/h vs 2 operators {two:F1}/h");
        Assert.True(one < two * 0.85, $"{one} vs {two}");
    }

    [Fact]
    public void Plant_with_resources_and_shifts_runs_fast()
    {
        new SimulationEngine(SampleWithFeatures(1, true), 1).Advance(TimeSpan.FromMinutes(10)); // warm up
        NewEngine().Advance(TimeSpan.FromMinutes(10));

        var sw = Stopwatch.StartNew();
        NewEngine().Advance(TimeSpan.FromHours(8));
        var baseMs = sw.ElapsedMilliseconds;

        var e = new SimulationEngine(SampleWithFeatures(1, true), Sample.Seed);
        sw.Restart();
        e.Advance(TimeSpan.FromHours(8));
        var featMs = sw.ElapsedMilliseconds;
        output.WriteLine($"8 h: sample {baseMs} ms, with resource + shift {featMs} ms; good {e.SinkGood()}");

        Assert.True(e.SinkGood() > 0);
#if DEBUG
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(6), $"{featMs} ms");
#else
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"{featMs} ms");
#endif
    }
}
