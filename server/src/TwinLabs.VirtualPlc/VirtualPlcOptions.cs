using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace TwinLabs.VirtualPlc;

/// <summary>Config section <c>Twin:VirtualPlc</c> (plus <c>Twin:Data:Path</c> for the PKI folder).</summary>
public sealed record VirtualPlcOptions
{
    public bool Enabled { get; init; }
    public int Port { get; init; } = 4840;
    public bool Standalone { get; init; } = true;
    public double Speed { get; init; } = 1;
    public int SeedOffset { get; init; } = 1000;
    /// <summary>Absolute path of the PKI folder (<c>{Twin:Data:Path}/pki</c>).</summary>
    public string PkiPath { get; init; } = Path.GetFullPath(Path.Combine("data", "pki"));

    public string EndpointUrl => $"opc.tcp://localhost:{Port}/twinlabs";

    public static VirtualPlcOptions From(IConfiguration config)
    {
        var s = config.GetSection("Twin:VirtualPlc");
        var data = config["Twin:Data:Path"];
        if (string.IsNullOrWhiteSpace(data)) data = "./data";
        var speed = Dbl(s["Speed"], 1);
        return new VirtualPlcOptions
        {
            Enabled = Bool(s["Enabled"], false),
            Port = Int(s["Port"], 4840),
            Standalone = Bool(s["Standalone"], true),
            Speed = speed > 0 && double.IsFinite(speed) ? speed : 1,
            SeedOffset = Int(s["SeedOffset"], 1000),
            PkiPath = Path.GetFullPath(Path.Combine(data, "pki")),
        };
    }

    private static bool Bool(string? v, bool d) => bool.TryParse(v, out var b) ? b : d;
    private static int Int(string? v, int d) => int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) ? i : d;
    private static double Dbl(string? v, double d) => double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var x) ? x : d;
}
