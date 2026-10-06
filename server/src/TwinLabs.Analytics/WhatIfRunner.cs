using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Analytics;

// STUB (Phase 0): replaced by feature/analytics.
public sealed class WhatIfRunner(ISimulationEngineFactory factory) : IWhatIfRunner
{
    private readonly ISimulationEngineFactory _factory = factory;
    public WhatIfResult Run(WhatIfRequest request, PlantModel basePlant) => throw new NotImplementedException();
}
