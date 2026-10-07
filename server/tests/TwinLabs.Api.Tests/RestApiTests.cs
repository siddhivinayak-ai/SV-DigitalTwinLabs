using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

public class RestApiTests
{
    private static async Task<JsonNode> GetJson(HttpClient c, string url)
    {
        var res = await c.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return JsonNode.Parse(await res.Content.ReadAsStringAsync())!;
    }

    private static async Task<JsonNode> Send(HttpClient c, HttpMethod method, string url, object? body = null, HttpStatusCode expect = HttpStatusCode.OK)
    {
        using var req = new HttpRequestMessage(method, url);
        if (body is not null) req.Content = new StringContent(body as string ?? TwinJson.Serialize(body), Encoding.UTF8, "application/json");
        var res = await c.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        Assert.True(expect == res.StatusCode, $"{method} {url}: expected {(int)expect} got {(int)res.StatusCode}: {text}");
        if (expect != HttpStatusCode.OK)
            Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        return JsonNode.Parse(text)!;
    }

    [Fact]
    public async Task Health_reports_ok_and_version()
    {
        await using var f = new TwinApiFactory();
        var json = await GetJson(f.CreateClient(), "/api/health");
        Assert.Equal("ok", (string?)json["status"]);
        Assert.Equal("0.1.0", (string?)json["version"]);
    }

    [Fact]
    public async Task Plant_returns_the_sample_line_in_contract_shape()
    {
        await using var f = new TwinApiFactory();
        var json = await GetJson(f.CreateClient(), "/api/plant");
        Assert.Equal("line-a", (string?)json["id"]);
        Assert.True(json["assets"]!.AsArray().Count >= 10);
        Assert.Equal("machine", (string?)json["assets"]!.AsArray().First(a => (string?)a!["id"] == "CNC-01")!["kind"]);
        ContractShape.AssertKnownFields(ContractShape.Example("snapshot.json")["data"]!["plant"], json);
    }

    [Fact]
    public async Task State_returns_a_snapshot_in_contract_shape()
    {
        await using var f = new TwinApiFactory();
        var json = await GetJson(f.CreateClient(), "/api/state");
        var example = ContractShape.SnapshotDataExample();
        ContractShape.AssertKnownFields(example, json);
        ContractShape.AssertSameFields(example["sim"], json["sim"], "sim");
        Assert.Equal("stopped", (string?)json["sim"]!["state"]);
        Assert.Equal(42, (int)json["sim"]!["seed"]!);
        Assert.Equal("Simulation initialised (seed 42)", (string?)json["events"]![0]!["message"]);
        Assert.Equal(f.Engine.Plant.Sensors.Count, json["sensors"]!.AsArray().Count);
    }

    [Fact]
    public async Task Kpi_returns_a_report_in_contract_shape()
    {
        await using var f = new TwinApiFactory();
        var json = await GetJson(f.CreateClient(), "/api/kpi");
        var example = ContractShape.Example("kpi.json")["data"]!;
        ContractShape.AssertKnownFields(example, json);
        ContractShape.AssertSameFields(example["line"], json["line"], "line");
        ContractShape.AssertSameFields(example["assets"]![0], json["assets"]![0], "assets[0]");
    }

    [Fact]
    public async Task Sim_run_state_transitions()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();

        var s = await Send(c, HttpMethod.Post, "/api/sim/start");
        Assert.Equal("running", (string?)s["state"]);
        f.RunSimSeconds(3);
        Assert.Equal(3000, f.Host.Status.SimTimeMs);

        s = await Send(c, HttpMethod.Post, "/api/sim/pause");
        Assert.Equal("paused", (string?)s["state"]);
        f.RunSimSeconds(2);
        Assert.Equal(3000, f.Host.Status.SimTimeMs); // paused: time frozen

        s = await Send(c, HttpMethod.Post, "/api/sim/start");
        Assert.Equal("running", (string?)s["state"]);
        f.RunSimSeconds(1);
        Assert.Equal(4000, f.Host.Status.SimTimeMs);

        // reset keeps the run state, rewinds engine + analytics
        var resets = f.Engine.ResetCount;
        s = await Send(c, HttpMethod.Post, "/api/sim/reset");
        Assert.Equal("running", (string?)s["state"]);
        Assert.Equal(0, (long)s["simTimeMs"]!);
        Assert.Equal(resets + 1, f.Engine.ResetCount);
        Assert.True(f.Kpi.ResetCount >= 2);
        Assert.True(f.Detector.ResetCount >= 2);

