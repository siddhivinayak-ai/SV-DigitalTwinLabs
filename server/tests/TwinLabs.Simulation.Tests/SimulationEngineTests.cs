using System.Diagnostics;
using TwinLabs.Core.Contracts;
using Xunit.Abstractions;
using static TwinLabs.Simulation.Tests.TestPlant;

namespace TwinLabs.Simulation.Tests;

public class SimulationEngineTests(ITestOutputHelper output)
{
    private static readonly string[] CapacityAssets = ["CONV-01", "BUF-01", "CONV-02"];

    private static void NoRandomFaults(SimulationEngine e, params string[] ids)
    {
        foreach (var id in ids) e.UpdateParams(id, P(("mtbfS", 1e12)));
        e.DrainEvents();
    }

    // ------------------------------------------------------------------ determinism

    [Fact]
    public void Same_seed_gives_identical_results()
    {
        var a = NewEngine(7);
        var b = NewEngine(7);
        a.Advance(TimeSpan.FromHours(2));
        b.Advance(TimeSpan.FromHours(2));

        Assert.Equal(a.GetSensorValues(), b.GetSensorValues());
        Assert.Equal(a.GetParts(), b.GetParts());
        Assert.Equal(a.GetAssetStates(), b.GetAssetStates());
        Assert.Equal(a.GetAssetStats(), b.GetAssetStats());
        Assert.Equal(a.DrainEvents(), b.DrainEvents());
        Assert.Equal(a.Wip, b.Wip);
    }

    [Fact]
    public void Same_seed_and_commands_give_identical_results_regardless_of_reads()
    {
        var a = NewEngine(3);
        var b = NewEngine(3);
        for (int i = 0; i < 3600; i++)
        {
            a.Step();
            b.Step();
            if (i % 7 == 0) _ = a.GetSensorValues(); // reads must not perturb the sim
            if (i == 1000) { a.InjectFault("CNC-01", 30); b.InjectFault("CNC-01", 30); }
            if (i == 2000) { a.UpdateParams("ASSY-01", P(("cycleTimeS", 30))); b.UpdateParams("ASSY-01", P(("cycleTimeS", 30))); }
        }
        Assert.Equal(a.GetSensorValues(), b.GetSensorValues());
        Assert.Equal(a.GetAssetStates(), b.GetAssetStates());
    }

    [Fact]
    public void Different_seed_gives_different_results()
    {
        var a = NewEngine(1);
        var b = NewEngine(2);
        a.Advance(TimeSpan.FromHours(2));
        b.Advance(TimeSpan.FromHours(2));
        Assert.NotEqual(a.GetSensorValues(), b.GetSensorValues());
        Assert.NotEqual(a.GetAssetStats(), b.GetAssetStats());
    }

    [Fact]
    public void Reset_replays_the_same_run()
    {
        var e = NewEngine(11);
        e.Advance(TimeSpan.FromMinutes(30));
        var states = e.GetAssetStates();
        var sensors = e.GetSensorValues();

        e.Reset();
        Assert.Equal(0, e.Tick);
        Assert.Equal(0, e.Wip);
        Assert.Empty(e.GetParts());
        Assert.All(e.GetAssetStats(), s => Assert.Equal(0, s.StateSeconds.Total));

        e.Advance(TimeSpan.FromMinutes(30));
        Assert.Equal(states, e.GetAssetStates());
        Assert.Equal(sensors, e.GetSensorValues());

        e.Reset(12);
        Assert.Equal(12, e.Seed);
        Assert.Contains(e.DrainEvents(), ev => ev.Message.Contains("reset"));
    }

    // ------------------------------------------------------------------ flow / conservation

