using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// Machine / robot / inspection: one part at a time, cycle ~ Normal(cycleTimeS, cycleTimeStdS) clamped to
/// ≥ 0.2×mean, scrap at end of cycle with <c>scrapRate</c> (or <c>rejectRate</c>), wear-driven fault hazard.
/// v0.3: with a <see cref="Pool"/> the cycle starts only once a resource unit is granted (Starved while
/// waiting) and the unit is released when the cycle ends (good or scrap), before any downstream wait.
/// </summary>
internal sealed class MachineAsset(AssetDef def, int index) : AssetRuntime(def, index)
{
    private double _cycleMean, _cycleStd, _scrapRate;
    private Part? _current;
    private double _cycleTotal, _cycleRemaining;
    private bool _done;     // finished good part waiting for downstream
    private bool _ran;      // processed during this tick
    private bool _hasUnit;  // holds one unit of Pool for the current cycle
    private bool _waited;   // the pool had no unit for it this tick

    /// <summary>v0.3 shared resource needed per cycle, or null.</summary>
    public ResourcePool? Pool;

    /// <summary>Has a part but no resource unit yet.</summary>
    public bool WaitingForResource => Pool is not null && _current is not null && !_done && !_hasUnit;

    public override void LoadParams()
    {
        base.LoadParams();
        _cycleMean = P(ParamKeys.CycleTimeS, 10);
        _cycleStd = P(ParamKeys.CycleTimeStdS, 0);
        _scrapRate = Params.TryGetValue(ParamKeys.ScrapRate, out var s) ? s : P(RejectRateKey, 0);
    }

    /// <summary>Called by <see cref="ResourcePool.Allocate"/>.</summary>
    public void Grant()
    {
        _hasUnit = true;
        _waited = false;
    }

    /// <summary>Called by <see cref="ResourcePool.Allocate"/> when no unit was free this tick.</summary>
    public void MarkWaiting() => _waited = true;

    public override void Step(SimulationEngine e)
    {
        const double dt = SimulationEngine.TickSeconds;

        if (_current is not null && !_done && (Pool is null || _hasUnit))
        {
            _ran = true;
            _cycleRemaining -= dt;
            if (MtbfS > 0)
            {
                Wear += dt / MtbfS;
                double hazard = dt / MtbfS * (1 + 3 * Wear * Wear);
                if (e.Rng.NextDouble() < hazard)
                {
                    // The part (and any resource unit) stays inside; the cycle resumes after the repair.
                    e.StartFault(this, null, injected: false);
                    return;
                }
            }

            if (_cycleRemaining <= 1e-9)
            {
                _cycleRemaining = 0;
                if (_hasUnit)
                {
                    _hasUnit = false;
                    Pool!.Release();
                }
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
        Pool?.Request(this, e.Tick);
    }

    public override AssetStateKind ComputeActiveState()
    {
        if (_done) return AssetStateKind.Blocked;
        if (_ran) return AssetStateKind.Running;
        if (_waited && WaitingForResource) return AssetStateKind.Starved; // part loaded, no free resource unit
        if (_current is not null) return AssetStateKind.Running;
        return HasWork ? AssetStateKind.Starved : AssetStateKind.Idle;
    }

    public override void ClearTickFlags() => _ran = false;

    protected override void ClearParts()
    {
        _current = null;
        _done = false;
        _hasUnit = false;
        _waited = false;
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
