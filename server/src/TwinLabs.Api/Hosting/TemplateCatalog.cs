using System.Text.Json;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Read-only catalog of plant templates: <c>&lt;id&gt;.json</c> files (id = file-name stem) with optional sibling
/// <c>&lt;id&gt;.meta.json</c> (<c>{"description":"…","tags":[…]}</c>). Templates are cached; with
/// <c>watch</c> on (development) the folder's file names and timestamps are re-checked on every call and the cache
/// is rebuilt when they change. Unreadable files are skipped with a warning.
/// </summary>
public sealed class TemplateCatalog
{
    public const string Folder = "templates";
    private const string MetaSuffix = ".meta.json";

    private sealed record Entry(TemplateInfo Info, PlantModel Plant);
    private sealed record Meta(string? Description, IReadOnlyList<string>? Tags);

    private readonly Lock _gate = new();
    private readonly bool _watch;
    private readonly ILogger? _log;
    private Dictionary<string, Entry>? _cache;
    private string _signature = "";

    public TemplateCatalog(string directory, bool watch = false, ILogger? log = null)
    {
        Directory = Path.GetFullPath(directory);
        _watch = watch;
        _log = log;
    }

    public string Directory { get; }

    /// <summary>
    /// Development: <c>contracts/plant/templates</c> found walking up from <paramref name="contentRoot"/> (so edits show
    /// up without a rebuild). Otherwise, or if not found: <c>plant/templates</c> next to the binaries (linked by the csproj).
    /// </summary>
    public static string ResolveDirectory(string contentRoot, bool isDevelopment)
    {
        if (isDevelopment)
            for (var dir = new DirectoryInfo(contentRoot); dir is not null; dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, "contracts", "plant", Folder);
                if (System.IO.Directory.Exists(candidate)) return candidate;
            }
        return Path.Combine(AppContext.BaseDirectory, "plant", Folder);
    }

    public IReadOnlyList<TemplateInfo> List()
    {
        var c = Load();
        return [.. c.Values.Select(e => e.Info).OrderBy(i => i.Id, StringComparer.Ordinal)];
    }

    /// <summary>A deep copy of the template plant, or null for an unknown id.</summary>
    public PlantModel? Get(string id) =>
        Load().TryGetValue(id, out var e) ? TwinJson.Deserialize<PlantModel>(TwinJson.Serialize(e.Plant)) : null;

    private Dictionary<string, Entry> Load()
    {
        lock (_gate)
        {
            if (_cache is not null && !_watch) return _cache;
            var sig = Signature();
            if (_cache is not null && sig == _signature) return _cache;
            _cache = Read();
            _signature = sig;
            return _cache;
        }
    }

    private string Signature()
    {
        if (!System.IO.Directory.Exists(Directory)) return "";
        try
        {
            return string.Join("|", new DirectoryInfo(Directory).EnumerateFiles("*.json")
                .OrderBy(f => f.Name, StringComparer.Ordinal)
                .Select(f => $"{f.Name}:{f.LastWriteTimeUtc.Ticks}:{f.Length}"));
        }
        catch (IOException) { return Guid.NewGuid().ToString(); }
        catch (UnauthorizedAccessException) { return Guid.NewGuid().ToString(); }
    }

    private Dictionary<string, Entry> Read()
    {
        var result = new Dictionary<string, Entry>(StringComparer.Ordinal);
        if (!System.IO.Directory.Exists(Directory))
        {
            _log?.LogInformation("Template folder {Dir} does not exist; no templates", Directory);
            return result;
        }

        foreach (var file in System.IO.Directory.EnumerateFiles(Directory, "*.json"))
        {
            var name = Path.GetFileName(file);
            if (name.EndsWith(MetaSuffix, StringComparison.OrdinalIgnoreCase)) continue;
            var id = Path.GetFileNameWithoutExtension(file);
            try
            {
                var plant = TwinJson.LoadPlant(file);
                var meta = ReadMeta(Path.Combine(Directory, id + MetaSuffix));
                var info = new TemplateInfo(id, plant.Name ?? id, meta?.Description ?? "", plant.Assets?.Count ?? 0,
                    [.. (meta?.Tags ?? []).Where(t => !string.IsNullOrWhiteSpace(t))]);
                result[id] = new Entry(info, plant);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or NotSupportedException)
            {
                _log?.LogWarning(ex, "Skipping unreadable template {File}", file);
            }
        }
        return result;
    }

    private Meta? ReadMeta(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<Meta>(File.ReadAllText(path), TwinJson.Options);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _log?.LogWarning(ex, "Ignoring unreadable template metadata {File}", path);
            return null;
        }
    }
}
