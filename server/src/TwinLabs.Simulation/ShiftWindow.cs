using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// v0.3 daily shift window (docs/V0.3-PlantBuilder.md §2). Sim t=0 is <see cref="CalendarDef.StartHourOfDay"/>;
/// the pattern repeats every 24 h. A window with end &lt; start wraps midnight. Times are kept in integer
/// milliseconds so boundaries land exactly on a tick.
/// </summary>
internal sealed class ShiftWindow
{
    private const long DayMs = 24L * 3_600_000;

    private readonly long _offsetMs;
    private readonly long _startMs, _endMs;

    public ShiftWindow(ShiftDef def, double startHourOfDay, AssetRuntime[] assets)
    {
        Def = def;
        Assets = assets;
        _offsetMs = HoursToMs(startHourOfDay) % DayMs;
        _startMs = HoursToMs(def.StartHour);
        _endMs = HoursToMs(def.EndHour);
    }

    public ShiftDef Def { get; }
    public AssetRuntime[] Assets { get; }
    public bool Active { get; set; }

    /// <summary>True when the tick starting at <paramref name="simTimeMs"/> lies inside the window.</summary>
    public bool IsActiveAt(long simTimeMs)
    {
        long h = (_offsetMs + simTimeMs) % DayMs; // time of day, [0, 24 h)
        return _startMs < _endMs
            ? h >= _startMs && h < _endMs
            : h >= _startMs || h < _endMs;
    }

    private static long HoursToMs(double hours) => (long)Math.Round(hours * 3_600_000);
}
