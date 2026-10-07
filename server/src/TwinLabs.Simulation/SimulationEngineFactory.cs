using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>Builds fresh, empty engines from a plant model (used by the live host and what-if runs).</summary>
public sealed class SimulationEngineFactory : ISimulationEngineFactory
{
    public ISimulationEngine Create(PlantModel plant, int seed) => new SimulationEngine(plant, seed);
}
