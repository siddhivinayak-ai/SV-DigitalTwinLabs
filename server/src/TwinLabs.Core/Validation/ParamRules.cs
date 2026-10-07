using TwinLabs.Core.Contracts;

namespace TwinLabs.Core.Validation;

/// <summary>
/// Required params per asset kind and the range rule for each param key.
/// DUPLICATION: the range rules re-express <c>TwinLabs.Simulation.ParamValidator</c> (Core cannot reference
/// Simulation). Keep the two in sync. The required sets are the params each runtime reads for its core behaviour
/// (the engine itself falls back to defaults), see docs/V1-Spec.md §2.
/// </summary>
public static class ParamRules
{
    /// <summary>Same key as <c>AssetRuntime.RejectRateKey</c> in TwinLabs.Simulation.</summary>
    public const string RejectRate = "rejectRate";

    private static readonly string[] SourceRequired = [ParamKeys.ArrivalIntervalS];
    private static readonly string[] ConveyorRequired = [ParamKeys.LengthM, ParamKeys.SpeedMps, ParamKeys.Capacity];
    private static readonly string[] BufferRequired = [ParamKeys.Capacity];
    private static readonly string[] MachineRequired = [ParamKeys.CycleTimeS];

    public static IReadOnlyList<string> Required(AssetKind kind) => kind switch
    {
        AssetKind.Source => SourceRequired,
        AssetKind.Conveyor => ConveyorRequired,
        AssetKind.Buffer => BufferRequired,
        AssetKind.Machine or AssetKind.Robot or AssetKind.Inspection => MachineRequired,
        _ => [],
    };

    /// <summary>Returns null when <paramref name="value"/> is acceptable for <paramref name="key"/>, else the reason.</summary>
    public static string? Check(string? key, double value)
    {
        if (string.IsNullOrWhiteSpace(key)) return "empty parameter name";
        if (!double.IsFinite(value)) return "must be a finite number";

        switch (key)
        {
            case ParamKeys.Capacity:
                return value < 1 || Math.Floor(value) != value ? "capacity must be an integer >= 1" : null;

            case ParamKeys.ArrivalIntervalS:
            case ParamKeys.CycleTimeS:
            case ParamKeys.MtbfS:
            case ParamKeys.MttrS:
            case ParamKeys.LengthM:
            case ParamKeys.SpeedMps:
                return value <= 0 ? "must be > 0" : null;

            case ParamKeys.ArrivalStdS:
            case ParamKeys.CycleTimeStdS:
            case ParamKeys.RatedKw:
            case ParamKeys.IdleKw:
            case ParamKeys.TempRiseC:
            case ParamKeys.VibBaselineMms:
                return value < 0 ? "must be >= 0" : null;

            case ParamKeys.ScrapRate:
            case RejectRate:
                return value is < 0 or >= 1 ? "rate must be in [0, 1)" : null;

            default:
                // Free-form keys (e.g. ambientC) are accepted; suffix conventions as in ParamValidator.
                if (key.EndsWith("Rate", StringComparison.Ordinal) && value is < 0 or >= 1) return "rate must be in [0, 1)";
                if (key.EndsWith("S", StringComparison.Ordinal) && !key.EndsWith("StdS", StringComparison.Ordinal) && value <= 0)
                    return "time must be > 0";
                return null;
        }
    }
}
