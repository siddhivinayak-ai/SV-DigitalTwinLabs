using TwinLabs.Core.Contracts;
using static TwinLabs.Simulation.Tests.TestPlant;

namespace TwinLabs.Simulation.Tests;

public class ShiftTests
{
    private const long HourTicks = 36_000;

    private static CalendarDef Day(double startHourOfDay = 6) =>
        new(startHourOfDay, [new ShiftDef("day", "Day shift", 6, 14)]);

    /// <summary>SRC → M (long cycle, on <paramref name="shift"/>) → SNK.</summary>
    private static SimulationEngine LongCycle(CalendarDef cal, string shift = "day") =>
        new(Plant(
            [
                Asset("SRC", AssetKind.Source, ["M"], P(("arrivalIntervalS", 10))),
                Asset("M", AssetKind.Machine, ["SNK"], P(("cycleTimeS", 1000)), shiftId: shift),
                Asset("SNK", AssetKind.Sink, []),
            ],
            calendar: cal), 1);

    private static void StepTo(SimulationEngine e, long tick)
    {
        while (e.Tick < tick) e.Step();
    }

    [Fact]
    public void Day_shift_switches_off_after_8h_and_on_after_24h_keeping_cycle_progress()
    {
        var e = LongCycle(Day(6));

        StepTo(e, 8 * HourTicks);                     // ticks [0, 8 h) are on shift
        Assert.Equal(AssetStateKind.Running, e.State("M").State);
        double p = e.State("M").CycleProgress;
        Assert.InRange(p, 0.01, 0.99);                 // a cycle is in progress at 14:00

        e.Step();                                      // 14:00 → Off
        var st = e.State("M");
        Assert.Equal(AssetStateKind.Off, st.State);
        Assert.Equal(8 * 3_600_000L, st.StateSinceMs);
        Assert.Equal(p, st.CycleProgress, 9);
        Assert.Equal(0, st.Load);

        StepTo(e, 24 * HourTicks);                     // still Off at 05:59:59.9 next day
        Assert.Equal(AssetStateKind.Off, e.State("M").State);
        Assert.Equal(p, e.State("M").CycleProgress, 9);
        long goodOff = e.State("M").Good;

        e.Step();                                      // 06:00 day 2 → resumes
        Assert.Equal(AssetStateKind.Running, e.State("M").State);
        Assert.Equal(24 * 3_600_000L, e.State("M").StateSinceMs);
        Assert.True(e.State("M").CycleProgress > p);
        Assert.Equal(goodOff, e.State("M").Good);
        Assert.Equal(16 * 3600, e.Stats("M").StateSeconds.Off, 6);
    }

    [Fact]
    public void Night_shift_wraps_midnight()
    {
        // t=0 is 20:00; night shift 22:00 → 06:00.
        var e = LongCycle(new CalendarDef(20, [new ShiftDef("night", "Night shift", 22, 6)]), "night");
        Assert.Equal(AssetStateKind.Off, e.State("M").State); // starts Off at 20:00
        (double H, bool On)[] checks = [(1, false), (2.05, true), (5, true), (9.95, true), (10.05, false), (25, false), (26.05, true)];
        foreach (var (h, on) in checks)
        {
            StepTo(e, (long)Math.Round(h * HourTicks));
            Assert.True(on == (e.State("M").State != AssetStateKind.Off), $"t={h} h: {e.State("M").State}");
        }
        // Off 20:00–22:00 (2 h) and 06:00–22:00 (16 h) by t = 26 h.
        Assert.InRange(e.Stats("M").StateSeconds.Off, 18 * 3600 - 1, 18 * 3600 + 1);
    }

