using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

/// <summary>POST /api/plant/validate and PUT /api/plant (live plant replacement).</summary>
public class PlantApiTests
{
    internal static PlantModel SmallPlant(string id = "small", int seed = 7) => new(id, "Small cell", 1, seed,
        [
            new AssetDef("S-SRC", "Feeder", AssetKind.Source, new Vec3(0, 0, 0), 0, new Vec3(1.6, 1.4, 1.6), ["S-CNC"],
                new Dictionary<string, double> { ["arrivalIntervalS"] = 30 }, LineId: "L"),
            new AssetDef("S-CNC", "Mill", AssetKind.Machine, new Vec3(5, 0, 0), 90, new Vec3(3, 2.4, 2.2), ["S-SNK"],
                new Dictionary<string, double> { ["cycleTimeS"] = 25, ["mtbfS"] = 3600, ["mttrS"] = 300 }, LineId: "L", ResourceId: "ops"),
            new AssetDef("S-SNK", "Dock", AssetKind.Sink, new Vec3(10, 0, 0), 0, new Vec3(1.6, 1, 1.6), [],
                new Dictionary<string, double>(), LineId: "L"),
        ],
        [new SensorDef("S-CNC.temp", "S-CNC", SensorKind.Temperature, "°C", 0.01, 70, 80)],
        Lines: [new LineDef("L", "Cell")],
        Resources: [new ResourceDef("ops", "Operators", ResourceKind.Operator, 1)]);

    /// <summary>A plant with a cycle and an unknown downstream.</summary>
    internal static PlantModel BrokenPlant()
    {
        var p = SmallPlant("broken");
        return p with
        {
            Assets = [.. p.Assets.Select(a => a.Id == "S-CNC" ? a with { Downstream = ["S-SNK", "GHOST"] } : a)],
        };
    }

