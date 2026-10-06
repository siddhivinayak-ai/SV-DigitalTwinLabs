using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

// STUB (Phase 0): replaced by feature/sim-engine.
public sealed class SimulationEngineFactory : ISimulationEngineFactory
{
    public ISimulationEngine Create(PlantModel plant, int seed) =>
        throw new NotImplementedException("SimulationEngine lands on feature/sim-engine");
}
