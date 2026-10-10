using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>Configuration section <c>Twin</c>.</summary>
public sealed class TwinOptions
{
    public const string Section = "Twin";

    /// <summary>Plant JSON. Relative paths resolve against the content root. Null = auto-discover.</summary>
    public string? PlantPath { get; set; }

    /// <summary>Simulation seed. Null = the plant's seed.</summary>
    public int? Seed { get; set; }

    /// <summary>Start running immediately after boot.</summary>
    public bool AutoStart { get; set; } = true;

    /// <summary>Initial speed multiplier (clamped to 0.25..100).</summary>
    public double Speed { get; set; } = 1;

    /// <summary>Wall-clock rate of <c>tick</c> broadcasts.</summary>
    public double TickHz { get; set; } = 5;

    /// <summary>Sim-seconds of 1 Hz sensor history kept in memory.</summary>
    public int HistorySeconds { get; set; } = 36000;

    /// <summary>v0.2: initial twin mode (<c>simulate</c> or <c>shadow</c>). Shadow falls back to simulate when the plant has no bindings.</summary>
    public TwinMode Mode { get; set; } = TwinMode.Simulate;
}
