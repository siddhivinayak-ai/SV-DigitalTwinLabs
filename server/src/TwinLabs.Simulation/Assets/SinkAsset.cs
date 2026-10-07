using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>Consumes good parts and counts them. Running on ticks it receives a part, Starved otherwise.</summary>
internal sealed class SinkAsset(AssetDef def, int index) : AssetRuntime(def, index)
{
    private bool _received;

    public override void Step(SimulationEngine e) { }
    public override bool CanAccept() => Operational;

    public override void Accept(Part part, SimulationEngine e)
    {
        Good++;
        HasWork = true;
        _received = true;
        e.Consumed++;
    }

    public override AssetStateKind ComputeActiveState() =>
        _received ? AssetStateKind.Running : HasWork ? AssetStateKind.Starved : AssetStateKind.Idle;

    public override void ClearTickFlags() => _received = false;
    protected override void ClearParts() { }
    public override int Wip => 0;
    public override long Total => Good;
    public override double Load => 0;
    public override void AppendParts(List<PartPosition> into) { }
}