    [Fact]
    public void Off_shift_source_conveyor_and_buffer_stop()
    {
        var e = new SimulationEngine(Plant(
            [
                Asset("SRC", AssetKind.Source, ["CONV"], P(("arrivalIntervalS", 5)), shiftId: "day"),
                Asset("SRC2", AssetKind.Source, ["CONV2"], P(("arrivalIntervalS", 5))),
                Asset("CONV", AssetKind.Conveyor, ["SNK"], P(("lengthM", 10), ("speedMps", 0.2), ("capacity", 5))),
                Asset("CONV2", AssetKind.Conveyor, ["BUF"], P(("lengthM", 10), ("speedMps", 0.2), ("capacity", 5)), shiftId: "day"),
                Asset("BUF", AssetKind.Buffer, ["SNK"], P(("capacity", 5)), shiftId: "day"),
                Asset("SNK", AssetKind.Sink, []),
            ],
            calendar: Day(6)), 1);

        StepTo(e, 8 * HourTicks - 125);                // 12.5 s before 14:00 so parts are mid-belt
        e.Advance(TimeSpan.FromSeconds(12.6));
        long released = e.State("SRC").Good;
        var conv2 = e.GetParts().Where(p => p.AssetId == "CONV2").ToArray();
        int bufWip = e.State("BUF").Wip;
        Assert.NotEmpty(conv2);

        e.Advance(TimeSpan.FromHours(4));
        Assert.Equal(AssetStateKind.Off, e.State("SRC").State);
        Assert.Equal(AssetStateKind.Off, e.State("CONV2").State);
        Assert.Equal(AssetStateKind.Off, e.State("BUF").State);
        Assert.Equal(released, e.State("SRC").Good);                                 // no releases
        Assert.Equal(conv2, e.GetParts().Where(p => p.AssetId == "CONV2").ToArray()); // belt frozen
        Assert.Equal(bufWip, e.State("BUF").Wip);
        Assert.Equal(AssetStateKind.Blocked, e.State("SRC2").State);                 // CONV2 accepts nothing
        Assert.Equal(released + e.State("SRC2").Good, e.Wip + e.State("SNK").Good);

        StepTo(e, 24 * HourTicks + 600);
        Assert.True(e.State("SRC").Good > released);
        Assert.NotEqual(AssetStateKind.Off, e.State("CONV2").State);
    }

    [Fact]
    public void Disabled_and_off_shift_shows_off_and_stays_off_when_shift_starts()
    {
        var e = LongCycle(Day(13));                    // 1 h of shift left
        e.SetEnabled("M", false);
        Assert.Equal(AssetStateKind.Off, e.State("M").State);
        StepTo(e, 2 * HourTicks);
        Assert.Equal(AssetStateKind.Off, e.State("M").State);
        StepTo(e, 17 * HourTicks + 10);                // shift starts again at 06:00 = t 17 h
        Assert.Equal(AssetStateKind.Off, e.State("M").State); // still disabled
        e.SetEnabled("M", true);
        Assert.NotEqual(AssetStateKind.Off, e.State("M").State);
    }

    [Fact]
    public void One_event_per_shift_transition()
    {
        var e = new SimulationEngine(Plant(
            [
                Asset("SRC", AssetKind.Source, ["M1"], P(("arrivalIntervalS", 10)), shiftId: "day"),
                Asset("M1", AssetKind.Machine, ["M2"], P(("cycleTimeS", 5)), shiftId: "day"),
                Asset("M2", AssetKind.Machine, ["SNK"], P(("cycleTimeS", 5)), shiftId: "day"),
                Asset("M3", AssetKind.Machine, ["SNK"], P(("cycleTimeS", 5)), shiftId: "night"),
                Asset("SNK", AssetKind.Sink, []),
            ],
            calendar: new CalendarDef(6,
            [
                new ShiftDef("day", "Day shift", 6, 14),
                new ShiftDef("night", "Night shift", 22, 6),
                new ShiftDef("unused", "Unused", 0, 12),
            ])), 1);
        Assert.Equal(AssetStateKind.Off, e.State("M3").State);
        e.Advance(TimeSpan.FromHours(25));
        var shiftEvents = e.DrainEvents().Where(x => x.Message.StartsWith("Shift ")).ToArray();
        Assert.Equal(
            [
                (8 * 3_600_000L, "Shift 'Day shift' ended (3 assets)"),
                (16 * 3_600_000L, "Shift 'Night shift' started (1 asset)"),
                (24 * 3_600_000L, "Shift 'Day shift' started (3 assets)"),
                (24 * 3_600_000L, "Shift 'Night shift' ended (1 asset)"),
            ],
            shiftEvents.Select(x => (x.TimeMs, x.Message)).ToArray());
        Assert.All(shiftEvents, x =>
        {
            Assert.Equal(EventKind.Info, x.Kind);
            Assert.Equal(Severity.Info, x.Severity);
            Assert.Null(x.AssetId);
        });
    }

    [Fact]
    public void Reset_restores_initial_shift_state()
    {
        var e = LongCycle(Day(6));
        e.Advance(TimeSpan.FromHours(10));
        Assert.Equal(AssetStateKind.Off, e.State("M").State);
        e.DrainEvents();
        e.Reset();
        Assert.NotEqual(AssetStateKind.Off, e.State("M").State);
        e.Advance(TimeSpan.FromHours(10));
        Assert.Equal(AssetStateKind.Off, e.State("M").State);
        Assert.Single(e.DrainEvents(), x => x.Message.StartsWith("Shift 'Day shift' ended"));
    }
}
