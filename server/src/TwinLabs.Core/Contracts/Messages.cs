namespace TwinLabs.Core.Contracts;

/// <summary>Every WebSocket frame: <c>{"type":"tick","t":12300,"seq":17,"data":{...}}</c>. <c>t</c> = sim time ms.</summary>
public sealed record Envelope<TData>(string Type, long T, long Seq, TData Data);

public static class MessageTypes
{
    // server -> client
    public const string Snapshot = "snapshot";
    public const string Tick = "tick";
    public const string Event = "event";
    public const string Alarm = "alarm";
    public const string Kpi = "kpi";
    public const string Params = "params";
    public const string Ack = "ack";

    // client -> server
    public const string Command = "command";
}

/// <summary>Sent once on connect and returned by <c>GET /api/state</c>.</summary>
public sealed record SnapshotData(
    PlantModel Plant,
    SimStatus Sim,
    IReadOnlyList<AssetState> Assets,
    IReadOnlyList<SensorValue> Sensors,
    IReadOnlyList<PartPosition> Parts,
    KpiReport? Kpi,
    IReadOnlyList<Alarm> Alarms,
    IReadOnlyList<EventRecord> Events);

/// <summary>~5 Hz stream of live state.</summary>
public sealed record TickData(
    SimStatus Sim,
    IReadOnlyList<AssetState> Assets,
    IReadOnlyList<SensorValue> Sensors,
    IReadOnlyList<PartPosition> Parts);

/// <summary>Broadcast after an asset's parameters change.</summary>
public sealed record ParamsData(string AssetId, IReadOnlyDictionary<string, double> Params);

/// <summary>Client command. Mirrors the REST actions. See <see cref="CommandActions"/>.</summary>
public sealed record CommandData(
    string Id,
    string Action,
    string? AssetId = null,
    double? Value = null,
    IReadOnlyDictionary<string, double>? Params = null,
    string? AlarmId = null,
    double? DurationS = null);

public static class CommandActions
{
    public const string SimStart = "sim.start";
    public const string SimPause = "sim.pause";
    public const string SimStop = "sim.stop";
    public const string SimReset = "sim.reset";
    /// <summary>Value = speed multiplier (0.25..100).</summary>
    public const string SimSpeed = "sim.speed";
    /// <summary>AssetId + Params.</summary>
    public const string AssetParams = "asset.params";
    /// <summary>AssetId + optional DurationS (default: drawn from MTTR).</summary>
    public const string AssetFault = "asset.fault";
    public const string AssetClearFault = "asset.clearFault";
    /// <summary>AssetId + Value 1 = enter maintenance, 0 = leave.</summary>
    public const string AssetMaintenance = "asset.maintenance";
    /// <summary>AssetId + Value 1 = enable, 0 = switch off.</summary>
    public const string AssetEnable = "asset.enable";
    public const string AlarmAck = "alarm.ack";
}

public sealed record AckData(string CommandId, bool Ok, string? Error = null);

// ---- What-if ----

public sealed record WhatIfOverride(string AssetId, IReadOnlyDictionary<string, double> Params);

/// <param name="DurationS">Sim seconds to run each of baseline and scenario.</param>
/// <param name="Seed">Seed used for both runs; null = plant seed.</param>
/// <param name="FromLive">true = baseline uses the live engine's current params; false = the original plant model.</param>
public sealed record WhatIfRequest(
    double DurationS,
    IReadOnlyList<WhatIfOverride> Overrides,
    int? Seed = null,
    bool FromLive = true);

public sealed record KpiDelta(string Metric, double Baseline, double Scenario, double Delta, double DeltaPct);

public sealed record WhatIfResult(
    double DurationS,
    int Seed,
    KpiReport Baseline,
    KpiReport Scenario,
    IReadOnlyList<KpiDelta> Deltas,
    long ElapsedMs);

// ---- REST bodies ----

public sealed record SpeedRequest(double Speed);
public sealed record ParamsRequest(IReadOnlyDictionary<string, double> Params);
public sealed record FaultRequest(double? DurationS = null);
public sealed record ToggleRequest(bool On);
public sealed record HealthData(string Status, string Version);