    private static async Task<(HttpStatusCode Status, string? ContentType, JsonNode Json)> Send(HttpClient c, HttpMethod method, string url, object body)
    {
        using var req = new HttpRequestMessage(method, url)
        {
            Content = new StringContent(body as string ?? TwinJson.Serialize(body), Encoding.UTF8, "application/json"),
        };
        var res = await c.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, res.Content.Headers.ContentType?.MediaType, JsonNode.Parse(text)!);
    }

    private static List<string?> Codes(JsonNode issues) => [.. issues.AsArray().Select(i => (string?)i!["code"])];

    // ------------------------------------------------------------------ validate

    [Fact]
    public async Task Validate_returns_200_ok_for_the_live_plant()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        var (status, _, json) = await Send(c, HttpMethod.Post, "/api/plant/validate", f.Host.GetPlant());
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.True((bool)json["ok"]!);
        Assert.Empty(json["issues"]!.AsArray());
    }

    [Fact]
    public async Task Validate_returns_200_with_issues_for_a_broken_plant()
    {
        await using var f = new TwinApiFactory();
        var (status, _, json) = await Send(f.CreateClient(), HttpMethod.Post, "/api/plant/validate", BrokenPlant());
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False((bool)json["ok"]!);
        var issue = json["issues"]!.AsArray().First(i => (string?)i!["code"] == "UNKNOWN_DOWNSTREAM")!;
        Assert.Equal("critical", (string?)issue["severity"]);
        Assert.Equal("S-CNC", (string?)issue["assetId"]);
        ContractShape.AssertSameFields(ContractShape.Example("validation.json")["issues"]![0], issue, "issue");
    }

    [Fact]
    public async Task Validate_of_an_empty_object_is_still_200()
    {
        await using var f = new TwinApiFactory();
        var (status, _, json) = await Send(f.CreateClient(), HttpMethod.Post, "/api/plant/validate", "{}");
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.False((bool)json["ok"]!);
        Assert.Contains("EMPTY_PLANT", Codes(json["issues"]!));
    }

    [Fact]
    public async Task Validate_does_not_change_the_live_plant()
    {
        await using var f = new TwinApiFactory();
        await Send(f.CreateClient(), HttpMethod.Post, "/api/plant/validate", SmallPlant());
        Assert.Equal("line-a", f.Host.GetPlant().Id);
        Assert.Single(f.Engines.Created);
    }

    // ------------------------------------------------------------------ PUT

    [Fact]
    public async Task Put_valid_plant_returns_snapshot_broadcasts_it_and_replaces_the_plant()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        using var ws = await f.ConnectAsync();
        var first = await Ws.ReceiveAsync(ws);
        Assert.Equal("snapshot", (string?)first["type"]);
        Assert.Equal("line-a", (string?)first["data"]!["plant"]!["id"]);

        var (status, _, json) = await Send(c, HttpMethod.Put, "/api/plant", SmallPlant());
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("small", (string?)json["plant"]!["id"]);
        Assert.Equal(3, json["plant"]!["assets"]!.AsArray().Count);
        Assert.Equal(7, (int)json["sim"]!["seed"]!);
        Assert.Equal(0, (long)json["sim"]!["simTimeMs"]!);

        var (snap, _) = await Ws.ReceiveUntilAsync(ws, "snapshot");
        Assert.Equal("small", (string?)snap["data"]!["plant"]!["id"]);
        Assert.Equal(["S-SRC", "S-CNC", "S-SNK"], snap["data"]!["assets"]!.AsArray().Select(a => (string?)a!["id"]));

        var plant = JsonNode.Parse(await c.GetStringAsync("/api/plant"))!;
        Assert.Equal("small", (string?)plant["id"]);
        Assert.Equal("ops", (string?)plant["resources"]![0]!["id"]);

        // The factory built a fresh engine for the new plant with the plant's seed.
        Assert.Equal(2, f.Engines.Created.Count);
        Assert.Equal("small", f.Engine.Plant.Id);
        Assert.Equal(7, f.Engine.Seed);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Put_invalid_plant_is_422_with_issues_and_changes_nothing()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        var before = f.Host.Status;
        var raised = 0;
        f.Host.PlantChanged += _ => raised++;

        var (status, contentType, json) = await Send(c, HttpMethod.Put, "/api/plant", BrokenPlant());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, status);
        Assert.Equal("application/problem+json", contentType);
        Assert.Equal(422, (int)json["status"]!);
        var issues = json["issues"]!.AsArray();
        Assert.Contains("UNKNOWN_DOWNSTREAM", Codes(issues));
        Assert.All(issues, i => Assert.NotNull((string?)i!["severity"]));
        Assert.Equal("critical", (string?)issues.First(i => (string?)i!["code"] == "UNKNOWN_DOWNSTREAM")!["severity"]);

        Assert.Equal("line-a", JsonNode.Parse(await c.GetStringAsync("/api/plant"))!["id"]!.GetValue<string>());
        Assert.Single(f.Engines.Created);
        Assert.Equal(before, f.Host.Status);
        Assert.Equal(0, raised);
    }

    [Fact]
    public async Task Put_with_warnings_only_is_applied()
    {
        await using var f = new TwinApiFactory();
        var p = SmallPlant() with { Sensors = [] }; // NO_SENSORS warning
        var (status, _, json) = await Send(f.CreateClient(), HttpMethod.Put, "/api/plant", p);
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("small", (string?)json["plant"]!["id"]);
    }

    [Fact]
    public async Task Put_without_a_body_is_400()
    {
        await using var f = new TwinApiFactory();
        var (status, _, _) = await Send(f.CreateClient(), HttpMethod.Put, "/api/plant", "not json");
        Assert.Equal(HttpStatusCode.BadRequest, status);
    }

    [Fact]
    public async Task PlantChanged_is_raised_outside_the_lock_with_the_new_plant()
    {
        await using var f = new TwinApiFactory();
        PlantModel? seen = null;
        long? simTimeInHandler = null;
        f.Host.PlantChanged += p =>
        {
            seen = p;
            simTimeInHandler = f.Host.SimTimeMs; // would deadlock-free either way, but proves the host is usable
        };

        var (status, _, _) = await Send(f.CreateClient(), HttpMethod.Put, "/api/plant", SmallPlant());
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.NotNull(seen);
        Assert.Equal("small", seen!.Id);
        Assert.Equal(3, seen.Assets.Count);
        Assert.Equal(0, simTimeInHandler);
    }

    [Theory]
    [InlineData(SimRunState.Running)]
    [InlineData(SimRunState.Paused)]
    [InlineData(SimRunState.Stopped)]
    public async Task Run_state_and_speed_are_kept_and_time_resets(SimRunState state)
    {
        await using var f = new TwinApiFactory();
        f.Host.Start();
        f.Host.SetSpeed(4);
        f.RunSimSeconds(3);
        if (state == SimRunState.Paused) f.Host.Pause();
        if (state == SimRunState.Stopped) f.Host.Stop();

        var result = f.Host.ReplacePlant(SmallPlant());
        Assert.True(result.Ok);
        var s = f.Host.Status;
        Assert.Equal(state, s.State);
        Assert.Equal(4, s.Speed);
        Assert.Equal(0, s.SimTimeMs);

        if (state == SimRunState.Running)
        {
            f.RunSimSeconds(1);
            Assert.True(f.Host.SimTimeMs > 0);
            Assert.Equal(f.Host.SimTimeMs, f.Engine.SimTimeMs); // the loop now drives the new engine
        }
    }

    [Fact]
    public async Task Replace_resets_analytics_history_and_events()
    {
        await using var f = new TwinApiFactory();
        f.Host.Start();
        f.Detector.Pending.Enqueue(FakeAnomalyDetector.VibAlarm());
        f.RunSimSeconds(3);
        Assert.NotEmpty(f.Host.GetActiveAlarms());
        var kpiResets = f.Kpi.ResetCount;
        var detectorResets = f.Detector.ResetCount;

        f.Host.ReplacePlant(SmallPlant());

        Assert.True(f.Kpi.ResetCount > kpiResets);
        Assert.True(f.Detector.ResetCount > detectorResets);
        Assert.Empty(f.Host.GetActiveAlarms());
        var events = f.Host.GetEvents(100);
        var e = Assert.Single(events);
        Assert.Equal("Plant replaced: Small cell (3 assets)", e.Message);
        Assert.Equal(Severity.Info, e.Severity);
        Assert.Equal(EventKind.Info, e.Kind);

        var hist = f.Host.GetHistory("S-CNC.temp", 60);
        Assert.Equal("S-CNC.temp", hist.SensorId);
        Assert.Throws<KeyNotFoundException>(() => f.Host.GetHistory("CNC-01.temp", 60));
    }

    [Fact]
    public async Task Asset_commands_target_the_new_plant()
    {
        await using var f = new TwinApiFactory();
        f.Host.ReplacePlant(SmallPlant());
        var c = f.CreateClient();

        var ok = await c.PostAsync("/api/assets/S-CNC/fault", null);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Contains(("S-CNC", (double?)null), f.Engine.Faults);

        var gone = await c.PostAsync("/api/assets/CNC-01/fault", null);
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    [Fact]
    public async Task What_if_from_original_uses_the_new_plant()
    {
        await using var f = new TwinApiFactory();
        f.Host.ReplacePlant(SmallPlant());
        await f.Host.RunWhatIfAsync(new WhatIfRequest(3600, [], FromLive: false));
        Assert.Equal("small", f.WhatIf.LastBasePlant!.Id);
        await f.Host.RunWhatIfAsync(new WhatIfRequest(3600, [new WhatIfOverride("S-CNC", new Dictionary<string, double> { ["cycleTimeS"] = 20 })]));
        Assert.Equal("small", f.WhatIf.LastBasePlant!.Id);
    }

    [Fact]
    public async Task Replace_can_go_back_to_the_sample_line()
    {
        await using var f = new TwinApiFactory();
        var original = f.Host.GetPlant();
        Assert.True(f.Host.ReplacePlant(SmallPlant()).Ok);
        Assert.True(f.Host.ReplacePlant(original).Ok);
        Assert.Equal("line-a", f.Host.GetPlant().Id);
        Assert.Equal(original.Assets.Count, f.Host.GetSnapshot().Assets.Count);
    }

    [Fact]
    public async Task Replace_rejects_without_side_effects_when_called_directly()
    {
        await using var f = new TwinApiFactory();
        var result = f.Host.ReplacePlant(BrokenPlant(), out var snapshot);
        Assert.False(result.Ok);
        Assert.Null(snapshot);
        Assert.Equal("line-a", f.Host.GetPlant().Id);
    }
}
