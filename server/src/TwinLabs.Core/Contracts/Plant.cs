namespace TwinLabs.Core.Contracts;

/// <summary>Kinds of physical assets on a line. Wire format: camelCase string.</summary>
public enum AssetKind { Source, Conveyor, Machine, Buffer, Robot, Inspection, Sink }

/// <summary>PackML-inspired asset state. Wire format: camelCase string.</summary>
public enum AssetStateKind { Off, Idle, Running, Starved, Blocked, Fault, Maintenance }

public enum SensorKind { Temperature, Vibration, Power, Current, Speed, Level, Count }

/// <summary>World-space vector in metres. Right-handed, Y up, X runs along the line.</summary>
public sealed record Vec3(double X, double Y, double Z);

/// <summary>
/// Static definition of one asset. <see cref="Params"/> are the tunable numeric parameters (see docs/V1-Spec.md §2).
/// v0.3 optional fields: <see cref="LineId"/> groups assets into lines, <see cref="ResourceId"/> makes the asset need a
/// shared resource per cycle, <see cref="ShiftId"/> restricts it to a shift (outside = Off), <see cref="Mesh"/> is a
/// glTF URL (<c>/api/meshes/{id}/file</c>) that replaces the procedural model.
/// </summary>
public sealed record AssetDef(
    string Id,
    string Name,
    AssetKind Kind,
    Vec3 Position,
    double RotationY,
    Vec3 Size,
    IReadOnlyList<string> Downstream,
    IReadOnlyDictionary<string, double> Params,
    string? LineId = null,
    string? ResourceId = null,
    string? ShiftId = null,
    string? Mesh = null);

public sealed record SensorDef(
    string Id,
    string AssetId,
    SensorKind Kind,
    string Unit,
    double Noise,
    double? Hi = null,
    double? HiHi = null);

public enum ConnectionKind { Opcua, Mqtt }

/// <summary>v0.2: an external data connection. Endpoint e.g. <c>opc.tcp://host:4840/path</c> or <c>mqtt://host:1883</c>.</summary>
public sealed record ConnectionDef(string Id, ConnectionKind Kind, string Endpoint, int? PublishingIntervalMs = null, string? ClientId = null);

/// <summary>
/// v0.2: maps an external tag to a twin value. <see cref="Target"/> is <c>sensor:&lt;sensorId&gt;</c> or
/// <c>asset:&lt;assetId&gt;.&lt;state|good|scrap|wip|load|wear&gt;</c>. value = raw × Scale + Offset.
/// <see cref="StateMap"/> maps the raw value (integer as string) to a state; default is enum order (0=off … 6=maintenance).
/// <see cref="JsonPath"/> (MQTT only) is the <c>$.a.b</c> subset used to pull a number out of a JSON payload.
/// </summary>
public sealed record BindingDef(
    string Target,
    string ConnectionId,
    string Address,
    string? JsonPath = null,
    double? Scale = null,
    double? Offset = null,
    IReadOnlyDictionary<string, AssetStateKind>? StateMap = null);

/// <summary>v0.3: a named group of assets (a production line inside a plant).</summary>
public sealed record LineDef(string Id, string Name);

public enum ResourceKind { Operator, Agv, Tool }

/// <summary>v0.3: a shared pool of <see cref="Count"/> units (operators, AGVs, tooling).</summary>
public sealed record ResourceDef(string Id, string Name, ResourceKind Kind, int Count);

/// <summary>v0.3: a daily shift window in hours of day (0..24). EndHour &lt; StartHour wraps past midnight.</summary>
public sealed record ShiftDef(string Id, string Name, double StartHour, double EndHour);

/// <summary>v0.3: sim t=0 corresponds to <see cref="StartHourOfDay"/> (0..24) of day 1.</summary>
public sealed record CalendarDef(double StartHourOfDay, IReadOnlyList<ShiftDef> Shifts);

public sealed record PlantModel(
    string Id,
    string Name,
    int Version,
    int Seed,
    IReadOnlyList<AssetDef> Assets,
    IReadOnlyList<SensorDef> Sensors,
    IReadOnlyList<ConnectionDef>? Connections = null,
    IReadOnlyList<BindingDef>? Bindings = null,
    IReadOnlyList<LineDef>? Lines = null,
    IReadOnlyList<ResourceDef>? Resources = null,
    CalendarDef? Calendar = null);

/// <summary>Well-known keys in <see cref="AssetDef.Params"/>.</summary>
public static class ParamKeys
{
    public const string ArrivalIntervalS = "arrivalIntervalS";
    public const string ArrivalStdS = "arrivalStdS";
    public const string LengthM = "lengthM";
    public const string SpeedMps = "speedMps";
    public const string Capacity = "capacity";
    public const string CycleTimeS = "cycleTimeS";
    public const string CycleTimeStdS = "cycleTimeStdS";
    public const string MtbfS = "mtbfS";
    public const string MttrS = "mttrS";
    public const string ScrapRate = "scrapRate";
    public const string RatedKw = "ratedKw";
    public const string IdleKw = "idleKw";
    public const string AmbientC = "ambientC";
    public const string TempRiseC = "tempRiseC";
    public const string VibBaselineMms = "vibBaselineMms";
}
