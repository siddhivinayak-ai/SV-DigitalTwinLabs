using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using TwinLabs.Analytics;
using TwinLabs.Api.Hosting;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

public class ShadowModeTests
{
    internal const string Temp = "ns=2;s=LineA.CNC-01.Temp";
    internal const string Vib = "ns=2;s=LineA.CNC-01.Vib";
    internal const string State = "ns=2;s=LineA.CNC-01.State";
    internal const string Good = "ns=2;s=LineA.CNC-01.Good";

    /// <summary>Connected sample plant, sources started, optionally switched to shadow and running.</summary>
    internal static async Task<(TwinApiFactory F, FakeTagSource Src)> ConnectedAsync(bool shadow = true, TwinApiFactory? factory = null)
    {
        var f = factory ?? new TwinApiFactory { PlantPath = TwinApiFactory.ConnectedPlant };
        _ = f.Host;
        await f.Connections.Idle;
        var src = f.OpcUa.Last;
        if (shadow)
        {
            f.Host.SetMode(TwinMode.Shadow);
            f.Host.Start();
        }
        return (f, src);
    }

    private static async Task<JsonObject> PostJson(HttpClient c, string url, object body, HttpStatusCode expect = HttpStatusCode.OK)
    {
        var res = await c.PostAsJsonAsync(url, body, TwinJson.Options);
        var text = await res.Content.ReadAsStringAsync();
        Assert.True(res.StatusCode == expect, $"{url}: expected {(int)expect}, got {(int)res.StatusCode}: {text}");
        return JsonNode.Parse(text)!.AsObject();
    }

    private static SensorValue Sensor(TickData t, string id) => t.Sensors.Single(s => s.Id == id);
    private static AssetState Asset(TickData t, string id) => t.Assets.Single(a => a.Id == id);

