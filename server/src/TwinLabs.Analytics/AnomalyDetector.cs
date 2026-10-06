using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Analytics;

// STUB (Phase 0): replaced by feature/analytics.
public sealed class AnomalyDetector(PlantModel plant) : IAnomalyDetector
{
    public PlantModel Plant { get; } = plant;
    public IReadOnlyList<Alarm> Observe(long simTimeMs, IReadOnlyList<SensorValue> sensors, IReadOnlyList<AssetState> assets) => [];
    public IReadOnlyList<Alarm> Active => [];
    public Alarm? Acknowledge(string alarmId) => null;
    public void Reset() { }
}
