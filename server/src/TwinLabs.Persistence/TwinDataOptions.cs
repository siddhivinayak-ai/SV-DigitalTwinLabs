using System.Reflection;
using Microsoft.Extensions.Configuration;

namespace TwinLabs.Persistence;

/// <summary>
/// Resolved <c>Twin:Data</c> configuration.
/// <list type="bullet">
/// <item><c>Twin:Data:Enabled</c>: true = SQLite + files, false = in-memory stores. When the key is not set it defaults to
/// true, except when the host environment is <c>Testing</c> or the process is a test runner (so test suites that do
/// not opt in never write a <c>data/</c> folder).</item>
/// <item><c>Twin:Data:Path</c>: folder for <c>twinlabs.db</c> and <c>meshes/</c>; default <c>data</c>, relative to the content root.</item>
/// <item><c>Twin:Data:HistoryRetention</c>: rows kept per history table (events, alarms); default 100000.</item>
/// </list>
/// </summary>
public sealed class TwinDataOptions
{
    public const string Section = "Twin:Data";
    public const long MaxMeshBytes = 20L * 1024 * 1024;
    public const int DefaultHistoryRetention = 100_000;

    public bool Enabled { get; init; } = true;
    /// <summary>Absolute data folder.</summary>
    public string Path { get; init; } = System.IO.Path.GetFullPath("data");
    public int HistoryRetention { get; init; } = DefaultHistoryRetention;

    public string DatabaseFile => System.IO.Path.Combine(Path, "twinlabs.db");
    public string MeshDirectory => System.IO.Path.Combine(Path, "meshes");

    public static TwinDataOptions FromConfiguration(IConfiguration config, string? contentRoot, string? environmentName)
    {
        var section = config.GetSection(Section);
        var root = string.IsNullOrWhiteSpace(contentRoot) ? Directory.GetCurrentDirectory() : contentRoot;
        var rawPath = section["Path"];
        var path = System.IO.Path.GetFullPath(string.IsNullOrWhiteSpace(rawPath) ? "data" : rawPath, root);

        bool enabled;
        var rawEnabled = section["Enabled"];
        if (!string.IsNullOrWhiteSpace(rawEnabled) && bool.TryParse(rawEnabled, out var parsed)) enabled = parsed;
        else enabled = !string.Equals(environmentName, "Testing", StringComparison.OrdinalIgnoreCase) && !RunningUnderTestRunner();

        var retention = int.TryParse(section["HistoryRetention"], out var r) && r > 0 ? r : DefaultHistoryRetention;
        return new TwinDataOptions { Enabled = enabled, Path = path, HistoryRetention = retention };
    }

    internal static bool RunningUnderTestRunner()
    {
        var name = Assembly.GetEntryAssembly()?.GetName().Name;
        return name is not null &&
               (name.StartsWith("testhost", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("ReSharperTestRunner", StringComparison.OrdinalIgnoreCase) ||
                name.Contains("vstest", StringComparison.OrdinalIgnoreCase));
    }
}
