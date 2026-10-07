using System.Collections.Concurrent;
using System.Text;
using Microsoft.Extensions.Configuration;
using MQTTnet;
using MQTTnet.Server;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt.Tests;

internal static class TestSupport
{
    public static string RepoRoot
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts", "plant"))) dir = dir.Parent;
            return dir?.FullName ?? throw new DirectoryNotFoundException("contracts/plant not found above test output");
        }
    }

    public static string PlantPath(string file) => Path.Combine(RepoRoot, "contracts", "plant", file);

    public static PlantModel LoadPlant(string file) => TwinJson.LoadPlant(PlantPath(file));

    public static IConfiguration Config(params (string Key, string Value)[] values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value))).Build();

    public static async Task<bool> WaitUntil(Func<bool> cond, TimeSpan timeout)
    {
        var end = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < end)
        {
            if (cond()) return true;
            await Task.Delay(25);
        }
        return cond();
    }

    public static async Task<MqttServer> StartBroker(int port)
    {
        var sf = new MqttServerFactory();
        var server = sf.CreateMqttServer(sf.CreateServerOptionsBuilder().WithDefaultEndpoint().WithDefaultEndpointPort(port).Build());
        await server.StartAsync();
        return server;
    }

    public static async Task StopBroker(MqttServer server)
    {
        try { await server.StopAsync(); } finally { server.Dispose(); }
    }

    public static async Task<IMqttClient> Client(int port)
    {
        var c = new MqttClientFactory().CreateMqttClient();
        await c.ConnectAsync(new MqttClientOptionsBuilder().WithTcpServer("localhost", port).WithClientId("test-" + Guid.NewGuid().ToString("N")[..8]).Build());
        return c;
    }

    public static Task Send(IMqttClient c, string topic, string payload, bool retain = false) =>
        c.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(topic).WithPayload(Encoding.UTF8.GetBytes(payload)).WithRetainFlag(retain).Build());
}

/// <summary>Collects every update a source emits.</summary>
internal sealed class Collector
{
    public readonly ConcurrentQueue<TagUpdate> All = new();
    public readonly ConcurrentQueue<ConnectionStatus> Statuses = new();

    public Collector(ITagSource source)
    {
        source.Updates += list => { foreach (var u in list) All.Enqueue(u); };
        source.StatusChanged += s => Statuses.Enqueue(s);
    }

    public IReadOnlyList<TagUpdate> For(string address) => All.Where(u => u.Address == address).ToList();
}
