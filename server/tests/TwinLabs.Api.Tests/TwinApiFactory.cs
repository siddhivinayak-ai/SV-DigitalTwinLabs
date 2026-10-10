using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using TwinLabs.Api.Hosting;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

/// <summary>
/// Real host pipeline with fake engine + analytics. <see cref="ManualLoop"/> (default) removes the background
/// loop so tests drive time deterministically through <see cref="SimulationHost.Advance"/>.
/// </summary>
public sealed class TwinApiFactory : WebApplicationFactory<Program>
{
    public bool ManualLoop { get; init; } = true;
    public double TickHz { get; init; } = 5;

    public FakeEngineFactory Engines { get; } = new();
    public FakeKpiCalculator Kpi { get; } = new();
    public FakeAnomalyDetector Detector { get; } = new();
    public FakeWhatIfRunner WhatIf { get; } = new();

    // v0.2 connectivity fakes (the real factories/publishers are always replaced).
    /// <summary>Plant file; null = the default sample line. See <see cref="ConnectedPlant"/>.</summary>
    public string? PlantPath { get; init; }
    public string? Mode { get; init; }
    public FakeTagSourceFactory OpcUa { get; } = new(ConnectionKind.Opcua);
    public FakeTagSourceFactory Mqtt { get; } = new(ConnectionKind.Mqtt);
    public List<FakePublisher> Publishers { get; init; } = [];
    public List<IHostEventSink> Sinks { get; init; } = [];

    public static string ConnectedPlant => Path.Combine(ContractShape.ContractsDir, "plant", "sample_line.connected.json");

    public ConnectionManager Connections => Services.GetRequiredService<ConnectionManager>();

    public SimulationHost Host => Services.GetRequiredService<SimulationHost>();
    public FakeEngine Engine => Engines.Last;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.UseSetting("Twin:AutoStart", "false");
        builder.UseSetting("Twin:TickHz", TickHz.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (PlantPath is not null) builder.UseSetting("Twin:PlantPath", PlantPath);
        if (Mode is not null) builder.UseSetting("Twin:Mode", Mode);
        builder.ConfigureServices(s =>
        {
            s.RemoveAll<ISimulationEngineFactory>();
            s.RemoveAll<IKpiCalculator>();
            s.RemoveAll<IAnomalyDetector>();
            s.RemoveAll<IWhatIfRunner>();
            s.AddSingleton<ISimulationEngineFactory>(Engines);
            s.AddSingleton<IKpiCalculator>(Kpi);
            s.AddSingleton<IAnomalyDetector>(Detector);
            s.AddSingleton<IWhatIfRunner>(WhatIf);

            s.RemoveAll<ITagSourceFactory>();
            s.RemoveAll<ITwinPublisher>();
            s.RemoveAll<IHostEventSink>();
            s.AddSingleton<ITagSourceFactory>(OpcUa);
            s.AddSingleton<ITagSourceFactory>(Mqtt);
            foreach (var p in Publishers) s.AddSingleton<ITwinPublisher>(p);
            foreach (var k in Sinks) s.AddSingleton<IHostEventSink>(k);

            if (ManualLoop)
            {
                var loop = s.Where(d => d.ServiceType == typeof(IHostedService) && d.ImplementationType == typeof(SimulationLoop)).ToList();
                foreach (var d in loop) s.Remove(d);
            }
        });
    }

    /// <summary>Run the host for <paramref name="simSeconds"/> at speed 1 (1 s wall per call = 10 ticks).</summary>
    public void RunSimSeconds(int simSeconds)
    {
        for (var i = 0; i < simSeconds; i++) Host.Advance(TimeSpan.FromSeconds(1));
    }

    public async Task<WebSocket> ConnectAsync()
    {
        var client = Server.CreateWebSocketClient();
        return await client.ConnectAsync(new Uri(Server.BaseAddress, "ws"), CancellationToken.None);
    }
}

public static class Ws
{
    public static async Task<JsonObject> ReceiveAsync(WebSocket ws, int timeoutMs = 5000)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        var buffer = new byte[64 * 1024];
        using var ms = new MemoryStream();
        WebSocketReceiveResult r;
        do
        {
            r = await ws.ReceiveAsync(buffer, cts.Token);
            if (r.MessageType == WebSocketMessageType.Close) throw new InvalidOperationException("socket closed");
            ms.Write(buffer, 0, r.Count);
        } while (!r.EndOfMessage);
        return JsonNode.Parse(ms.ToArray())!.AsObject();
    }

    /// <summary>Receive until a frame of <paramref name="type"/> arrives; returns it plus everything received.</summary>
    public static async Task<(JsonObject Frame, List<JsonObject> All)> ReceiveUntilAsync(WebSocket ws, string type, int maxFrames = 200)
    {
        var all = new List<JsonObject>();
        for (var i = 0; i < maxFrames; i++)
        {
            var f = await ReceiveAsync(ws);
            all.Add(f);
            if ((string?)f["type"] == type) return (f, all);
        }
        throw new InvalidOperationException($"no '{type}' frame within {maxFrames} frames");
    }

    public static Task SendTextAsync(WebSocket ws, string text) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    public static async Task CloseAsync(WebSocket ws)
    {
        using var cts = new CancellationTokenSource(3000);
        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", cts.Token); } catch { /* best effort */ }
    }
}
