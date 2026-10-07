using Microsoft.Extensions.Configuration;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt;

// STUB (v0.2 contracts): replaced by feature/mqtt-adapter. Config section: Twin:Mqtt (Broker:Enabled, Broker:Port, Publish:Enabled).
public sealed class MqttSimPublisher(IConfiguration config) : ITwinPublisher
{
    public string Name => "mqtt";
    public bool Enabled => false;
    public Task StartAsync(PlantModel plant, CancellationToken ct) => Task.CompletedTask;
    public void Publish(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors) { }
    public Task StopAsync() => Task.CompletedTask;
}
