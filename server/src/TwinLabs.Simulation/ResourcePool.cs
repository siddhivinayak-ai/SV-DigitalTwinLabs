using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// v0.3 shared resource (docs/V0.3-PlantBuilder.md §2): <see cref="Count"/> identical units.
/// A machine requests one unit when a part arrives, holds it for the whole cycle (including fault,
/// maintenance and off-shift pauses) and releases it when the cycle ends.
/// </summary>
/// <remarks>
/// Units are granted once per tick, before any asset steps, so a released unit goes to the next waiter
/// at the start of the following tick. A machine that accepts a part in tick t starts its cycle in tick t+1
/// with or without a resource, so an uncontended pool adds no delay. Waiters are served FIFO by wait start,
/// ties broken by plant order. A waiter that is not operational (off, off-shift, maintenance, fault) keeps its
/// place but is skipped, and its time does not count as wait.
/// </remarks>
internal sealed class ResourcePool(ResourceDef def)
{
    private readonly List<Waiter> _queue = new(4);

    public ResourceDef Def { get; } = def;
    public string Id => Def.Id;
    public int Count => Def.Count;
    public int InUse { get; private set; }
    public int Waiting => _queue.Count;

    /// <summary>Sum over ticks of units held (unit-ticks).</summary>
    public long BusyUnitTicks { get; private set; }
    /// <summary>Sum over ticks of operational assets waiting for a unit (asset-ticks).</summary>
    public long WaitTicks { get; private set; }

    public void Request(MachineAsset a, long tick)
    {
        var w = new Waiter(tick, a.Index, a);
        int i = _queue.Count;
        while (i > 0 && Before(w, _queue[i - 1])) i--;
        _queue.Insert(i, w);
    }

    public void Release()
    {
        if (InUse <= 0) throw new InvalidOperationException($"Resource '{Id}' released more units than it granted.");
        InUse--;
    }

    /// <summary>Grant free units FIFO, then account this tick's busy and wait time.</summary>
    public void Allocate()
    {
        if (_queue.Count > 0)
        {
            int i = 0;
            while (i < _queue.Count && InUse < Count)
            {
                var a = _queue[i].Asset;
                if (a.Operational)
                {
                    _queue.RemoveAt(i);
                    InUse++;
                    a.Grant();
                }
                else i++;
            }
            for (int k = 0; k < _queue.Count; k++)
            {
                var a = _queue[k].Asset;
                if (!a.Operational) continue;
                a.MarkWaiting();
                WaitTicks++;
            }
        }
        BusyUnitTicks += InUse;
    }

    public void Reset()
    {
        _queue.Clear();
        InUse = 0;
        BusyUnitTicks = 0;
        WaitTicks = 0;
    }

    public ResourceStats ToStats() =>
        new(Id, Count, BusyUnitTicks * SimulationEngine.TickSeconds, WaitTicks * SimulationEngine.TickSeconds);

    private static bool Before(Waiter x, Waiter y) => x.Tick < y.Tick || (x.Tick == y.Tick && x.Index < y.Index);

    private readonly record struct Waiter(long Tick, int Index, MachineAsset Asset);
}
