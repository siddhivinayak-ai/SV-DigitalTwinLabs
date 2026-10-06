using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// Accumulating FIFO conveyor. Parts travel at <c>speedMps</c> over <c>lengthM</c> (transit = length/speed),
/// keep a minimum spacing of length/capacity, and leave only once at the end and downstream accepts.
/// </summary>
internal sealed class ConveyorAsset(AssetDef def, int index) : AssetRuntime(def, index)
{
    private const double Eps = 1e-9;
    private readonly List<Part> _parts = new(8); // [0] = front (closest to the exit)
    private double _length, _speed;
    private int _capacity;
    private bool _moved, _accepted;

    public int Capacity => _capacity;
    private double Spacing => _length / _capacity;

    public override void LoadParams()
    {
        base.LoadParams();
        _length = P(ParamKeys.LengthM, 5);
        _speed = P(ParamKeys.SpeedMps, 0.5);
        _capacity = (int)P(ParamKeys.Capacity, 5);
    }

    public override void Step(SimulationEngine e)
    {
        if (_parts.Count == 0) return;

        var front = _parts[0];
        if (front.PosM >= _length - Eps)
        {
            var target = e.FindAcceptor(this);
            if (target is not null)
            {
                _parts.RemoveAt(0);
                Good++;
                _moved = true;
                target.Accept(front, e);
            }
        }

        double step = _speed * SimulationEngine.TickSeconds;
        double spacing = Spacing;
        double limit = _length;
        for (int i = 0; i < _parts.Count; i++)
        {
            var p = _parts[i];
            if (i > 0) limit = _parts[i - 1].PosM - spacing;
            double next = Math.Min(p.PosM + step, limit);
            if (next > p.PosM + Eps)
            {
                p.PosM = next;
                _moved = true;
            }
        }
    }

    public override bool CanAccept() =>
        Operational && _parts.Count < _capacity &&
        (_parts.Count == 0 || _parts[^1].PosM >= Spacing - Eps);

    public override void Accept(Part part, SimulationEngine e)
    {
        part.PosM = 0;
        _parts.Add(part);
        HasWork = true;
        _accepted = true;
    }

    public override AssetStateKind ComputeActiveState()
    {
        if (_parts.Count == 0) return HasWork ? AssetStateKind.Starved : AssetStateKind.Idle;
        // A part placed this tick has not moved yet, but the belt is carrying it.
        if (_moved || _accepted) return AssetStateKind.Running;
        return AssetStateKind.Blocked;
    }

    public override void ClearTickFlags() => _moved = _accepted = false;
    protected override void ClearParts() => _parts.Clear();
    public override int Wip => _parts.Count;
    public override long Total => Good;
    public override double Load =>
        State == AssetStateKind.Running ? 0.4 + 0.6 * Math.Min(1.0, (double)_parts.Count / _capacity) : 0;
    public override double BeltSpeedMps => State == AssetStateKind.Running ? _speed : 0;

    public override void AppendParts(List<PartPosition> into)
    {
        for (int i = 0; i < _parts.Count; i++)
            into.Add(new PartPosition(_parts[i].Id, Id, Math.Clamp(_parts[i].PosM / _length, 0, 1)));
    }
}
