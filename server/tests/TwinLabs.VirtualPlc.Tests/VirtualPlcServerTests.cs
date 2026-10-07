using System.Net.Sockets;
using Opc.Ua;
using Opc.Ua.Client;
using TwinLabs.Core.Contracts;

namespace TwinLabs.VirtualPlc.Tests;

public class VirtualPlcServerTests
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(5);

    [Fact]
    public async Task Browse_tree_exposes_line_assets_and_variables()
    {
        var plant = PlcHarness.SamplePlant();
        await using var plc = PlcHarness.Create(48401);
        await plc.StartAsync(plant, CancellationToken.None);
        using var s = await PlcHarness.ConnectAsync(plc.EndpointUrl);

        Assert.Equal(PlcNaming.NamespaceUri, s.NamespaceUris.GetString(2));

        Assert.Contains("TwinLabs", await s.BrowseNamesAsync(ObjectIds.ObjectsFolder));
        Assert.Equal(["LineA"], await s.BrowseNamesAsync(NodeId.Parse("ns=2;s=TwinLabs")));

        var line = await s.BrowseNamesAsync(NodeId.Parse("ns=2;s=LineA"));
        foreach (var a in plant.Assets) Assert.Contains(a.Id, line);
        Assert.Contains("SimTimeMs", line);
        foreach (var m in new[] { "Start", "Pause", "SetSpeed", "InjectFault", "ClearFault" }) Assert.Contains(m, line);

        var cnc = await s.BrowseNamesAsync(NodeId.Parse("ns=2;s=LineA.CNC-01"));
        foreach (var n in new[] { "State", "Good", "Scrap", "Wip", "Load", "Wear", "Temp", "Vib", "Power", "Current" })
            Assert.Contains(n, cnc);

        // The sink's Good is both an asset counter and a sensor: one variable.
        var sink = await s.BrowseNamesAsync(NodeId.Parse("ns=2;s=LineA.SNK-01"));
        Assert.Single(sink, n => n == "Good");

        await s.CloseAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Every_plc_binding_resolves_with_the_right_type_and_values_change_in_standalone()
    {
        var plant = PlcHarness.SamplePlant();
        var factory = new RecordingFactory();
        await using var plc = PlcHarness.Create(48402, speed: 20, factory: factory);
        await plc.StartAsync(plant, CancellationToken.None);
        Assert.Equal(plant.Seed + 1000, factory.LastSeed);
        using var s = await PlcHarness.ConnectAsync(plc.EndpointUrl);

        var bindings = plant.Bindings!.Where(b => b.ConnectionId == "plc1").ToList();
        Assert.NotEmpty(bindings);
        var values = await s.ReadValuesAsync(bindings.Select(b => NodeId.Parse(b.Address)).ToList(), CancellationToken.None);
        for (var i = 0; i < bindings.Count; i++)
        {
            var (dv, err) = (values.Item1[i], values.Item2[i]);
            Assert.True(ServiceResult.IsGood(err), $"{bindings[i].Address}: {err}");
            if (bindings[i].Target.EndsWith(".state", StringComparison.Ordinal)) Assert.IsType<int>(dv.Value);
            else Assert.IsType<double>(dv.Value);
        }

        var simTime = (long)(await s.ReadAsync("ns=2;s=LineA.SimTimeMs")).Value;
        string[] watched = ["ns=2;s=LineA.CNC-01.Temp", "ns=2;s=LineA.CNC-01.Power", "ns=2;s=LineA.CONV-01.Level", "ns=2;s=LineA.SRC-01.Good"];
        var before = new List<object>();
        foreach (var id in watched) before.Add((await s.ReadAsync(id)).Value);

        Assert.True(await PlcHarness.EventuallyAsync(async () =>
            (long)(await s.ReadAsync("ns=2;s=LineA.SimTimeMs")).Value >= simTime + 20_000, Wait), "sim time advances in real time x speed");
        var changed = 0;
        for (var i = 0; i < watched.Length; i++)
            if (!Equals(before[i], (await s.ReadAsync(watched[i])).Value)) changed++;
        Assert.True(changed >= 2, $"only {changed} of {watched.Length} values changed");

        // Host publishes are ignored in standalone mode.
        plc.Publish(1, [new AssetState("CNC-01", AssetStateKind.Maintenance, 0, 0, 0, 0, 999_999, 0, 0)], []);
        Assert.NotEqual(999_999d, (await s.ReadAsync("ns=2;s=LineA.CNC-01.Good")).Value);

        await s.CloseAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Methods_inject_and_clear_faults_and_reject_bad_input()
    {
        var plant = PlcHarness.SamplePlant();
        await using var plc = PlcHarness.Create(48403);
        await plc.StartAsync(plant, CancellationToken.None);
        using var s = await PlcHarness.ConnectAsync(plc.EndpointUrl);
        const string line = "ns=2;s=LineA";

        Assert.True(StatusCode.IsGood(await s.CallAsync(line, "ns=2;s=LineA.InjectFault", "CNC-01", 600.0)));
        Assert.True(await PlcHarness.EventuallyAsync(async () =>
            (int)(await s.ReadAsync("ns=2;s=LineA.CNC-01.State")).Value == (int)AssetStateKind.Fault, Wait));

        Assert.True(StatusCode.IsGood(await s.CallAsync(line, "ns=2;s=LineA.ClearFault", "CNC-01")));
        Assert.True(await PlcHarness.EventuallyAsync(async () =>
            (int)(await s.ReadAsync("ns=2;s=LineA.CNC-01.State")).Value != (int)AssetStateKind.Fault, Wait));

        Assert.True(StatusCode.IsBad(await s.CallAsync(line, "ns=2;s=LineA.InjectFault", "NOPE-99", 10.0)));
        Assert.True(StatusCode.IsBad(await s.CallAsync(line, "ns=2;s=LineA.InjectFault", "CNC-01", -5.0)));
        Assert.True(StatusCode.IsBad(await s.CallAsync(line, "ns=2;s=LineA.InjectFault", "CNC-01")));      // missing arg
        Assert.True(StatusCode.IsBad(await s.CallAsync(line, "ns=2;s=LineA.SetSpeed", "fast")));            // wrong type
        Assert.True(StatusCode.IsBad(await s.CallAsync(line, "ns=2;s=LineA.SetSpeed", 0.0)));
        Assert.True(StatusCode.IsGood(await s.CallAsync(line, "ns=2;s=LineA.SetSpeed", 50.0)));
        Assert.True(await PlcHarness.EventuallyAsync(async () =>
            (double)(await s.ReadAsync("ns=2;s=LineA.Speed")).Value == 50.0, Wait));

        // Pause freezes sim time, Start resumes it.
        Assert.True(StatusCode.IsGood(await s.CallAsync(line, "ns=2;s=LineA.Pause")));
        Assert.True(await PlcHarness.EventuallyAsync(async () => !(bool)(await s.ReadAsync("ns=2;s=LineA.Running")).Value, Wait));
        var paused = (long)(await s.ReadAsync("ns=2;s=LineA.SimTimeMs")).Value;
        await Task.Delay(400);
        Assert.Equal(paused, (long)(await s.ReadAsync("ns=2;s=LineA.SimTimeMs")).Value);
        Assert.True(StatusCode.IsGood(await s.CallAsync(line, "ns=2;s=LineA.Start")));
        Assert.True(await PlcHarness.EventuallyAsync(async () =>
            (long)(await s.ReadAsync("ns=2;s=LineA.SimTimeMs")).Value > paused, Wait));

        await s.CloseAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Mirror_mode_reflects_published_values()
    {
        var plant = PlcHarness.SamplePlant();
        await using var plc = PlcHarness.Create(48404, standalone: false);
        await plc.StartAsync(plant, CancellationToken.None);
        using var s = await PlcHarness.ConnectAsync(plc.EndpointUrl);

        Assert.DoesNotContain("InjectFault", await s.BrowseNamesAsync(NodeId.Parse("ns=2;s=LineA")));

        plc.Publish(123_000,
            [new AssetState("CNC-01", AssetStateKind.Blocked, 0, 0.75, 0.2, 1, 42, 3, 0.5), new AssetState("UNKNOWN", AssetStateKind.Idle, 0, 0, 0, 0, 0, 0, 0)],
            [new SensorValue("CNC-01.temp", 61.25), new SensorValue("SNK-01.good", 17)]);

        Assert.Equal(123_000L, (await s.ReadAsync("ns=2;s=LineA.SimTimeMs")).Value);
        Assert.Equal((int)AssetStateKind.Blocked, (await s.ReadAsync("ns=2;s=LineA.CNC-01.State")).Value);
        Assert.Equal(42d, (await s.ReadAsync("ns=2;s=LineA.CNC-01.Good")).Value);
        Assert.Equal(3d, (await s.ReadAsync("ns=2;s=LineA.CNC-01.Scrap")).Value);
        Assert.Equal(1d, (await s.ReadAsync("ns=2;s=LineA.CNC-01.Wip")).Value);
        Assert.Equal(0.75, (await s.ReadAsync("ns=2;s=LineA.CNC-01.Load")).Value);
        Assert.Equal(0.2, (await s.ReadAsync("ns=2;s=LineA.CNC-01.Wear")).Value);
        Assert.Equal(61.25, (await s.ReadAsync("ns=2;s=LineA.CNC-01.Temp")).Value);
        Assert.Equal(17d, (await s.ReadAsync("ns=2;s=LineA.SNK-01.Good")).Value);

        await s.CloseAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Restart_with_a_different_plant_rebuilds_the_address_space()
    {
        var plant = PlcHarness.SamplePlant();
        await using var plc = PlcHarness.Create(48405);
        await plc.StartAsync(plant, CancellationToken.None);
        Assert.Equal("LineA", plc.LineId);

        var other = plant with
        {
            Id = "line-b",
            Assets = plant.Assets.Where(a => a.Id is "SRC-01" or "CONV-01" or "SNK-01")
                .Select(a => a.Id == "CONV-01" ? a with { Downstream = ["SNK-01"] } : a).ToList(),
            Sensors = plant.Sensors.Where(x => x.AssetId is "CONV-01" or "SNK-01").ToList(),
            Bindings = null,
            Connections = null,
        };
        await plc.StartAsync(other, CancellationToken.None);
        Assert.Equal("LineB", plc.LineId);

        using var s = await PlcHarness.ConnectAsync(plc.EndpointUrl);
        Assert.Equal(["LineB"], await s.BrowseNamesAsync(NodeId.Parse("ns=2;s=TwinLabs")));
        Assert.IsType<double>((await s.ReadAsync("ns=2;s=LineB.CONV-01.Speed")).Value);
        var gone = await Assert.ThrowsAsync<ServiceResultException>(() => s.ReadAsync("ns=2;s=LineA.CNC-01.Temp"));
        Assert.Equal(StatusCodes.BadNodeIdUnknown, gone.StatusCode);
        await s.CloseAsync(CancellationToken.None);

        await plc.StopAsync();
        Assert.False(plc.IsListening);
        Assert.False(await PortOpenAsync(48405));
    }

    [Fact]
    public async Task Disabled_server_does_not_listen()
    {
        await using var plc = PlcHarness.Create(48406, enabled: false);
        Assert.False(plc.Enabled);
        await plc.StartAsync(PlcHarness.SamplePlant(), CancellationToken.None);
        plc.Publish(1, [], []);
        Assert.False(plc.IsListening);
        Assert.False(await PortOpenAsync(48406));
        await plc.StopAsync();
    }

    private static async Task<bool> PortOpenAsync(int port)
    {
        using var c = new TcpClient();
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            await c.ConnectAsync("localhost", port, cts.Token);
            return true;
        }
        catch (Exception) { return false; }
    }
}
