using System.Text.Json.Serialization;

namespace TwinLabs.Core.Contracts;

public enum SimRunState { Stopped, Running, Paused }

public enum Severity { Info, Warning, Critical }

public enum EventKind { State, Alarm, Command, Info }

public enum AlarmSource { Limit, Anomaly, Fault }

public sealed record SimStatus(SimRunState State, double Speed, long SimTimeMs, long Tick, int Seed);

/// <summary>Live state of one asset.</summary>
/// <param name="Load">0..1 utilisation of the asset right now (drives power/temperature).</param>
/// <param name="Wear">0..1+ accumulated wear (drives vibration and fault hazard).</param>
/// <param name="Wip">Parts currently inside the asset.</param>
/// <param name="CycleProgress">0..1 progress of the current cycle, 0 when not processing.</param>
public sealed record AssetState(
    string Id,
    AssetStateKind State,
    long StateSinceMs,
    double Load,
    double Wear,
    int Wip,
    long Good,
    long Scrap,
    double CycleProgress);

/// <summary>Compact sensor sample: <c>{"id":"CNC-01.temp","v":61.2}</c>.</summary>
public sealed record SensorValue(string Id, double V);

/// <summary>A part inside an asset, for 3D animation. Progress 0..1 along the asset (conveyor travel, buffer slot, cycle).</summary>
public sealed record PartPosition(long Id, string AssetId, double Progress);

/// <summary>Seconds (in <see cref="AssetStats"/>) or fractions 0..1 (in <see cref="AssetKpi"/>) spent per state.</summary>
public sealed record StateBreakdown(
    double Off,
    double Idle,
    double Running,
    double Starved,
    double Blocked,
    double Fault,
    double Maintenance)
{
    public static readonly StateBreakdown Zero = new(0, 0, 0, 0, 0, 0, 0);

    [JsonIgnore]
    public double Total => Off + Idle + Running + Starved + Blocked + Fault + Maintenance;

    public double Get(AssetStateKind s) => s switch
    {
        AssetStateKind.Off => Off,
        AssetStateKind.Idle => Idle,
        AssetStateKind.Running => Running,
        AssetStateKind.Starved => Starved,
        AssetStateKind.Blocked => Blocked,
        AssetStateKind.Fault => Fault,
        AssetStateKind.Maintenance => Maintenance,
        _ => 0,
    };

    public StateBreakdown Add(AssetStateKind s, double v) => s switch
    {
        AssetStateKind.Off => this with { Off = Off + v },
        AssetStateKind.Idle => this with { Idle = Idle + v },
        AssetStateKind.Running => this with { Running = Running + v },
        AssetStateKind.Starved => this with { Starved = Starved + v },
        AssetStateKind.Blocked => this with { Blocked = Blocked + v },
        AssetStateKind.Fault => this with { Fault = Fault + v },
        AssetStateKind.Maintenance => this with { Maintenance = Maintenance + v },
        _ => this,
    };
}

/// <summary>Cumulative counters the engine exposes to analytics (not streamed on the wire).</summary>
/// <param name="StateSeconds">Cumulative sim seconds spent in each state since reset.</param>
/// <param name="Total">Parts finished by this asset (good + scrap).</param>
/// <param name="IdealCycleTimeS">Nominal cycle time (0 for assets without one).</param>
public sealed record AssetStats(
    string AssetId,
    StateBreakdown StateSeconds,
    long Total,
    long Good,
    long Scrap,
    double IdealCycleTimeS);

public sealed record EventRecord(
    long Id,
    long TimeMs,
    EventKind Kind,
    Severity Severity,
    string Message,
    string? AssetId = null,
    AssetStateKind? From = null,
    AssetStateKind? To = null);

public sealed record Alarm(
    string Id,
    AlarmSource Source,
    Severity Severity,
    string AssetId,
    string Message,
    long RaisedAtMs,
    bool Active,
    bool Acknowledged,
    string? SensorId = null,
    double? Value = null,
    double? Limit = null,
    long? ClearedAtMs = null);

public sealed record AssetKpi(
    string AssetId,
    double Oee,
    double Availability,
    double Performance,
    double Quality,
    double Utilization,
    long Good,
    long Scrap,
    StateBreakdown States);

public sealed record LineKpi(
    double Oee,
    double Availability,
    double Performance,
    double Quality,
    double ThroughputPerHour,
    int Wip,
    long Good,
    long Scrap,
    string? BottleneckAssetId);

public sealed record KpiReport(long SimTimeMs, LineKpi Line, IReadOnlyList<AssetKpi> Assets);

/// <summary>Columnar series, ready for uPlot: <c>T</c> = sim ms, <c>V</c> = values.</summary>
public sealed record HistorySeries(string SensorId, string Unit, IReadOnlyList<long> T, IReadOnlyList<double> V);
