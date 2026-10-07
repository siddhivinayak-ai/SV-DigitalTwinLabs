using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>Validation rules for asset params (spec §2). Throws <see cref="ArgumentException"/>.</summary>
internal static class ParamValidator
{
    public static void Validate(string assetId, IReadOnlyDictionary<string, double> changes)
    {
        foreach (var (key, value) in changes)
        {
            if (string.IsNullOrWhiteSpace(key))
                throw new ArgumentException($"{assetId}: empty parameter name.");
            if (!double.IsFinite(value))
                throw new ArgumentException($"{assetId}.{key}: value must be a finite number.");

            switch (key)
            {
                case ParamKeys.Capacity:
                    if (value < 1 || Math.Floor(value) != value)
                        throw new ArgumentException($"{assetId}.{key}: capacity must be an integer >= 1 (got {value}).");
                    break;

                case ParamKeys.ArrivalIntervalS:
                case ParamKeys.CycleTimeS:
                case ParamKeys.MtbfS:
                case ParamKeys.MttrS:
                case ParamKeys.LengthM:
                case ParamKeys.SpeedMps:
                    if (value <= 0)
                        throw new ArgumentException($"{assetId}.{key}: must be > 0 (got {value}).");
                    break;

                case ParamKeys.ArrivalStdS:
                case ParamKeys.CycleTimeStdS:
                case ParamKeys.RatedKw:
                case ParamKeys.IdleKw:
                case ParamKeys.TempRiseC:
                case ParamKeys.VibBaselineMms:
                    if (value < 0)
                        throw new ArgumentException($"{assetId}.{key}: must be >= 0 (got {value}).");
                    break;

                case ParamKeys.ScrapRate:
                case AssetRuntime.RejectRateKey:
                    if (value < 0 || value >= 1)
                        throw new ArgumentException($"{assetId}.{key}: rate must be in [0, 1) (got {value}).");
                    break;

                default:
                    // Unknown / free-form keys (e.g. ambientC) are merged as-is.
                    if (key.EndsWith("Rate", StringComparison.Ordinal) && (value < 0 || value >= 1))
                        throw new ArgumentException($"{assetId}.{key}: rate must be in [0, 1) (got {value}).");
                    else if (key.EndsWith("S", StringComparison.Ordinal) && !key.EndsWith("StdS", StringComparison.Ordinal) && value <= 0)
                        throw new ArgumentException($"{assetId}.{key}: time must be > 0 (got {value}).");
                    break;
            }
        }
    }
}