    [Fact]
    public async Task Shadow_without_bindings_is_409_over_rest_and_an_ack_error_over_ws()
    {
        await using var f = new TwinApiFactory();
        var problem = await PostJson(f.CreateClient(), "/api/twin/mode", new TwinModeRequest(TwinMode.Shadow), HttpStatusCode.Conflict);
        Assert.Contains("binding", (string?)problem["detail"]);
        Assert.Equal(TwinMode.Simulate, f.Host.Status.Mode);

        using var ws = await f.ConnectAsync();
        await Ws.ReceiveAsync(ws);
        await Ws.SendTextAsync(ws, ContractShape.Example("command.twin.mode.json").ToJsonString());
        var (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.Equal("c-0009", (string?)ack["data"]!["commandId"]);
        Assert.False((bool)ack["data"]!["ok"]!);
        Assert.Contains("binding", (string?)ack["data"]!["error"]);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Mode_switch_over_rest_fixes_speed_and_rejects_speed_changes()
    {
        var (f, _) = await ConnectedAsync(shadow: false);
        await using var _f = f;
        var c = f.CreateClient();
        Assert.Equal(10, (await PostJson(c, "/api/sim/speed", new SpeedRequest(10)))["speed"]!.GetValue<double>());

        var status = await PostJson(c, "/api/twin/mode", new TwinModeRequest(TwinMode.Shadow));
        Assert.Equal("shadow", (string?)status["mode"]);
        Assert.Equal(1, status["speed"]!.GetValue<double>());
        ContractShape.AssertSameFields(ContractShape.Example("snapshot.json")["data"]!["sim"], status, "sim");

        var problem = await PostJson(c, "/api/sim/speed", new SpeedRequest(10), HttpStatusCode.Conflict);
        Assert.Contains("shadow", (string?)problem["detail"]);
        Assert.Equal(1, f.Host.Status.Speed);

        var state = await f.CreateClient().GetFromJsonAsync<JsonObject>("/api/state");
        Assert.Equal("shadow", (string?)state!["sim"]!["mode"]);

        status = await PostJson(c, "/api/twin/mode", new { mode = "simulate" });
        Assert.Equal("simulate", (string?)status["mode"]);
        Assert.Equal(4, (await PostJson(c, "/api/sim/speed", new SpeedRequest(4)))["speed"]!.GetValue<double>());
    }

    [Fact]
    public async Task Mode_switch_over_ws_is_acked_and_speed_is_rejected_in_shadow()
    {
        var (f, _) = await ConnectedAsync(shadow: false);
        await using var _f = f;
        using var ws = await f.ConnectAsync();
        await Ws.ReceiveAsync(ws);

        await Ws.SendTextAsync(ws, ContractShape.Example("command.twin.mode.json").ToJsonString());
        var (ack, frames) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.True((bool)ack["data"]!["ok"]!, (string?)ack["data"]!["error"]);
        Assert.Equal(TwinMode.Shadow, f.Host.Mode);
        var snap = frames.Single(fr => (string?)fr["type"] == "snapshot");
        Assert.Equal("shadow", (string?)snap["data"]!["sim"]!["mode"]);

        await Ws.SendTextAsync(ws, ContractShape.Example("command.sim.speed.json").ToJsonString());
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.False((bool)ack["data"]!["ok"]!);
        Assert.Contains("shadow mode", (string?)ack["data"]!["error"]);

        await Ws.SendTextAsync(ws, """{"type":"command","data":{"id":"m-2","action":"twin.mode","value":7}}""");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.False((bool)ack["data"]!["ok"]!);

        await Ws.SendTextAsync(ws, """{"type":"command","data":{"id":"m-3","action":"twin.mode","value":0}}""");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.True((bool)ack["data"]!["ok"]!);
        Assert.Equal(TwinMode.Simulate, f.Host.Status.Mode);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Twin_mode_config_starts_in_shadow_only_with_bindings()
    {
        var (f, _) = await ConnectedAsync(shadow: false, new TwinApiFactory { PlantPath = TwinApiFactory.ConnectedPlant, Mode = "shadow" });
        await using (f)
        {
            Assert.Equal(TwinMode.Shadow, f.Host.Status.Mode);
            Assert.Equal(1, f.Host.Status.Speed);
        }

        await using var plain = new TwinApiFactory { Mode = "shadow" };
        Assert.Equal(TwinMode.Simulate, plain.Host.Status.Mode);
    }

    [Fact]
    public async Task Actual_values_override_the_predictor_in_tick_and_snapshot()
    {
        var (f, src) = await ConnectedAsync();
        await using var _f = f;
        f.RunSimSeconds(3);

        src.Push(Temp, 99.5);
        src.Push(State, 2); // running
        src.Push(Good, 1234);
        f.Host.Advance(TimeSpan.Zero);

        var tick = f.Host.GetTick();
        Assert.Equal(99.5, Sensor(tick, "CNC-01.temp").V);
        Assert.Equal(3, Sensor(tick, "CNC-01.vib").V);            // no value yet: predictor (fake = sim seconds)
        Assert.Equal(AssetStateKind.Running, Asset(tick, "CNC-01").State);
        Assert.Equal(1234, Asset(tick, "CNC-01").Good);
        Assert.Equal(AssetStateKind.Idle, Asset(tick, "CNC-02").State); // not pushed: predictor
        Assert.Single(tick.Parts);                                  // parts always from the predictor
        Assert.Equal(TwinMode.Shadow, tick.Sim.Mode);

        var snap = f.Host.GetSnapshot();
        Assert.Equal(99.5, snap.Sensors.Single(s => s.Id == "CNC-01.temp").V);

        // An actual state transition is logged; the predictor's own value is untouched.
        src.Push(State, 5);
        f.Host.Advance(TimeSpan.Zero);
        Assert.Equal(AssetStateKind.Fault, Asset(f.Host.GetTick(), "CNC-01").State);
        Assert.Contains(f.Host.GetEvents(50), e => e.Message == "CNC-01 running -> fault (actual)" && e.To == AssetStateKind.Fault);
        Assert.Equal(AssetStateKind.Idle, f.Engine.GetAssetStates().Single(a => a.Id == "CNC-01").State);

        // History and the detector see the actual value too.
        f.RunSimSeconds(1);
        src.Push(Temp, 99.5);
        f.RunSimSeconds(1);
        Assert.Equal(99.5, f.Host.GetHistory("CNC-01.temp", 1).V[^1]);

        // Back in simulate mode the engine drives the twin again.
        f.Host.SetMode(TwinMode.Simulate);
        tick = f.Host.GetTick();
        Assert.Equal(f.Host.SimTimeMs / 1000.0, Sensor(tick, "CNC-01.temp").V);
        Assert.Equal(AssetStateKind.Idle, Asset(tick, "CNC-01").State);
    }

    [Fact]
    public async Task Ws_tick_carries_actual_values()
    {
        var (f, src) = await ConnectedAsync(factory: new TwinApiFactory { PlantPath = TwinApiFactory.ConnectedPlant, ManualLoop = false, TickHz = 20 });
        await using var _f = f;
        using var ws = await f.ConnectAsync();
        await Ws.ReceiveAsync(ws);
        src.Push(Temp, 77.25);

        for (var i = 0; i < 100; i++)
        {
            var (tick, _) = await Ws.ReceiveUntilAsync(ws, "tick");
            var temp = tick["data"]!["sensors"]!.AsArray().Single(s => (string?)s!["id"] == "CNC-01.temp")!;
            if ((double)temp["v"]! != 77.25) continue;
            Assert.Equal("shadow", (string?)tick["data"]!["sim"]!["mode"]);
            ContractShape.AssertSameFields(ContractShape.Example("tick.json")["data"], tick["data"], "tick.data");
            await Ws.CloseAsync(ws);
            return;
        }
        Assert.Fail("no tick with the actual value");
    }

    [Fact]
    public async Task Stale_values_fall_back_to_the_predictor()
    {
        var (f, src) = await ConnectedAsync();
        await using var _f = f;
        f.RunSimSeconds(2);

        src.Push(Temp, 99, FakeTagSource.NowMs - 6000);
        f.Host.Advance(TimeSpan.Zero);
        Assert.Equal(2, Sensor(f.Host.GetTick(), "CNC-01.temp").V);

        // Any fresh update on the same connection proves the link is alive: the last (unchanged) value counts again.
        src.Push(Vib, 1.5);
        f.Host.Advance(TimeSpan.Zero);
        Assert.Equal(99, Sensor(f.Host.GetTick(), "CNC-01.temp").V);
    }

    [Fact]
    public async Task Deviation_alarm_raises_after_10_samples_and_clears_after_10_calm_ones()
    {
        var sink = new FakeSink();
        var (f, src) = await ConnectedAsync(factory: new TwinApiFactory { PlantPath = TwinApiFactory.ConnectedPlant, Sinks = [sink] });
        await using var _f = f;
        const string id = "ALM-CNC-01.temp-deviation";

        // The fake predictor reads k at sim second k; the actual reads k + 1000.
        for (var k = 1; k <= 10; k++)
        {
            Assert.DoesNotContain(f.Host.GetActiveAlarms(), a => a.Id == id);
            src.Push(Temp, k + 1000);
            f.RunSimSeconds(1);
        }
        var alarm = Assert.Single(f.Host.GetActiveAlarms(), a => a.Id == id);
        Assert.Equal(AlarmSource.Deviation, alarm.Source);
        Assert.Equal(Severity.Warning, alarm.Severity);
        Assert.Equal("CNC-01", alarm.AssetId);
        Assert.Equal("CNC-01.temp", alarm.SensorId);
        Assert.Equal(1010, alarm.Value);
        Assert.Equal(10, alarm.Limit);
        Assert.Contains(f.Host.GetSnapshot().Alarms, a => a.Id == id);

        var json = JsonNode.Parse(TwinJson.Serialize(alarm))!;
        ContractShape.AssertKnownFields(ContractShape.Example("alarm.deviation.json")["data"], json);
        ContractShape.AssertSameFields(ContractShape.Example("alarm.deviation.json")["data"], json, "deviation alarm");

        var c = f.CreateClient();
        var acked = await c.PostAsync($"/api/alarms/{id}/ack", null);
        Assert.Equal(HttpStatusCode.OK, acked.StatusCode);
        Assert.True(f.Host.GetActiveAlarms().Single(a => a.Id == id).Acknowledged);

        for (var k = 11; k <= 19; k++)
        {
            src.Push(Temp, k);
            f.RunSimSeconds(1);
            Assert.Contains(f.Host.GetActiveAlarms(), a => a.Id == id);
        }
        src.Push(Temp, 20);
        f.RunSimSeconds(1);
        Assert.DoesNotContain(f.Host.GetActiveAlarms(), a => a.Id == id);
        Assert.Contains(f.Host.GetEvents(100), e => e.Kind == EventKind.Alarm && e.Message.StartsWith("CLEARED CNC-01.temp deviates"));

        await Eventually.True(() => sink.Alarms.Count(a => a.Id == id) >= 3, "raised, acked and cleared alarms forwarded");
        Assert.Contains(sink.Alarms, a => a.Id == id && !a.Active && a.ClearedAtMs == 20_000);
    }

    [Fact]
    public async Task No_deviation_in_simulate_mode_or_without_fresh_values()
    {
        var (f, src) = await ConnectedAsync(shadow: false);
        await using var _f = f;
        f.Host.Start();
        for (var k = 1; k <= 12; k++)
        {
            src.Push(Temp, k + 1000);
            f.RunSimSeconds(1);
        }
        Assert.Empty(f.Host.GetActiveAlarms());
    }

    [Fact]
    public async Task No_deviation_without_fresh_values()
    {
        var (f, src) = await ConnectedAsync();
        await using var _f = f;
        for (var k = 1; k <= 12; k++)
        {
            // Old timestamps and nothing else from the connection: stale, so nothing to compare.
            src.Push(Temp, k + 1000, FakeTagSource.NowMs - 60_000);
            f.RunSimSeconds(1);
        }
        Assert.Empty(f.Host.GetActiveAlarms());
    }

    [Fact]
    public void Shadow_engine_view_feeds_the_kpi_calculator_from_actual_states_and_counters()
    {
        var plant = TwinJson.LoadPlant(TwinApiFactory.ConnectedPlant);
        var engine = new FakeEngine(plant, 1);
        var view = new ShadowEngineView(engine);
        var states = engine.GetAssetStates();

        for (var s = 1; s <= 4; s++)
        {
            for (var i = 0; i < 10; i++) engine.Step();
            var twin = states.Select(a => a.Id == "CNC-01" ? a with { State = s <= 3 ? AssetStateKind.Running : AssetStateKind.Fault } : a).ToList();
            view.Accumulate(engine.SimTimeMs, twin, engine.GetSensorValues(),
                new Dictionary<string, (long, long)> { ["CNC-01"] = (6, 2), ["SNK-01"] = (6, 0) }, wipDelta: 3);
        }

        var stats = view.GetAssetStats().Single(a => a.AssetId == "CNC-01");
        Assert.Equal(3, stats.StateSeconds.Running, 6);
        Assert.Equal(1, stats.StateSeconds.Fault, 6);
        Assert.Equal((6, 2, 8), (stats.Good, stats.Scrap, stats.Total));
        Assert.Equal(50, stats.IdealCycleTimeS);
        Assert.Equal(3, view.Wip);
        Assert.Empty(view.DrainEvents());

        var kpi = new KpiCalculator().Compute(view);
        var cnc = kpi.Assets.Single(a => a.AssetId == "CNC-01");
        Assert.Equal(0.75, cnc.Availability, 6);
        Assert.Equal(0.75, cnc.Quality, 6);
        Assert.Equal(6, kpi.Line.Good);

        Assert.Throws<NotSupportedException>(() => view.Step());
        Assert.Throws<NotSupportedException>(() => view.InjectFault("CNC-01"));
        Assert.Throws<NotSupportedException>(() => view.UpdateParams("CNC-01", new Dictionary<string, double>()));
        Assert.Throws<NotSupportedException>(() => view.Reset(1));
    }

    [Fact]
    public async Task Kpi_in_shadow_uses_counters_since_the_session_started()
    {
        var (f, src) = await ConnectedAsync(shadow: false);
        await using var _f = f;
        src.Push(Good, 500); // the PLC has counted before the twin connected
        f.Host.Advance(TimeSpan.Zero);
        f.Host.SetMode(TwinMode.Shadow);
        f.Host.Start();

        src.Push(Good, 507);
        f.RunSimSeconds(2);
        Assert.Equal(507, f.Host.GetTick().Assets.Single(a => a.Id == "CNC-01").Good); // tick shows the actual counter
        f.Host.GetKpi();
        var engine = Assert.IsType<ShadowEngineView>(f.Kpi.LastEngine);
        Assert.Equal(7, engine.GetAssetStats().Single(s => s.AssetId == "CNC-01").Good);
    }
}
