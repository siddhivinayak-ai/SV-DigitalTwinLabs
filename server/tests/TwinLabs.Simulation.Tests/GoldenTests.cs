using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Xunit.Abstractions;
using static TwinLabs.Simulation.Tests.TestPlant;

namespace TwinLabs.Simulation.Tests;

/// <summary>
/// Fixed-seed fingerprints of the v0.1 sample line, captured before the v0.3 engine features were added.
/// The sample uses no lines/resources/shifts, so its behaviour must stay bit-identical.
/// </summary>
public class GoldenTests(ITestOutputHelper output)
{
    internal static string Fingerprint(SimulationEngine e)
    {
        var sb = new StringBuilder();
        foreach (var s in e.GetAssetStats())
            sb.Append(CultureInfo.InvariantCulture, $"{s.AssetId}|{s.StateSeconds}|{s.Total}|{s.Good}|{s.Scrap};");
        foreach (var s in e.GetAssetStates())
            sb.Append(CultureInfo.InvariantCulture, $"{s.Id}|{s.State}|{s.StateSinceMs}|{s.Wear:R}|{s.Wip}|{s.CycleProgress:R};");
        foreach (var v in e.GetSensorValues())
            sb.Append(CultureInfo.InvariantCulture, $"{v.Id}={v.V:R};");
        foreach (var ev in e.DrainEvents())
            sb.Append(CultureInfo.InvariantCulture, $"{ev.Id}|{ev.TimeMs}|{ev.Message};");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())))[..16];
    }

    [Theory]
    [InlineData(42, 940L, 117.5, "2BF4B252A813285C")]
    [InlineData(7, 980L, 122.5, "B636E7606ABD7447")]
    public void Sample_line_is_unchanged(int seed, long expectedGood, double expectedPerHour, string expectedHash)
    {
        var e = NewEngine(seed);
        e.Advance(TimeSpan.FromHours(8));
        long good = e.SinkGood();
        double perHour = good / 8.0;
        string hash = Fingerprint(e);
        output.WriteLine($"seed {seed}: good={good} ({perHour:F3}/h) hash={hash}");

        Assert.Equal(expectedGood, good);
        Assert.Equal(expectedPerHour, perHour, 6);
        Assert.Equal(expectedHash, hash);
        Assert.Empty(((TwinLabs.Core.ISimulationEngine)e).GetResourceStats());
    }
}
