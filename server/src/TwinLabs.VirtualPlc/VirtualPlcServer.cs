using Microsoft.Extensions.Configuration;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.VirtualPlc;

// STUB (v0.2 contracts): replaced by feature/virtual-plc. Config section: Twin:VirtualPlc (Enabled, Port).
public sealed class VirtualPlcServer(IConfiguration config) : ITwinPublisher
{
    public string Name => "virtual-plc";
    public bool Enabled => false;
    public Task StartAsync(PlantModel plant, CancellationToken ct) => Task.CompletedTask;
    public void Publish(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors) { }
    public Task StopAsync() => Task.CompletedTask;
}
