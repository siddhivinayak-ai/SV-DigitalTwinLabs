using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// Maps one <see cref="SensorDef"/> to a value derived from its asset (spec §2.3).
/// Analog kinds get Gaussian noise of <c>noise × value</c>; level and count are exact.
/// </summary>
internal sealed class SensorModel
{
    // Line voltage 0.4 kV, power factor 0.9.
    private static readonly double CurrentDivisor = Math.Sqrt(3) * 0.4 * 0.9;

    private readonly SensorDef _def;
    private readonly AssetRuntime _asset;
    private readonly int _stream;
    private readonly bool _countsScrap;

    public SensorModel(SensorDef def, AssetRuntime asset, int stream)
    {
        _def = def;
        _asset = asset;
        _stream = stream;
        _countsScrap = def.Id.EndsWith("rejects", StringComparison.OrdinalIgnoreCase)
                       || def.Id.EndsWith("scrap", StringComparison.OrdinalIgnoreCase);
    }

    public string Id => _def.Id;

    public double Read(int seed, long tick)
    {
        var a = _asset;
        double v;
        switch (_def.Kind)
        {
            case SensorKind.Level:
                return a.Wip;
            case SensorKind.Count:
                return _countsScrap ? a.Scrap : a.Good;
            case SensorKind.Temperature:
                v = a.TempC;
                break;
            case SensorKind.Vibration:
                v = a.State == AssetStateKind.Running ? a.VibBaselineMms + a.Wear * 6.0 : a.VibBaselineMms;
                break;
            case SensorKind.Power:
                v = Power(a);
                break;
            case SensorKind.Current:
                v = Power(a) / CurrentDivisor;
                break;
            case SensorKind.Speed:
                v = a.BeltSpeedMps;
                break;
            default:
                v = 0;
                break;
        }

        if (_def.Noise > 0 && v != 0)
            v += _def.Noise * v * SimRandom.HashNormal(seed, _stream, tick);
        return v;
    }

    /// <summary>idleKw + load × (ratedKw − idleKw); a switched-off asset draws nothing.</summary>
    private static double Power(AssetRuntime a) =>
        a.State == AssetStateKind.Off ? 0 : a.IdleKw + a.Load * (a.RatedKw - a.IdleKw);
}
