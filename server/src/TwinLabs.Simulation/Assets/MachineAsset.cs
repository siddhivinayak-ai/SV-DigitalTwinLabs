using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// Machine / robot / inspection: one part at a time, cycle ~ Normal(cycleTimeS, cycleTimeStdS) clamped to
/// ≥ 0.2×mean, scrap at end of cycle with <c>scrapRate</c> (or <c>rejectRate</c>), wear-driven fault hazard.
/// </summary>
internal sealed class MachineAsset(AssetDef def, int index) : AssetRuntime(def, index)
{
    private double _cycleMean, _cycleStd, _scrapRate;
    private Part? _current;
    private double _cycleTotal, _cycleRemaining;
    private bool _done;     // finished good part waiting for downstream
    private bool _ran;      // processed during this tick

    public override void LoadParams()
    {
        base.LoadParams();
        _cycleMean = P(ParamKeys.CycleTimeS, 10);
        _cycleStd = P(ParamKeys.CycleTimeStdS, 0);
        _scrapRate = Params.TryGetValue(ParamKeys.ScrapRate, out var s) ? s : P(RejectRateKey, 0);
    }

    public override void Step(SimulationEngine e)
    {
        const double dt = SimulationEngine.TickSeconds;

        if (_current is not null && !_done)
        {
            _ran = true;
            _cycleRemaining -= dt;
            if (MtbfS > 0)
            {
                Wear += dt / MtbfS;
                double hazard = dt / MtbfS * (1 + 3 * Wear * Wear);
                if (e.Rng.NextDouble() < hazard)
                {
                    // The part stays inside; the cycle resumes after the repair.
                    e.StartFault(this, null, injected: false);
                    return;
                }
            }

            if (_cycleRemaining <= 1e-9)
            {
                _cycleRemaining = 0;
                if (_scrapRate > 0 && e.Rng.NextDouble() < _scrapRate)
                {
                    Scrap++;
                    e.Scrapped++;
                    _current = null;
                }
                else
                {
                    Good++;
                    _done = true;
                }
            }
        }

        if (_done)
        {
            var target = e.FindAcceptor(this);
            if (target is not null)
            {
                var p = _current!;
                _current = null;
                _done = false;
                target.Accept(p, e);
            }
        }
    }

    public override bool CanAccept() => Operational && _current is null;

    public override void Accept(Part part, SimulationEngine e)
    {
        _current = part;
        _done = false;
        _cycleTotal = SimRandom.ClampedNormal(e.Rng, _cycleMean, _cycleStd);
        _cycleRemaining = _cycleTotal;
        HasWork = true;
    }

    public override AssetStateKind ComputeActiveState()
    {
        if (_done) return AssetStateKind.Blocked;
        if (_ran || _current is not null) return AssetStateKind.Running;
        return HasWork ? AssetStateKind.Starved : AssetStateKind.Idle;
    }

    public override void ClearTickFlags() => _ran = false;

    protected override void ClearParts()
    {
        _current = null;
        _done = false;
        _cycleTotal = _cycleRemaining = 0;
    }

    public override int Wip => _current is null ? 0 : 1;
    public override double IdealCycleTimeS => _cycleMean;

    public override double CycleProgress =>
        _current is null ? 0 : _done || _cycleTotal <= 0 ? 1 : Math.Clamp(1 - _cycleRemaining / _cycleTotal, 0, 1);

    public override void AppendParts(List<PartPosition> into)
    {
        if (_current is not null) into.Add(new PartPosition(_current.Id, Id, CycleProgress));
    }
}
