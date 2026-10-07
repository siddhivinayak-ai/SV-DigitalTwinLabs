using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

// Cross-feature hooks (frozen with the v0.2/v0.3 contracts). Do not rename.
public sealed partial class SimulationHost
{
    /// <summary>
    /// Raised after the live plant was replaced (PUT /api/plant, layouts): the engine, KPI calculator, anomaly detector
    /// and history are already rebuilt for the new plant. Raised OUTSIDE the host lock. The connection manager
    /// (feature/shadow-mode) listens to restart tag sources; feature/plant-api raises it.
    /// </summary>
    public event Action<PlantModel>? PlantChanged;

    internal void RaisePlantChanged(PlantModel plant) => PlantChanged?.Invoke(plant);
}