        // stop = pause + rewind
        f.RunSimSeconds(2);
        s = await Send(c, HttpMethod.Post, "/api/sim/stop");
        Assert.Equal("stopped", (string?)s["state"]);
        Assert.Equal(0, (long)s["simTimeMs"]!);
        f.RunSimSeconds(2);
        Assert.Equal(0, f.Host.Status.SimTimeMs);
    }

    [Theory]
    [InlineData(10, 10)]
    [InlineData(500, 100)]
    [InlineData(0.1, 0.25)]
    [InlineData(0.25, 0.25)]
    [InlineData(100, 100)]
    public async Task Speed_is_clamped(double requested, double expected)
    {
        await using var f = new TwinApiFactory();
        var s = await Send(f.CreateClient(), HttpMethod.Post, "/api/sim/speed", new SpeedRequest(requested));
        Assert.Equal(expected, (double)s["speed"]!);
    }

    [Theory]
    [InlineData("{\"speed\":0}")]
    [InlineData("{\"speed\":-3}")]
    public async Task Non_positive_speed_is_400(string body)
    {
        await using var f = new TwinApiFactory();
        var p = await Send(f.CreateClient(), HttpMethod.Post, "/api/sim/speed", body, HttpStatusCode.BadRequest);
        Assert.Equal(400, (int)p["status"]!);
    }

    [Fact]
    public async Task Speed_scales_sim_time()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        await Send(c, HttpMethod.Post, "/api/sim/speed", new SpeedRequest(10));
        await Send(c, HttpMethod.Post, "/api/sim/start");
        f.Host.Advance(TimeSpan.FromMilliseconds(100)); // 100 ms × 10 = 1 sim second
        Assert.Equal(1000, f.Host.Status.SimTimeMs);
    }

    [Fact]
    public async Task Patch_params_merges_and_returns_asset_def()
    {
        await using var f = new TwinApiFactory();
        var json = await Send(f.CreateClient(), HttpMethod.Patch, "/api/assets/BUF-01/params",
            new ParamsRequest(new Dictionary<string, double> { ["capacity"] = 30 }));
        Assert.Equal("BUF-01", (string?)json["id"]);
        Assert.Equal(30, (double)json["params"]!["capacity"]!);
        Assert.Equal(30, f.Engine.Plant.Assets.Single(a => a.Id == "BUF-01").Params["capacity"]);
        ContractShape.AssertKnownFields(ContractShape.Example("snapshot.json")["data"]!["plant"]!["assets"]![0], json);

        var events = await GetJson(f.CreateClient(), "/api/events");
        Assert.Contains(events.AsArray(), e => (string?)e!["kind"] == "command" && ((string?)e["message"])!.Contains("asset.params BUF-01"));
    }

    [Fact]
    public async Task Patch_params_unknown_asset_is_404()
    {
        await using var f = new TwinApiFactory();
        var p = await Send(f.CreateClient(), HttpMethod.Patch, "/api/assets/CNC-09/params",
            new ParamsRequest(new Dictionary<string, double> { ["capacity"] = 30 }), HttpStatusCode.NotFound);
        Assert.Equal("Unknown asset 'CNC-09'", (string?)p["detail"]);
    }

    [Fact]
    public async Task Patch_params_engine_argument_exception_is_400()
    {
        await using var f = new TwinApiFactory();
        var p = await Send(f.CreateClient(), HttpMethod.Patch, "/api/assets/BUF-01/params",
            new ParamsRequest(new Dictionary<string, double> { ["capacity"] = -1 }), HttpStatusCode.BadRequest);
        Assert.Equal("Parameters must be non-negative", (string?)p["detail"]);
    }

    [Fact]
    public async Task Fault_inject_and_clear()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        var s = await Send(c, HttpMethod.Post, "/api/assets/CNC-02/fault", new FaultRequest(300));
        Assert.Equal("fault", (string?)s["state"]);
        Assert.Equal(("CNC-02", (double?)300), f.Engine.Faults.Last());
        ContractShape.AssertKnownFields(ContractShape.Example("tick.json")["data"]!["assets"], new JsonArray(s.DeepClone()));

        // body is optional: MTTR-drawn duration
        s = await Send(c, HttpMethod.Post, "/api/assets/CNC-01/fault");
        Assert.Equal("fault", (string?)s["state"]);
        Assert.Equal(("CNC-01", (double?)null), f.Engine.Faults.Last());

        s = await Send(c, HttpMethod.Delete, "/api/assets/CNC-02/fault");
        Assert.Equal("idle", (string?)s["state"]);

        await Send(c, HttpMethod.Post, "/api/assets/NOPE/fault", new FaultRequest(), HttpStatusCode.NotFound);
        await Send(c, HttpMethod.Delete, "/api/assets/NOPE/fault", expect: HttpStatusCode.NotFound);
        await Send(c, HttpMethod.Post, "/api/assets/CNC-01/fault", new FaultRequest(-5), HttpStatusCode.BadRequest);

        // engine state events are drained, renumbered and logged
        var events = (await GetJson(c, "/api/events?limit=1000")).AsArray();
        Assert.Contains(events, e => (string?)e!["kind"] == "state" && (string?)e["to"] == "fault");
        var ids = events.Select(e => (long)e!["id"]!).ToArray();
        Assert.Equal(ids.Order().Distinct(), ids);
    }

    [Fact]
    public async Task Maintenance_and_enable_toggles()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        Assert.Equal("maintenance", (string?)(await Send(c, HttpMethod.Post, "/api/assets/ROB-01/maintenance", new ToggleRequest(true)))["state"]);
        Assert.Equal("idle", (string?)(await Send(c, HttpMethod.Post, "/api/assets/ROB-01/maintenance", new ToggleRequest(false)))["state"]);
        Assert.Equal("off", (string?)(await Send(c, HttpMethod.Post, "/api/assets/ROB-01/enable", new ToggleRequest(false)))["state"]);
        await Send(c, HttpMethod.Post, "/api/assets/XX/enable", new ToggleRequest(true), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task History_returns_one_sample_per_sim_second()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        await Send(c, HttpMethod.Post, "/api/sim/start");
        f.RunSimSeconds(5);

        var json = await GetJson(c, "/api/history/CNC-01.temp?seconds=600");
        ContractShape.AssertSameFields(ContractShape.Example("history.json"), json, "history");
        Assert.Equal("CNC-01.temp", (string?)json["sensorId"]);
        Assert.Equal("°C", (string?)json["unit"]);
        Assert.Equal(new long[] { 0, 1000, 2000, 3000, 4000, 5000 }, json["t"]!.AsArray().Select(x => (long)x!));
        Assert.Equal(new double[] { 0, 1, 2, 3, 4, 5 }, json["v"]!.AsArray().Select(x => (double)x!));
        Assert.True(f.Detector.Observations >= 5);

        var last2 = await GetJson(c, "/api/history/CNC-01.temp?seconds=2");
        Assert.Equal(new long[] { 3000, 4000, 5000 }, last2["t"]!.AsArray().Select(x => (long)x!));

        await Send(c, HttpMethod.Get, "/api/history/NOPE.temp", expect: HttpStatusCode.NotFound);
        await Send(c, HttpMethod.Get, "/api/history/CNC-01.temp?seconds=0", expect: HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Csv_export_has_header_and_one_row_per_second()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        await Send(c, HttpMethod.Post, "/api/sim/start");
        f.RunSimSeconds(4);

        var res = await c.GetAsync("/api/export/csv?seconds=3600");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("text/csv", res.Content.Headers.ContentType?.MediaType);
        var cd = res.Content.Headers.ContentDisposition;
        Assert.NotNull(cd);
        Assert.Equal("attachment", cd!.DispositionType);
        Assert.EndsWith(".csv", cd.FileNameStar ?? cd.FileName?.Trim('"'));

        var lines = (await res.Content.ReadAsStringAsync()).TrimEnd('\n').Split('\n');
        var sensors = f.Engine.Plant.Sensors.Select(s => s.Id);
        Assert.Equal("simTimeMs," + string.Join(",", sensors), lines[0]);
        Assert.Equal(6, lines.Length); // header + t=0..4 s
        Assert.StartsWith("4000,4", lines[^1]);
        Assert.All(lines.Skip(1), l => Assert.Equal(f.Engine.Plant.Sensors.Count + 1, l.Split(',').Length));

        var bad = await c.GetAsync("/api/export/csv?seconds=-1");
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
    }

    [Fact]
    public async Task Events_limit_and_validation()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        await Send(c, HttpMethod.Post, "/api/sim/start");
        await Send(c, HttpMethod.Post, "/api/sim/pause");
        var all = (await GetJson(c, "/api/events")).AsArray();
        Assert.Equal(3, all.Count); // init + 2 commands
        ContractShape.AssertKnownFields(ContractShape.Example("event.json")["data"], all[1]);
        var one = (await GetJson(c, "/api/events?limit=1")).AsArray();
        Assert.Single(one);
        Assert.Equal((long)all[2]!["id"]!, (long)one[0]!["id"]!);
        await Send(c, HttpMethod.Get, "/api/events?limit=0", expect: HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Alarms_list_and_ack()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        await Send(c, HttpMethod.Post, "/api/sim/start");
        f.Detector.Pending.Enqueue(FakeAnomalyDetector.VibAlarm());
        f.RunSimSeconds(1);

        var alarms = (await GetJson(c, "/api/alarms")).AsArray();
        var alarm = Assert.Single(alarms);
        ContractShape.AssertKnownFields(ContractShape.Example("alarm.json")["data"], alarm);
        Assert.Equal(1000, (long)alarm!["raisedAtMs"]!);

        var acked = await Send(c, HttpMethod.Post, "/api/alarms/ALM-CNC-01.vib-limit/ack");
        Assert.True((bool)acked["acknowledged"]!);
        await Send(c, HttpMethod.Post, "/api/alarms/NOPE/ack", expect: HttpStatusCode.NotFound);

        var events = (await GetJson(c, "/api/events")).AsArray();
        Assert.Contains(events, e => (string?)e!["kind"] == "alarm" && (string?)e["severity"] == "warning");
    }

    [Fact]
    public async Task Whatif_passes_request_and_live_plant_to_runner()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        await Send(c, HttpMethod.Patch, "/api/assets/BUF-01/params", new ParamsRequest(new Dictionary<string, double> { ["capacity"] = 99 }));

        var body = ContractShape.Example("whatif.request.json").ToJsonString();
        var json = await Send(c, HttpMethod.Post, "/api/whatif", body);
        ContractShape.AssertKnownFields(ContractShape.Example("whatif.result.json"), json);
        Assert.Equal(28800, (double)json["durationS"]!);
        Assert.Equal(42, (int)json["seed"]!);

        var req = f.WhatIf.LastRequest!;
        Assert.Equal(2, req.Overrides.Count);
        Assert.Equal(30, req.Overrides[0].Params["capacity"]);
        Assert.True(req.FromLive);
        Assert.Equal(99, f.WhatIf.LastBasePlant!.Assets.Single(a => a.Id == "BUF-01").Params["capacity"]);

        // fromLive=false starts from the original model
        await Send(c, HttpMethod.Post, "/api/whatif", new WhatIfRequest(600, [], FromLive: false));
        Assert.NotEqual(99, f.WhatIf.LastBasePlant!.Assets.Single(a => a.Id == "BUF-01").Params["capacity"]);

        await Send(c, HttpMethod.Post, "/api/whatif", new WhatIfRequest(600, [new WhatIfOverride("NOPE", new Dictionary<string, double>())]), HttpStatusCode.NotFound);
        await Send(c, HttpMethod.Post, "/api/whatif", new WhatIfRequest(0, []), HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Whatif_rejects_concurrent_runs_with_409()
    {
        await using var f = new TwinApiFactory();
        var c = f.CreateClient();
        f.WhatIf.Release.Reset();
        var first = c.PostAsJsonAsync("/api/whatif", new WhatIfRequest(600, []));
        Assert.True(f.WhatIf.Entered.Wait(TimeSpan.FromSeconds(5)));

        // live host stays responsive while the what-if runs
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/state")).StatusCode);
        await Send(c, HttpMethod.Post, "/api/whatif", new WhatIfRequest(600, []), HttpStatusCode.Conflict);

        f.WhatIf.Release.Set();
        Assert.Equal(HttpStatusCode.OK, (await first).StatusCode);
        await Send(c, HttpMethod.Post, "/api/whatif", new WhatIfRequest(600, [])); // free again
    }

    [Fact]
    public async Task Unknown_api_route_is_problem_404()
    {
        await using var f = new TwinApiFactory();
        await Send(f.CreateClient(), HttpMethod.Get, "/api/nope", expect: HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Missing_body_is_400()
    {
        await using var f = new TwinApiFactory();
        var res = await f.CreateClient().PostAsync("/api/sim/speed", new StringContent("not json", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Malformed_fault_body_is_400()
    {
        await using var f = new TwinApiFactory();
        await Send(f.CreateClient(), HttpMethod.Post, "/api/assets/CNC-01/fault", "{oops", HttpStatusCode.BadRequest);
    }
}