    [Fact]
    public void Eight_hour_run_has_plausible_throughput()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromHours(8));

        long good = e.SinkGood();
        double perHour = good / 8.0;
        var assy = e.Stats("ASSY-01").StateSeconds;
        double total = assy.Total;
        output.WriteLine($"8 h: good={good} ({perHour:F1}/h), released={e.Released()}, scrap={e.TotalScrap()}, wip={e.Wip}");
        output.WriteLine($"ASSY-01: run {assy.Running / total:P1}, starved {assy.Starved / total:P1}, blocked {assy.Blocked / total:P1}, fault {assy.Fault / total:P1}, idle {assy.Idle / total:P1}");
        foreach (var s in e.GetAssetStats())
            output.WriteLine($"  {s.AssetId,-8} run {s.StateSeconds.Running / total:P0} starve {s.StateSeconds.Starved / total:P0} block {s.StateSeconds.Blocked / total:P0} fault {s.StateSeconds.Fault / total:P0} good {s.Good} scrap {s.Scrap}");

        Assert.True(good > 0);
        Assert.InRange(perHour, 85, 160);
    }

    [Fact]
    public void Throughput_averaged_over_seeds_is_in_expected_band()
    {
        var rates = new List<double>();
        for (int seed = 1; seed <= 6; seed++)
        {
            var e = NewEngine(seed);
            e.Advance(TimeSpan.FromHours(8));
            rates.Add(e.SinkGood() / 8.0);
        }
        output.WriteLine("good/h per seed: " + string.Join(", ", rates.Select(r => r.ToString("F1"))) + $"; mean {rates.Average():F1}");
        Assert.InRange(rates.Average(), 100, 160);
    }

    [Fact]
    public void Sink_and_machine_counts_follow_the_analytics_contract()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromHours(4));
        var sink = e.Stats("SNK-01");
        Assert.True(sink.Good > 0);
        Assert.Equal(e.SinkGood(), sink.Good);   // parts consumed
        Assert.Equal(sink.Good, sink.Total);
        Assert.Equal(0, sink.Scrap);
        Assert.Equal(e.Released(), e.Wip + sink.Good + e.TotalScrap());

        foreach (var id in new[] { "CNC-01", "CNC-02", "ROB-01", "ASSY-01", "QC-01", "PACK-01" })
        {
            var s = e.Stats(id);
            var st = e.State(id);
            Assert.Equal(s.Good + s.Scrap, s.Total);
            Assert.Equal(st.Good, s.Good);
            Assert.Equal(st.Scrap, s.Scrap);
            Assert.True(s.IdealCycleTimeS > 0);
        }
        Assert.True(e.Stats("QC-01").Scrap > 0);
    }

    [Fact]
    public void Parts_are_conserved_at_all_times()
    {
        var e = NewEngine(5);
        for (int minute = 0; minute < 6 * 60; minute++)
        {
            e.Advance(TimeSpan.FromMinutes(1));
            var states = e.GetAssetStates();
            long released = states.Single(s => s.Id == "SRC-01").Good;
            long sink = states.Single(s => s.Id == "SNK-01").Good;
            long scrap = states.Sum(s => s.Scrap);
            Assert.Equal(released, e.Wip + sink + scrap);
            Assert.Equal(e.Wip, states.Sum(s => s.Wip));
            Assert.Equal(e.Wip, e.GetParts().Count);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Conveyors_and_buffers_never_exceed_capacity(bool congested)
    {
        var e = NewEngine();
        if (congested) e.UpdateParams("PACK-01", P(("cycleTimeS", 90))); // back up the whole line
        var caps = CapacityAssets.ToDictionary(id => id, id => (int)e.Plant.Assets.Single(a => a.Id == id).Params["capacity"]);
        var maxSeen = caps.Keys.ToDictionary(k => k, _ => 0);

        for (int i = 0; i < 4 * 36000; i++)
        {
            e.Step();
            foreach (var s in e.GetAssetStates())
            {
                if (!caps.TryGetValue(s.Id, out int cap)) continue;
                Assert.True(s.Wip <= cap, $"{s.Id} holds {s.Wip} > {cap} at t={e.SimTimeMs}");
                if (s.Wip > maxSeen[s.Id]) maxSeen[s.Id] = s.Wip;
            }
        }
        output.WriteLine(string.Join(", ", maxSeen.Select(kv => $"{kv.Key} max {kv.Value}/{caps[kv.Key]}")));
        if (congested) Assert.All(caps, kv => Assert.Equal(kv.Value, maxSeen[kv.Key]));
    }

    [Fact]
    public void Parts_progress_is_in_unit_range_and_ids_unique()
    {
        var e = NewEngine();
        for (int i = 0; i < 120; i++)
        {
            e.Advance(TimeSpan.FromSeconds(30));
            var parts = e.GetParts();
            Assert.All(parts, p => Assert.InRange(p.Progress, 0, 1));
            Assert.Equal(parts.Count, parts.Select(p => p.Id).Distinct().Count());
        }
    }

    // ------------------------------------------------------------------ faults / commands

    [Fact]
    public void Injected_fault_lasts_the_given_duration_then_recovers()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromMinutes(20));
        e.DrainEvents();

        long t0 = e.SimTimeMs;
        long goodBefore = e.State("CNC-02").Good;
        e.InjectFault("CNC-02", 90);
        var st = e.State("CNC-02");
        Assert.Equal(AssetStateKind.Fault, st.State);
        Assert.Equal(t0, st.StateSinceMs);

        var ev = e.DrainEvents();
        var faultEv = Assert.Single(ev, x => x.AssetId == "CNC-02" && x.To == AssetStateKind.Fault);
        Assert.Contains("CNC-02 FAULT", faultEv.Message);
        Assert.Contains("90 s", faultEv.Message);

        for (int i = 0; i < 900; i++)
        {
            Assert.Equal(AssetStateKind.Fault, e.State("CNC-02").State);
            e.Step();
        }
        Assert.Equal(t0 + 90_000, e.SimTimeMs);
        Assert.Equal(goodBefore, e.State("CNC-02").Good); // nothing processed while faulted

        e.Step();
        Assert.NotEqual(AssetStateKind.Fault, e.State("CNC-02").State);
        var repaired = Assert.Single(e.DrainEvents(), x => x.AssetId == "CNC-02" && x.From == AssetStateKind.Fault);
        Assert.Contains("90 s", repaired.Message);
        Assert.True(e.Stats("CNC-02").StateSeconds.Fault >= 90 - 1e-9);
    }

    [Fact]
    public void Fault_without_duration_draws_from_mttr_and_clear_fault_recovers()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromMinutes(5));
        e.InjectFault("ASSY-01");
        Assert.Equal(AssetStateKind.Fault, e.State("ASSY-01").State);
        e.Advance(TimeSpan.FromSeconds(1));
        e.ClearFault("ASSY-01");
        Assert.NotEqual(AssetStateKind.Fault, e.State("ASSY-01").State);
        var ev = e.DrainEvents();
        Assert.Contains(ev, x => x.AssetId == "ASSY-01" && x.Message.Contains("repair est."));
        Assert.Contains(ev, x => x.AssetId == "ASSY-01" && x.From == AssetStateKind.Fault);
        Assert.Throws<ArgumentException>(() => e.InjectFault("ASSY-01", 0));
        Assert.Throws<KeyNotFoundException>(() => e.InjectFault("NOPE"));
    }

    [Fact]
    public void Random_faults_happen_over_a_long_run_and_event_ids_increase()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromHours(8));
        var ev = e.DrainEvents();
        Assert.Contains(ev, x => x.To == AssetStateKind.Fault);
        for (int i = 1; i < ev.Count; i++) Assert.True(ev[i].Id > ev[i - 1].Id);
        Assert.Empty(e.DrainEvents());
        // Starved/blocked churn is not an event.
        Assert.DoesNotContain(ev, x => x.To is AssetStateKind.Starved or AssetStateKind.Blocked && x.From != AssetStateKind.Fault);
        output.WriteLine($"{ev.Count} events in 8 h; faults: {ev.Count(x => x.To == AssetStateKind.Fault)}");
    }

    [Fact]
    public void Maintenance_stops_flow_through_the_asset()
    {
        var e = NewEngine();
        NoRandomFaults(e, "CNC-01", "CNC-02", "ROB-01", "ASSY-01", "QC-01", "PACK-01"); // isolate the effect of maintenance
        e.Advance(TimeSpan.FromMinutes(30));
        e.SetMaintenance("CNC-01", true);
        e.SetMaintenance("CNC-02", true);
        Assert.Equal(AssetStateKind.Maintenance, e.State("CNC-01").State);
        long g1 = e.State("CNC-01").Good, g2 = e.State("CNC-02").Good;

        e.Advance(TimeSpan.FromMinutes(20));
        Assert.Equal(AssetStateKind.Maintenance, e.State("CNC-01").State);
        Assert.Equal(AssetStateKind.Maintenance, e.State("CNC-02").State);
        Assert.Equal(g1, e.State("CNC-01").Good);
        Assert.Equal(g2, e.State("CNC-02").Good);
        Assert.Equal(6, e.State("CONV-01").Wip); // infeed backs up to capacity
        Assert.Equal(AssetStateKind.Blocked, e.State("SRC-01").State);
        Assert.Equal(0, e.State("BUF-01").Wip); // downstream drained

        e.SetMaintenance("CNC-01", false);
        e.SetMaintenance("CNC-02", false);
        Assert.Equal(0, e.State("CNC-01").Wear);
        e.Advance(TimeSpan.FromMinutes(5));
        Assert.True(e.State("CNC-01").Good > g1);
        var ev = e.DrainEvents();
        Assert.Contains(ev, x => x.AssetId == "CNC-01" && x.To == AssetStateKind.Maintenance);
        Assert.Contains(ev, x => x.AssetId == "CNC-01" && x.From == AssetStateKind.Maintenance);
    }

    [Fact]
    public void Disabled_asset_is_off_and_stops_flow()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromMinutes(30));
        NoRandomFaults(e, "ROB-01");
        e.SetEnabled("ROB-01", false);
        Assert.Equal(AssetStateKind.Off, e.State("ROB-01").State);
        long robGood = e.State("ROB-01").Good;

        e.Advance(TimeSpan.FromMinutes(30));
        Assert.Equal(AssetStateKind.Off, e.State("ROB-01").State);
        Assert.Equal(robGood, e.State("ROB-01").Good);
        Assert.Equal(10, e.State("BUF-01").Wip);
        Assert.Contains(e.GetSensorValues(), s => s.Id == "ROB-01.power" && s.V == 0);
        Assert.True(e.Stats("ROB-01").StateSeconds.Off >= 30 * 60 - 0.1);

        e.SetEnabled("ROB-01", true);
        e.Advance(TimeSpan.FromMinutes(2));
        Assert.True(e.State("ROB-01").Good > robGood);
        var ev = e.DrainEvents();
        Assert.Contains(ev, x => x.AssetId == "ROB-01" && x.To == AssetStateKind.Off);
        Assert.Contains(ev, x => x.AssetId == "ROB-01" && x.From == AssetStateKind.Off);
    }

    // ------------------------------------------------------------------ params

    [Fact]
    public void UpdateParams_merges_validates_and_reflects_in_plant()
    {
        var e = NewEngine();
        var def = e.UpdateParams("ASSY-01", P(("cycleTimeS", 30)));
        Assert.Equal(30, def.Params["cycleTimeS"]);
        Assert.Equal(2, def.Params["cycleTimeStdS"]); // merged, not replaced
        Assert.Equal(30, e.Plant.Assets.Single(a => a.Id == "ASSY-01").Params["cycleTimeS"]);
        Assert.Equal(24, Sample.Assets.Single(a => a.Id == "ASSY-01").Params["cycleTimeS"]); // original untouched
        Assert.Equal(30, e.Stats("ASSY-01").IdealCycleTimeS);
        Assert.Contains(e.DrainEvents(), x => x.AssetId == "ASSY-01" && x.Message.Contains("cycleTimeS"));

        Assert.Throws<KeyNotFoundException>(() => e.UpdateParams("NOPE", P(("cycleTimeS", 1))));
        Assert.Throws<ArgumentException>(() => e.UpdateParams("BUF-01", P(("capacity", 0))));
        Assert.Throws<ArgumentException>(() => e.UpdateParams("BUF-01", P(("capacity", 2.5))));
        Assert.Throws<ArgumentException>(() => e.UpdateParams("CNC-01", P(("cycleTimeS", 0))));
        Assert.Throws<ArgumentException>(() => e.UpdateParams("CNC-01", P(("mttrS", -5))));
        Assert.Throws<ArgumentException>(() => e.UpdateParams("CNC-01", P(("scrapRate", 1))));
        Assert.Throws<ArgumentException>(() => e.UpdateParams("CNC-01", P(("scrapRate", -0.1))));
        Assert.Throws<ArgumentException>(() => e.UpdateParams("CNC-01", P(("cycleTimeS", double.NaN))));
        // A rejected batch applies nothing.
        Assert.Throws<ArgumentException>(() => e.UpdateParams("CNC-01", P(("cycleTimeS", 40), ("scrapRate", 2))));
        Assert.Equal(50, e.Plant.Assets.Single(a => a.Id == "CNC-01").Params["cycleTimeS"]);
    }

    [Fact]
    public void UpdateParams_takes_effect_live()
    {
        var baseline = NewEngine();
        var faster = NewEngine();
        baseline.Advance(TimeSpan.FromHours(1));
        faster.Advance(TimeSpan.FromHours(1));
        faster.UpdateParams("CONV-01", P(("speedMps", 0.5)));
        Assert.Contains(faster.GetSensorValues(), s => s.Id == "CONV-01.speed" && (s.V == 0 || Math.Abs(s.V - 0.5) < 0.05));

        foreach (var e in new[] { baseline, faster }) e.UpdateParams("ASSY-01", P(("cycleTimeS", 40)));
        long b0 = baseline.SinkGood();
        baseline.Advance(TimeSpan.FromHours(2));
        faster.Advance(TimeSpan.FromHours(2));
        double rate = (baseline.SinkGood() - b0) / 2.0;
        output.WriteLine($"ASSY-01 @40 s: {rate:F1} good/h");
        Assert.InRange(rate, 70, 92); // ≈ 3600/40 = 90/h minus scrap/faults
    }

    [Fact]
    public void Raising_buffer_capacity_changes_behaviour()
    {
        PlantModel plant = Sample;
        var small = new SimulationEngine(plant, 42);
        var large = new SimulationEngine(plant, 42);
        foreach (var e in new[] { small, large }) e.UpdateParams("ROB-01", P(("cycleTimeS", 30)));
        large.UpdateParams("BUF-01", P(("capacity", 30)));

        int maxSmall = 0, maxLarge = 0;
        for (int m = 0; m < 4 * 60; m++)
        {
            small.Advance(TimeSpan.FromMinutes(1));
            large.Advance(TimeSpan.FromMinutes(1));
            maxSmall = Math.Max(maxSmall, small.State("BUF-01").Wip);
            maxLarge = Math.Max(maxLarge, large.State("BUF-01").Wip);
        }
        double cncBlockedSmall = small.Stats("CNC-01").StateSeconds.Blocked + small.Stats("CNC-02").StateSeconds.Blocked;
        double cncBlockedLarge = large.Stats("CNC-01").StateSeconds.Blocked + large.Stats("CNC-02").StateSeconds.Blocked;
        output.WriteLine($"BUF max {maxSmall} vs {maxLarge}; CNC blocked {cncBlockedSmall:F0}s vs {cncBlockedLarge:F0}s");

        Assert.Equal(10, maxSmall);
        Assert.True(maxLarge > 10);
        Assert.True(cncBlockedLarge < cncBlockedSmall);
    }

    [Fact]
    public void Shrinking_capacity_keeps_parts_and_stops_accepting()
    {
        var e = NewEngine();
        e.SetEnabled("ROB-01", false);
        e.Advance(TimeSpan.FromHours(1));
        Assert.Equal(10, e.State("BUF-01").Wip);
        e.UpdateParams("BUF-01", P(("capacity", 4)));
        e.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal(10, e.State("BUF-01").Wip); // nothing destroyed

        e.SetEnabled("ROB-01", true);
        e.Advance(TimeSpan.FromHours(1));
        Assert.True(e.State("BUF-01").Wip <= 4);
        long released = e.Released();
        Assert.Equal(released, e.Wip + e.SinkGood() + e.TotalScrap());
    }

    // ------------------------------------------------------------------ stats / sensors / timing

    [Fact]
    public void State_seconds_sum_to_sim_time_for_every_asset()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromMinutes(45));
        e.InjectFault("CNC-01", 120);
        e.SetMaintenance("QC-01", true);
        e.Advance(TimeSpan.FromMinutes(10));
        e.SetMaintenance("QC-01", false);
        e.SetEnabled("PACK-01", false);
        e.Advance(TimeSpan.FromMinutes(5.05));

        double simS = e.SimTimeMs / 1000.0;
        Assert.All(e.GetAssetStats(), s => Assert.InRange(s.StateSeconds.Total, simS - e.Dt, simS + e.Dt));
    }

    [Fact]
    public void Every_sensor_has_a_finite_value()
    {
        var e = NewEngine();
        e.Advance(TimeSpan.FromHours(1));
        var values = e.GetSensorValues();
        Assert.Equal(Sample.Sensors.Select(s => s.Id), values.Select(v => v.Id));
        Assert.All(values, v => Assert.True(double.IsFinite(v.V), v.Id));

        var byId = values.ToDictionary(v => v.Id, v => v.V);
        Assert.Equal(e.State("QC-01").Scrap, byId["QC-01.rejects"]);
        Assert.Equal(e.SinkGood(), byId["SNK-01.good"]);
        Assert.Equal(e.State("BUF-01").Wip, byId["BUF-01.level"]);
        Assert.InRange(byId["CNC-01.temp"], 23, 70);   // warmed above ambient, below hi
        Assert.InRange(byId["CNC-01.vib"], 0.5, 4.5);
        Assert.InRange(byId["CNC-01.power"], 2, 20);
        Assert.InRange(byId["CNC-01.current"], 4, 35);
    }

    [Fact]
    public void Temperature_lags_towards_load_target()
    {
        var e = NewEngine();
        NoRandomFaults(e, "CNC-01");
        double t0 = e.GetSensorValues().Single(v => v.Id == "CNC-01.temp").V;
        Assert.InRange(t0, 23, 25);
        e.Advance(TimeSpan.FromHours(1));
        // CNC-01 runs most of the time: ambient 24 + ~0.8..1 × 38.
        double t1 = e.GetSensorValues().Single(v => v.Id == "CNC-01.temp").V;
        Assert.InRange(t1, 40, 63);
    }

    [Fact]
    public void Advance_carries_sub_tick_remainders()
    {
        var e = NewEngine();
        for (int i = 0; i < 40; i++) e.Advance(TimeSpan.FromMilliseconds(25));
        Assert.Equal(10, e.Tick);
        Assert.Equal(1000, e.SimTimeMs);
    }

    [Fact]
    public void Factory_creates_engine()
    {
        var e = new SimulationEngineFactory().Create(Sample, 99);
        Assert.Equal(99, e.Seed);
        Assert.Equal(0.1, e.Dt);
        Assert.Equal(11, e.GetAssetStates().Count);
    }

    [Fact]
    public void Eight_hour_run_is_fast()
    {
        var warm = NewEngine();
        warm.Advance(TimeSpan.FromMinutes(10));

        var e = NewEngine();
        var sw = Stopwatch.StartNew();
        e.Advance(TimeSpan.FromHours(8));
        sw.Stop();
        output.WriteLine($"8 h sim ({e.Tick} ticks) took {sw.ElapsedMilliseconds} ms");
#if DEBUG
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(6), $"{sw.ElapsedMilliseconds} ms");
#else
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"{sw.ElapsedMilliseconds} ms");
#endif
    }
}
