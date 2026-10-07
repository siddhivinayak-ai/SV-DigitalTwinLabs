using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>Releases raw parts every ~Normal(arrivalIntervalS, arrivalStdS) s. Blocked while downstream refuses.</summary>
internal sealed class SourceAsset(AssetDef def, int index) : AssetRuntime(def, index)
{
    private double _interval, _std;
    private double _timer;  // seconds until the next part is ready
    private bool _holding;  // a part is ready but downstream has not taken it yet

    public override void LoadParams()
    {
        base.LoadParams();
        _interval = P(ParamKeys.ArrivalIntervalS, 10);
        _std = P(ParamKeys.ArrivalStdS, 0);
    }

    public override void ResetRuntime()
    {
        base.ResetRuntime();
        _timer = 0; // the first part is released on the first tick
        _holding = false;
        HasWork = true;
    }

    public override void Step(SimulationEngine e)
    {
        if (!_holding)
        {
            _timer -= SimulationEngine.TickSeconds;
            if (_timer <= 1e-9) _holding = true;
        }
        if (!_holding) return;

        var target = e.FindAcceptor(this);
        if (target is null) return;

        var part = e.ReleasePart();
        Good++;
        _holding = false;
        _timer = SimRandom.ClampedNormal(e.Rng, _interval, _std);
        target.Accept(part, e);
    }

    public override bool CanAccept() => false;
    public override void Accept(Part part, SimulationEngine e) =>
        throw new InvalidOperationException($"{Id}: a source cannot accept parts.");

    public override AssetStateKind ComputeActiveState() => _holding ? AssetStateKind.Blocked : AssetStateKind.Running;
    protected override void ClearParts() { }
    public override int Wip => 0;
    public override long Total => Good;
    public override double Load => 0;
    public override void AppendParts(List<PartPosition> into) { }
}
