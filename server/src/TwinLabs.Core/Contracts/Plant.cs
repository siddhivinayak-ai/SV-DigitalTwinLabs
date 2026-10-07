namespace TwinLabs.Core.Contracts;

/// <summary>Kinds of physical assets on a line. Wire format: camelCase string.</summary>
public enum AssetKind { Source, Conveyor, Machine, Buffer, Robot, Inspection, Sink }

/// <summary>PackML-inspired asset state. Wire format: camelCase string.</summary>
public enum AssetStateKind { Off, Idle, Running, Starved, Blocked, Fault, Maintenance }

public enum SensorKind { Temperature, Vibration, Power, Current, Speed, Level, Count }

/// <summary>World-space vector in metres. Right-handed, Y up, X runs along the line.</summary>
public sealed record Vec3(double X, double Y, double Z);

/// <summary>Static definition of one asset. <see cref="Params"/> are the tunable numeric parameters (see docs/V1-Spec.md §2).</summary>
public sealed record AssetDef(
    string Id,
    string Name,
    AssetKind Kind,
    Vec3 Position,
    double RotationY,
    Vec3 Size,
    IReadOnlyList<string> Downstream,
    IReadOnlyDictionary<string, double> Params);

public sealed record SensorDef(
    string Id,
    string AssetId,
    SensorKind Kind,
    string Unit,
    double Noise,
    double? Hi = null,
    double? HiHi = null);

public sealed record PlantModel(
    string Id,
    string Name,
    int Version,
    int Seed,
    IReadOnlyList<AssetDef> Assets,
    IReadOnlyList<SensorDef> Sensors);

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
