using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

public class ConnectionManagerTests
{
    [Fact]
    public async Task Connections_are_started_with_their_bindings_and_listed()
    {
        var (f, src) = await ShadowModeTests.ConnectedAsync(shadow: false);
        await using var _f = f;
        Assert.Single(f.OpcUa.Created);
        Assert.Empty(f.Mqtt.Created);
        Assert.Equal(1, src.StartCount);
        Assert.Equal(98, src.Bindings.Count);
        Assert.All(src.Bindings, b => Assert.Equal("plc1", b.ConnectionId));

        var list = await f.CreateClient().GetFromJsonAsync<JsonArray>("/api/connections");
        var plc = Assert.Single(list!)!;
        ContractShape.AssertKnownFields(ContractShape.ConnectionDataExample(), plc);
        Assert.Equal("plc1", (string?)plc["id"]);
        Assert.Equal("opcua", (string?)plc["kind"]);
        Assert.Equal("connected", (string?)plc["status"]);
        Assert.Equal(98, (int)plc["boundTags"]!);

        var state = await f.CreateClient().GetFromJsonAsync<JsonObject>("/api/state");
        Assert.Equal("plc1", (string?)state!["connections"]![0]!["id"]);
    }

    [Fact]
    public async Task Plants_without_connections_report_an_empty_list()
    {
        await using var f = new TwinApiFactory();
        var list = await f.CreateClient().GetFromJsonAsync<JsonArray>("/api/connections");
        Assert.Empty(list!);
        var state = await f.CreateClient().GetFromJsonAsync<JsonObject>("/api/state");
        Assert.Empty(state!["connections"]!.AsArray());
    }

    [Fact]
    public async Task Status_changes_are_broadcast_as_connection_frames()
    {
        var (f, src) = await ShadowModeTests.ConnectedAsync(shadow: false);
        await using var _f = f;
        using var ws = await f.ConnectAsync();
        var snap = await Ws.ReceiveAsync(ws);
        Assert.Equal("connected", (string?)snap["data"]!["connections"]![0]!["status"]);

        src.SetStatus(ConnectionState.Error, "boom");
        var (frame, all) = await Ws.ReceiveUntilAsync(ws, "connection");
        ContractShape.AssertSameFields(ContractShape.Example("connection.json"), frame, "envelope");
        ContractShape.AssertKnownFields(ContractShape.ConnectionDataExample(), frame["data"]);
        Assert.Equal("plc1", (string?)frame["data"]!["id"]);
        Assert.Equal("error", (string?)frame["data"]!["status"]);
        Assert.Equal("boom", (string?)frame["data"]!["error"]);
        Assert.Equal(ConnectionState.Error, f.Connections.Statuses.Single().Status);

        var (ev, _) = await Ws.ReceiveUntilAsync(ws, "event");
        Assert.Equal("Connection plc1 error: boom", (string?)ev["data"]!["message"]);

        src.SetStatus(ConnectionState.Connected);
        (frame, _) = await Ws.ReceiveUntilAsync(ws, "connection");
        Assert.Equal("connected", (string?)frame["data"]!["status"]);
        await Ws.CloseAsync(ws);
    }

    [Fact]
    public async Task Reconnect_is_404_for_unknown_ids_and_restarts_the_source()
    {
        var (f, first) = await ShadowModeTests.ConnectedAsync(shadow: false);
        await using var _f = f;
        var c = f.CreateClient();

        var res = await c.PostAsync("/api/connections/nope/reconnect", null);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);

        res = await c.PostAsync("/api/connections/plc1/reconnect", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var status = await res.Content.ReadFromJsonAsync<ConnectionStatus>(TwinJson.Options);
        Assert.Equal("plc1", status!.Id);
        Assert.Equal(ConnectionState.Connected, status.Status);

        Assert.Equal(2, f.OpcUa.Created.Count);
        Assert.Equal(1, first.StopCount);
        Assert.True(first.Disposed);
        var second = f.OpcUa.Last;
        Assert.Equal(1, second.StartCount);

        // The old source is detached: its updates and status changes are ignored.
        first.SetStatus(ConnectionState.Error, "old");
        Assert.Equal(ConnectionState.Connected, f.Connections.Statuses.Single().Status);
    }

