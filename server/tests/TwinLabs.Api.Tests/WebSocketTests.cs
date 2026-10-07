using System.Net.WebSockets;
using System.Text.Json.Nodes;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

public class WebSocketTests
{
    private static void AssertEnvelope(JsonObject frame) =>
        ContractShape.AssertSameFields(ContractShape.Example("tick.json"), frame, "envelope");

    private static void AssertSeqContiguous(IEnumerable<JsonObject> frames, long first = 1)
    {
        var expected = first;
        foreach (var f in frames) Assert.Equal(expected++, (long)f["seq"]!);
    }

    [Fact]
    public async Task Snapshot_first_with_seq_1_then_ticks_with_contiguous_seq()
    {
        await using var f = new TwinApiFactory { ManualLoop = false, TickHz = 20 };
        f.Host.Start();
        using var ws = await f.ConnectAsync();

        var first = await Ws.ReceiveAsync(ws);
        AssertEnvelope(first);
        Assert.Equal("snapshot", (string?)first["type"]);
        Assert.Equal(1, (long)first["seq"]!);
        ContractShape.AssertKnownFields(ContractShape.SnapshotDataExample(), first["data"]);

        var frames = new List<JsonObject> { first };
        var ticks = new List<JsonObject>();
        while (ticks.Count < 3)
        {
            var fr = await Ws.ReceiveAsync(ws);
            frames.Add(fr);
            if ((string?)fr["type"] == "tick") ticks.Add(fr);
        }
        AssertSeqContiguous(frames);

        var tick = ticks[^1];
        AssertEnvelope(tick);
        ContractShape.AssertKnownFields(ContractShape.Example("tick.json")["data"], tick["data"]);
        ContractShape.AssertSameFields(ContractShape.Example("tick.json")["data"], tick["data"], "tick.data");
        Assert.Equal((long)tick["t"]!, (long)tick["data"]!["sim"]!["simTimeMs"]!);
        Assert.Equal("running", (string?)tick["data"]!["sim"]!["state"]);

        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Ticks_keep_flowing_while_paused()
    {
        await using var f = new TwinApiFactory { ManualLoop = false, TickHz = 20 };
        using var ws = await f.ConnectAsync();
        await Ws.ReceiveAsync(ws); // snapshot
        var (tick, _) = await Ws.ReceiveUntilAsync(ws, "tick");
        Assert.Equal("stopped", (string?)tick["data"]!["sim"]!["state"]);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Command_gets_ack_with_matching_command_id()
    {
        await using var f = new TwinApiFactory();
        using var ws = await f.ConnectAsync();
        var frames = new List<JsonObject> { await Ws.ReceiveAsync(ws) };

        await Ws.SendTextAsync(ws, ContractShape.Example("command.sim.speed.json").ToJsonString());
        var (ack, all) = await Ws.ReceiveUntilAsync(ws, "ack");
        frames.AddRange(all);

        AssertEnvelope(ack);
        ContractShape.AssertKnownFields(ContractShape.Example("ack.json")["data"], ack["data"]);
        Assert.Equal("c-0005", (string?)ack["data"]!["commandId"]);
        Assert.True((bool)ack["data"]!["ok"]!);
        Assert.Null(ack["data"]!["error"]);
        Assert.Equal(10, f.Host.Status.Speed);

        // the command is logged as an event and broadcast
        Assert.Contains(all, fr => (string?)fr["type"] == "event" && (string?)fr["data"]!["kind"] == "command");
        AssertSeqContiguous(frames);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Bad_commands_get_ok_false_and_socket_survives()
    {
        await using var f = new TwinApiFactory();
        using var ws = await f.ConnectAsync();
        await Ws.ReceiveAsync(ws);

        await Ws.SendTextAsync(ws, """{"type":"command","t":0,"seq":1,"data":{"id":"c-0007","action":"asset.fault","assetId":"CNC-09"}}""");
        var (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.Equal("c-0007", (string?)ack["data"]!["commandId"]);
        Assert.False((bool)ack["data"]!["ok"]!);
        Assert.Equal("Unknown asset 'CNC-09'", (string?)ack["data"]!["error"]);

        await Ws.SendTextAsync(ws, "{not json");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.False((bool)ack["data"]!["ok"]!);
        Assert.Equal("", (string?)ack["data"]!["commandId"]);

        await Ws.SendTextAsync(ws, """{"type":"command","data":{"id":"c-1","action":"sim.speed","value":"fast"}}""");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.Equal("c-1", (string?)ack["data"]!["commandId"]);
        Assert.False((bool)ack["data"]!["ok"]!);

        await Ws.SendTextAsync(ws, """{"type":"command","data":{"id":"c-2","action":"sim.warp"}}""");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.False((bool)ack["data"]!["ok"]!);

        await Ws.SendTextAsync(ws, """{"type":"command","data":{"id":"c-3","action":"asset.enable","assetId":"CNC-01","value":2}}""");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.False((bool)ack["data"]!["ok"]!);

        await Ws.SendTextAsync(ws, """{"type":"hello","data":{"id":"c-4"}}""");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.Equal("c-4", (string?)ack["data"]!["commandId"]);
        Assert.False((bool)ack["data"]!["ok"]!);

        // still alive and working
        Assert.Equal(WebSocketState.Open, ws.State);
        await Ws.SendTextAsync(ws, """{"type":"command","data":{"id":"c-5","action":"sim.start"}}""");
        (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.True((bool)ack["data"]!["ok"]!);
        Assert.Equal(SimRunState.Running, f.Host.Status.State);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Params_command_broadcasts_params_to_all_clients()
    {
        await using var f = new TwinApiFactory();
        using var a = await f.ConnectAsync();
        using var b = await f.ConnectAsync();
        await Ws.ReceiveAsync(a);
        await Ws.ReceiveAsync(b);

        await Ws.SendTextAsync(a, ContractShape.Example("command.asset.params.json").ToJsonString());
        var (ack, frames) = await Ws.ReceiveUntilAsync(a, "ack");
        Assert.True((bool)ack["data"]!["ok"]!);
        var p = frames.Single(fr => (string?)fr["type"] == "params");
        ContractShape.AssertKnownFields(ContractShape.Example("params.json"), p);
        Assert.Equal("BUF-01", (string?)p["data"]!["assetId"]);
        Assert.Equal(30, (double)p["data"]!["params"]!["capacity"]!);

        var (pb, _) = await Ws.ReceiveUntilAsync(b, "params");
        Assert.Equal("BUF-01", (string?)pb["data"]!["assetId"]);
        await Ws.CloseAsync(a);
        await Ws.CloseAsync(b);
    }

    [Fact]
    public async Task Reset_broadcasts_a_fresh_snapshot()
    {
        await using var f = new TwinApiFactory();
        f.Host.Start();
        f.RunSimSeconds(3);
        using var ws = await f.ConnectAsync();
        var first = await Ws.ReceiveAsync(ws);
        Assert.Equal(3000, (long)first["t"]!);

        await Ws.SendTextAsync(ws, """{"type":"command","data":{"id":"r-1","action":"sim.reset"}}""");
        var (snap, _) = await Ws.ReceiveUntilAsync(ws, "snapshot");
        Assert.Equal(0, (long)snap["t"]!);
        Assert.Equal(0, (long)snap["data"]!["sim"]!["simTimeMs"]!);
        Assert.Equal("running", (string?)snap["data"]!["sim"]!["state"]);
        var (ack, _) = await Ws.ReceiveUntilAsync(ws, "ack");
        Assert.Equal("r-1", (string?)ack["data"]!["commandId"]);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Alarm_and_kpi_frames_are_broadcast()
    {
        await using var f = new TwinApiFactory { ManualLoop = false };
        f.Host.Start();
        using var ws = await f.ConnectAsync();
        await Ws.ReceiveAsync(ws);
        f.Detector.Pending.Enqueue(FakeAnomalyDetector.VibAlarm());

        var (alarm, _) = await Ws.ReceiveUntilAsync(ws, "alarm", 500);
        ContractShape.AssertKnownFields(ContractShape.Example("alarm.json"), alarm);
        Assert.Equal("ALM-CNC-01.vib-limit", (string?)alarm["data"]!["id"]);

        var (kpi, _) = await Ws.ReceiveUntilAsync(ws, "kpi", 500);
        ContractShape.AssertKnownFields(ContractShape.Example("kpi.json"), kpi);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Disconnect_unregisters_the_client()
    {
        await using var f = new TwinApiFactory();
        var registry = (TwinLabs.Api.Realtime.ClientRegistry)f.Services.GetService(typeof(TwinLabs.Api.Realtime.ClientRegistry))!;
        using (var ws = await f.ConnectAsync())
        {
            await Ws.ReceiveAsync(ws);
            Assert.Equal(1, registry.Count);
            await Ws.CloseAsync(ws);
        }

        for (var i = 0; i < 50 && registry.Count > 0; i++) await Task.Delay(20);
        Assert.Equal(0, registry.Count);
        f.Host.Start(); // broadcasting with no clients is fine
    }
}
