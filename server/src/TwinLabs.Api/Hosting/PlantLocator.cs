namespace TwinLabs.Api.Hosting;

/// <summary>Finds the plant JSON: explicit config, then <c>contracts/plant/sample_line.json</c> up from the
/// content root (dev / tests), then <c>plant/sample_line.json</c> next to the binaries (published build).</summary>
public static class PlantLocator
{
    public const string DefaultFile = "sample_line.json";

    public static string Resolve(string? configuredPath, string contentRoot)
    {
        if (!string.IsNullOrWhiteSpace(configuredPath))
        {
            var p = Path.GetFullPath(Path.IsPathRooted(configuredPath) ? configuredPath : Path.Combine(contentRoot, configuredPath));
            return File.Exists(p) ? p : throw new FileNotFoundException($"Twin:PlantPath '{p}' does not exist.", p);
        }

        for (var dir = new DirectoryInfo(contentRoot); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "contracts", "plant", DefaultFile);
            if (File.Exists(candidate)) return candidate;
        }

        var published = Path.Combine(AppContext.BaseDirectory, "plant", DefaultFile);
        if (File.Exists(published)) return published;

        throw new FileNotFoundException(
            $"No plant model found. Set Twin:PlantPath, or place contracts/plant/{DefaultFile} above '{contentRoot}' " +
            $"or plant/{DefaultFile} next to the binaries.");
    }
}