    [Fact]
    public async Task Plant_change_restarts_sources()
    {
        var (f, old) = await ShadowModeTests.ConnectedAsync(shadow: false);
        await using var _f = f;
        var plant = f.Host.GetPlant();
        var changed = plant with
        {
            Connections = [.. plant.Connections!, new ConnectionDef("broker", ConnectionKind.Mqtt, "mqtt://localhost:1883")],
            Bindings = [.. plant.Bindings!.Where(b => b.Target != "sensor:CNC-01.vib"),
                new BindingDef("sensor:CNC-01.vib", "broker", "lineA/CNC-01/vib", JsonPath: "$.value")],
        };

        f.Host.RaisePlantChanged(changed);
        await Eventually.True(() => f.OpcUa.Created.Count == 2 && f.Mqtt.Created.Count == 1, "sources recreated");
        await f.Connections.Idle;

        Assert.Equal(1, old.StopCount);
        Assert.True(old.Disposed);
        Assert.Equal(97, f.OpcUa.Last.Bindings.Count);
        Assert.Equal("lineA/CNC-01/vib", Assert.Single(f.Mqtt.Last.Bindings).Address);
        Assert.Equal(["plc1", "broker"], f.Connections.Statuses.Select(s => s.Id));

        // Updates from the new MQTT source reach the twin.
        f.Host.SetMode(TwinMode.Shadow);
        f.Mqtt.Last.Push("lineA/CNC-01/vib", 3.25);
        f.Host.Advance(TimeSpan.Zero);
        Assert.Equal(3.25, f.Host.GetTick().Sensors.Single(s => s.Id == "CNC-01.vib").V);
    }

    [Fact]
    public async Task Invalid_connections_and_failing_factories_are_reported_not_started()
    {
        var (f, _) = await ShadowModeTests.ConnectedAsync(shadow: false);
        await using var _f = f;
        var plant = f.Host.GetPlant();
        f.Mqtt.Throw = true;
        var changed = plant with
        {
            Connections = [.. plant.Connections!,
                new ConnectionDef("bad", ConnectionKind.Opcua, ""),
                new ConnectionDef("broker", ConnectionKind.Mqtt, "mqtt://localhost:1883")],
            Bindings = [.. plant.Bindings!, new BindingDef("sensor:NOPE.temp", "bad", "x")],
        };

        f.Host.RaisePlantChanged(changed);
        await Eventually.True(() => f.Connections.Statuses.Count == 3, "three connections listed");
        await f.Connections.Idle;

        var byId = f.Connections.Statuses.ToDictionary(s => s.Id);
        Assert.Equal(ConnectionState.Connected, byId["plc1"].Status);
        Assert.Equal(ConnectionState.Error, byId["bad"].Status);
        Assert.Contains("no endpoint", byId["bad"].Error);
        Assert.Contains("does not exist", byId["bad"].Error);
        Assert.Equal(ConnectionState.Error, byId["broker"].Status);
        Assert.Contains("not implemented", byId["broker"].Error);
        Assert.Equal(2, f.OpcUa.Created.Count); // plc1 twice, "bad" never

        var res = await f.CreateClient().PostAsync("/api/connections/bad/reconnect", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(2, f.OpcUa.Created.Count);
    }

    [Fact]
    public async Task Shutdown_stops_the_sources()
    {
        var (f, src) = await ShadowModeTests.ConnectedAsync(shadow: false);
        await f.DisposeAsync();
        Assert.Equal(1, src.StopCount);
        Assert.True(src.Disposed);
    }
}
