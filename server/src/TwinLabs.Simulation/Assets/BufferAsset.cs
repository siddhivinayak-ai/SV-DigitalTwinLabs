using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>FIFO store with <c>capacity</c> slots and no processing time.</summary>
internal sealed class BufferAsset(AssetDef def, int index) : AssetRuntime(def, index)
{
    private readonly List<Part> _parts = new(16);
    private int _capacity;
    private bool _pushed;

    public int Capacity => _capacity;

    public override void LoadParams()
    {
        base.LoadParams();
        _capacity = (int)P(ParamKeys.Capacity, 10);
    }

    public override void Step(SimulationEngine e)
    {
        while (_parts.Count > 0)
        {
            var target = e.FindAcceptor(this);
            if (target is null) break;
            var p = _parts[0];
            _parts.RemoveAt(0);
            Good++;
            _pushed = true;
            target.Accept(p, e);
        }
    }

    // A shrunk capacity keeps the parts already inside; the buffer just stops accepting.
    public override bool CanAccept() => Operational && _parts.Count < _capacity;

    public override void Accept(Part part, SimulationEngine e)
    {
        _parts.Add(part);
        HasWork = true;
    }

    public override AssetStateKind ComputeActiveState()
    {
        if (_parts.Count == 0) return HasWork ? AssetStateKind.Starved : AssetStateKind.Idle;
        if (_parts.Count >= _capacity && !_pushed) return AssetStateKind.Blocked;
        return AssetStateKind.Running;
    }

    public override void ClearTickFlags() => _pushed = false;
    protected override void ClearParts() => _parts.Clear();
    public override int Wip => _parts.Count;
    public override long Total => Good;
    public override double Load => 0;

    public override void AppendParts(List<PartPosition> into)
    {
        // Progress = slot / capacity. The head (next out) has the highest progress.
        int n = _parts.Count;
        double cap = Math.Max(_capacity, n);
        for (int i = 0; i < n; i++)
            into.Add(new PartPosition(_parts[i].Id, Id, (n - i) / cap));
    }
}
