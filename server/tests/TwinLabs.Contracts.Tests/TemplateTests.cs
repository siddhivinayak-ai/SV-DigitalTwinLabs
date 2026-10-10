using System.Diagnostics;
using System.Text.Json.Nodes;
using TwinLabs.Analytics;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Simulation;
using Xunit.Abstractions;

namespace TwinLabs.Contracts.Tests;

/// <summary>
/// The v0.3 plant template library (contracts/plant/templates, docs/V0.3-PlantBuilder.md §5).
/// Each template must load, pass the structural rules of §3 (checked here directly, so the tests
/// do not depend on the full PlantValidator), and run 8 sim hours with line OEE in [0.3, 0.9].
/// </summary>
public class TemplateTests(ITestOutputHelper output)
{
    public static readonly string[] TemplateIds = ["machining-cell", "assembly-line", "battery-cell-line"];

    public static TheoryData<string> Templates
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var id in TemplateIds) data.Add(id);
            return data;
        }
    }

    private static string TemplatesDir
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts")))
                dir = dir.Parent;
            var root = dir?.FullName ?? throw new DirectoryNotFoundException("contracts/");
            return Path.Combine(root, "contracts", "plant", "templates");
        }
    }

    private static PlantModel Load(string id) => TwinJson.LoadPlant(Path.Combine(TemplatesDir, id + ".json"));

    [Fact]
    public void Template_folder_holds_exactly_the_required_templates()
    {
        var found = Directory.GetFiles(TemplatesDir, "*.json")
            .Select(Path.GetFileName)
            .Where(f => !f!.EndsWith(".meta.json", StringComparison.Ordinal))
            .Select(f => Path.GetFileNameWithoutExtension(f!))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(TemplateIds.OrderBy(f => f, StringComparer.Ordinal).ToArray(), found);
    }

    [Theory]
    [MemberData(nameof(Templates))]
    public void Template_deserializes_and_id_matches_file_name(string id)
    {
        var plant = Load(id);
        Assert.Equal(id, plant.Id);
        Assert.False(string.IsNullOrWhiteSpace(plant.Name));
        Assert.Equal(1, plant.Version);
        Assert.NotEmpty(plant.Assets);
        Assert.NotEmpty(plant.Sensors);
        Assert.NotNull(plant.Lines);
        Assert.NotEmpty(plant.Lines!);
        Assert.All(plant.Assets, a => Assert.False(string.IsNullOrEmpty(a.LineId), $"{a.Id} has no lineId"));
    }

    [Theory]
    [MemberData(nameof(Templates))]
    public void Template_has_meta_with_description_and_tags(string id)
    {
        var path = Path.Combine(TemplatesDir, id + ".meta.json");
        Assert.True(File.Exists(path), $"missing {id}.meta.json");
        var meta = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        Assert.False(string.IsNullOrWhiteSpace(meta["description"]?.GetValue<string>()));
        var tags = meta["tags"]!.AsArray();
        Assert.NotEmpty(tags);
        Assert.All(tags, t => Assert.False(string.IsNullOrWhiteSpace(t!.GetValue<string>())));
    }

    [Theory]
    [MemberData(nameof(Templates))]
    public void Template_passes_structural_checks(string id)
    {
        var issues = StructuralCheck(Load(id));
        Assert.True(issues.Count == 0, string.Join(Environment.NewLine, issues));
    }

    [Theory]
    [MemberData(nameof(Templates))]
    public void Template_passes_PlantValidator(string id)
    {
        // On this branch PlantValidator is a stub; once the real one merges this also covers params.
        var result = TwinLabs.Core.Validation.PlantValidator.Validate(Load(id));
        foreach (var i in result.Issues) output.WriteLine($"{i.Severity} {i.Code}: {i.Message}");
        Assert.True(result.Ok, string.Join("; ", result.Issues.Select(i => $"{i.Code}: {i.Message}")));
    }

    [Theory]
    [MemberData(nameof(Templates))]
    public void Template_runs_8h_with_good_parts_and_oee_in_range(string id)
    {
        var plant = Load(id);
        var sw = Stopwatch.StartNew();
        var engine = new SimulationEngine(plant, plant.Seed);
        var kpi = new KpiCalculator();
        // Sample hourly so the rolling throughput window behaves as it does live.
        for (var h = 0; h < 8; h++)
        {
            engine.Advance(TimeSpan.FromHours(1));
            kpi.Compute(engine);
        }
        var report = kpi.Compute(engine);
        sw.Stop();

        var line = report.Line;
        output.WriteLine($"{id}: OEE={line.Oee:F3} A={line.Availability:F3} P={line.Performance:F3} Q={line.Quality:F3} " +
                         $"throughput={line.ThroughputPerHour:F1}/h good={line.Good} scrap={line.Scrap} wip={line.Wip} " +
                         $"bottleneck={line.BottleneckAssetId} elapsed={sw.ElapsedMilliseconds} ms");
        foreach (var a in report.Assets)
            output.WriteLine($"  {a.AssetId,-8} OEE={a.Oee:F3} util={a.Utilization:F3} run={a.States.Running:F3} " +
                             $"starved={a.States.Starved:F3} blocked={a.States.Blocked:F3} fault={a.States.Fault:F3}");

        Assert.Equal(8 * 3_600_000L, engine.SimTimeMs);
        Assert.True(line.Good > 0, "no good parts at the sink");
        Assert.InRange(line.Oee, 0.3, 0.9);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10), $"8 h run took {sw.ElapsedMilliseconds} ms");
    }

    // ------------------------------------------------------------------ structural self-check

    /// <summary>
    /// The graph and reference rules of docs/V0.3-PlantBuilder.md §3, encoded independently of
    /// PlantValidator. Returns human-readable issues; empty means OK.
    /// </summary>
    internal static List<string> StructuralCheck(PlantModel plant)
    {
        var issues = new List<string>();
        var assets = plant.Assets;
        var byId = new Dictionary<string, AssetDef>(StringComparer.Ordinal);

        void Unique(string what, IEnumerable<string> ids)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var i in ids)
            {
                if (string.IsNullOrEmpty(i) || i.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-')))
                    issues.Add($"BAD_ID {what} '{i}'");
                if (!seen.Add(i)) issues.Add($"DUPLICATE_ID {what} '{i}'");
            }
        }

        Unique("asset", assets.Select(a => a.Id));
        Unique("sensor", plant.Sensors.Select(s => s.Id));
        Unique("line", (plant.Lines ?? []).Select(l => l.Id));
        Unique("resource", (plant.Resources ?? []).Select(r => r.Id));
        Unique("shift", (plant.Calendar?.Shifts ?? []).Select(s => s.Id));
        foreach (var a in assets) byId.TryAdd(a.Id, a);

        if (!assets.Any(a => a.Kind == AssetKind.Source)) issues.Add("NO_SOURCE");
        if (!assets.Any(a => a.Kind == AssetKind.Sink)) issues.Add("NO_SINK");

        // Downstream refs and kind rules.
        var upstreamCount = byId.Keys.ToDictionary(k => k, _ => 0, StringComparer.Ordinal);
        foreach (var a in assets)
        {
            foreach (var d in a.Downstream)
            {
                if (!byId.ContainsKey(d)) issues.Add($"UNKNOWN_DOWNSTREAM {a.Id} -> '{d}'");
                else upstreamCount[d]++;
                if (d == a.Id) issues.Add($"SELF_LOOP {a.Id}");
            }
            if (a.Kind == AssetKind.Sink && a.Downstream.Count > 0) issues.Add($"SINK_HAS_DOWNSTREAM {a.Id}");
            if (a.Kind != AssetKind.Sink && a.Downstream.Count == 0) issues.Add($"DEAD_END {a.Id}");
        }
        foreach (var a in assets.Where(a => a.Kind == AssetKind.Source && upstreamCount[a.Id] > 0))
            issues.Add($"SOURCE_HAS_UPSTREAM {a.Id}");

        // Cycles (DFS colouring).
        var colour = new Dictionary<string, int>(StringComparer.Ordinal);
        bool Dfs(string id)
        {
            colour[id] = 1;
            foreach (var d in byId[id].Downstream.Where(byId.ContainsKey))
            {
                var c = colour.GetValueOrDefault(d);
                if (c == 1 || (c == 0 && Dfs(d))) return true;
            }
            colour[id] = 2;
            return false;
        }
        foreach (var a in assets)
            if (colour.GetValueOrDefault(a.Id) == 0 && Dfs(a.Id)) { issues.Add($"CYCLE through {a.Id}"); break; }

        // Reachability from a source, and to a sink.
        var fromSource = Reach(assets.Where(a => a.Kind == AssetKind.Source).Select(a => a.Id),
            id => byId[id].Downstream.Where(byId.ContainsKey));
        var reverse = byId.Keys.ToDictionary(k => k, _ => new List<string>(), StringComparer.Ordinal);
        foreach (var a in assets)
            foreach (var d in a.Downstream.Where(byId.ContainsKey)) reverse[d].Add(a.Id);
        var toSink = Reach(assets.Where(a => a.Kind == AssetKind.Sink).Select(a => a.Id), id => reverse[id]);
        foreach (var a in assets)
        {
            if (!fromSource.Contains(a.Id)) issues.Add($"UNREACHABLE {a.Id}");
            if (!toSink.Contains(a.Id)) issues.Add($"NO_SINK_REACHABLE {a.Id}");
        }

        // lineId / resourceId / shiftId references.
        var lines = (plant.Lines ?? []).Select(l => l.Id).ToHashSet(StringComparer.Ordinal);
        var resources = (plant.Resources ?? []).ToDictionary(r => r.Id, StringComparer.Ordinal);
        var shifts = (plant.Calendar?.Shifts ?? []).Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var a in assets)
        {
            if (a.LineId is { } l && !lines.Contains(l)) issues.Add($"UNKNOWN_REF {a.Id}.lineId '{l}'");
            if (a.ResourceId is { } r)
            {
                if (!resources.ContainsKey(r)) issues.Add($"UNKNOWN_REF {a.Id}.resourceId '{r}'");
                if (!KpiCalculator.IsMachineLike(a.Kind)) issues.Add($"RESOURCE_KIND {a.Id} ({a.Kind})");
            }
            if (a.ShiftId is { } s && !shifts.Contains(s)) issues.Add($"UNKNOWN_REF {a.Id}.shiftId '{s}'");
        }
        foreach (var r in resources.Values.Where(r => r.Count < 1)) issues.Add($"BAD_RESOURCE_COUNT {r.Id}");
        if (plant.Calendar is { } cal)
        {
            if (cal.StartHourOfDay is < 0 or > 24) issues.Add("BAD_SHIFT calendar.startHourOfDay");
            foreach (var s in cal.Shifts)
                if (s.StartHour is < 0 or > 24 || s.EndHour is < 0 or > 24 || s.StartHour == s.EndHour)
                    issues.Add($"BAD_SHIFT {s.Id}");
        }

        // Footprint overlap in the XZ plane (rotationY is a multiple of 90 in templates).
        for (var i = 0; i < assets.Count; i++)
            for (var j = i + 1; j < assets.Count; j++)
                if (Overlaps(assets[i], assets[j])) issues.Add($"OVERLAP {assets[i].Id} / {assets[j].Id}");

        // Sensors.
        foreach (var s in plant.Sensors)
        {
            if (!byId.ContainsKey(s.AssetId)) issues.Add($"UNKNOWN_REF sensor {s.Id} -> '{s.AssetId}'");
            if (s.Hi is { } hi && s.HiHi is { } hh && hh <= hi) issues.Add($"LIMIT_ORDER {s.Id}");
        }
        foreach (var a in assets.Where(a => KpiCalculator.IsMachineLike(a.Kind)))
            if (!plant.Sensors.Any(s => s.AssetId == a.Id)) issues.Add($"NO_SENSORS {a.Id}");

        return issues;
    }

    private static HashSet<string> Reach(IEnumerable<string> start, Func<string, IEnumerable<string>> next)
    {
        var seen = new HashSet<string>(start, StringComparer.Ordinal);
        var queue = new Queue<string>(seen);
        while (queue.Count > 0)
            foreach (var n in next(queue.Dequeue()))
                if (seen.Add(n)) queue.Enqueue(n);
        return seen;
    }

    private static (double MinX, double MaxX, double MinZ, double MaxZ) Footprint(AssetDef a)
    {
        var quarterTurns = (int)Math.Round(a.RotationY / 90.0);
        var swap = Math.Abs(quarterTurns) % 2 == 1;
        var hx = (swap ? a.Size.Z : a.Size.X) / 2;
        var hz = (swap ? a.Size.X : a.Size.Z) / 2;
        return (a.Position.X - hx, a.Position.X + hx, a.Position.Z - hz, a.Position.Z + hz);
    }

    private static bool Overlaps(AssetDef a, AssetDef b)
    {
        var p = Footprint(a);
        var q = Footprint(b);
        const double eps = 1e-9;
        return p.MinX < q.MaxX - eps && q.MinX < p.MaxX - eps && p.MinZ < q.MaxZ - eps && q.MinZ < p.MaxZ - eps;
    }

    [Fact]
    public void Structural_check_catches_broken_plants()
    {
        var good = Load("machining-cell");
        Assert.Empty(StructuralCheck(good));

        var a0 = good.Assets[0];
        var broken = good with
        {
            Assets = [.. good.Assets.Select(a => a.Id == "CNC-02"
                ? a with { Position = good.Assets.First(x => x.Id == "CNC-01").Position, ResourceId = "nope" }
                : a.Id == "BUF-01" ? a with { ResourceId = "OP-01" } : a), a0],
            Sensors = [.. good.Sensors, new SensorDef("X.temp", "GHOST", SensorKind.Temperature, "°C", 0, 50, 40)],
        };
        var issues = StructuralCheck(broken);
        Assert.Contains(issues, i => i.StartsWith("DUPLICATE_ID asset", StringComparison.Ordinal));
        Assert.Contains(issues, i => i.StartsWith("OVERLAP CNC-01 / CNC-02", StringComparison.Ordinal));
        Assert.Contains(issues, i => i.StartsWith("UNKNOWN_REF CNC-02.resourceId", StringComparison.Ordinal));
        Assert.Contains(issues, i => i.StartsWith("RESOURCE_KIND BUF-01", StringComparison.Ordinal));
        Assert.Contains(issues, i => i.StartsWith("UNKNOWN_REF sensor X.temp", StringComparison.Ordinal));
        Assert.Contains(issues, i => i.StartsWith("LIMIT_ORDER X.temp", StringComparison.Ordinal));

        var cyclic = good with
        {
            Assets = [.. good.Assets.Select(a => a.Id == "PACK-01" ? a with { Downstream = ["QC-01"] } : a)],
        };
        var cyc = StructuralCheck(cyclic);
        Assert.Contains(cyc, i => i.StartsWith("CYCLE", StringComparison.Ordinal));
        Assert.Contains(cyc, i => i == "UNREACHABLE SNK-01");
        Assert.Contains(cyc, i => i == "NO_SINK_REACHABLE CNC-01");
    }
}
