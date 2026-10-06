using System.Globalization;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// Deterministic fixed-step discrete simulation of a production line (docs/V1-Spec.md §2).
/// Single-threaded; callers serialise access.
/// </summary>
/// <remarks>
/// Each tick processes assets from sink to source (reverse topological order). An asset pushes its
/// finished part into a downstream asset that has already been processed this tick, so a part moves
/// at most one hop per tick and is never processed twice in the same tick.
/// All stochastic draws for the process come from one seeded <see cref="Random"/>. Sensor noise is a pure
/// hash of (seed, sensor, tick) so reading sensors never perturbs the simulation.
/// </remarks>
public sealed class SimulationEngine : ISimulationEngine
{
    public const double TickSeconds = 0.1;
    private const long TickMs = 100;
    private const long TimeSpanTicksPerTick = TimeSpan.TicksPerMillisecond * TickMs;

    private readonly PlantModel _original;
    private readonly AssetRuntime[] _assets;        // plant order
    private readonly AssetRuntime[] _processOrder;  // sink → source
    private readonly Dictionary<string, AssetRuntime> _byId;
    private readonly SensorModel[] _sensors;
    private readonly List<EventRecord> _events = new();
    private readonly double _tempAlpha = 1 - Math.Exp(-TickSeconds / 120.0);

    private long _nextEventId = 1;
    private long _nextPartId = 1;
    private long _pendingTimeSpanTicks;
    private PlantModel? _plantCache;

    internal Random Rng { get; private set; }
    internal long Released;
    internal long Consumed;
    internal long Scrapped;

    public SimulationEngine(PlantModel plant, int seed)
    {
        ArgumentNullException.ThrowIfNull(plant);
        _original = plant;

        _assets = new AssetRuntime[plant.Assets.Count];
        _byId = new Dictionary<string, AssetRuntime>(StringComparer.Ordinal);
        for (int i = 0; i < plant.Assets.Count; i++)
        {
            var def = plant.Assets[i];
            AssetRuntime a = def.Kind switch
            {
                AssetKind.Source => new SourceAsset(def, i),
                AssetKind.Conveyor => new ConveyorAsset(def, i),
                AssetKind.Buffer => new BufferAsset(def, i),
                AssetKind.Sink => new SinkAsset(def, i),
                AssetKind.Machine or AssetKind.Robot or AssetKind.Inspection => new MachineAsset(def, i),
                _ => throw new ArgumentException($"Unsupported asset kind {def.Kind} for {def.Id}."),
            };
            ParamValidator.Validate(def.Id, def.Params);
            a.LoadParams();
            if (!_byId.TryAdd(def.Id, a))
                throw new ArgumentException($"Duplicate asset id '{def.Id}'.");
            _assets[i] = a;
        }

        foreach (var a in _assets)
        {
            var ds = a.Def.Downstream;
            a.Downstream = new AssetRuntime[ds.Count];
            for (int k = 0; k < ds.Count; k++)
                a.Downstream[k] = _byId.TryGetValue(ds[k], out var d)
                    ? d
                    : throw new ArgumentException($"{a.Id}: unknown downstream '{ds[k]}'.");
        }

        _processOrder = BuildProcessOrder(_assets);

        _sensors = new SensorModel[plant.Sensors.Count];
        for (int i = 0; i < plant.Sensors.Count; i++)
        {
            var s = plant.Sensors[i];
            if (!_byId.TryGetValue(s.AssetId, out var a))
                throw new ArgumentException($"Sensor {s.Id}: unknown asset '{s.AssetId}'.");
            _sensors[i] = new SensorModel(s, a, i);
        }

        Rng = new Random(seed);
        ResetCore(seed);
    }

    // ---------------------------------------------------------------- properties

    public PlantModel Plant => _plantCache ??= BuildPlant();
    public int Seed { get; private set; }
    public long Tick { get; private set; }
    public long SimTimeMs => Tick * TickMs;
    public double Dt => TickSeconds;
    public int Wip => (int)(Released - Consumed - Scrapped);

    // ---------------------------------------------------------------- stepping

    public void Step()
    {
        long tickStartMs = SimTimeMs;

        var order = _processOrder;
        for (int i = 0; i < order.Length; i++)
        {
            var a = order[i];
            if (a.Faulted)
            {
                if (a.FaultTicksRemaining <= 0) Repair(a);
                else
                {
                    a.FaultTicksRemaining--;
                    continue;
                }
            }
            if (a.Enabled && !a.Maintenance) a.Step(this);
        }

        Tick++;

        var assets = _assets;
        for (int i = 0; i < assets.Length; i++)
        {
            var a = assets[i];
            a.ActiveState = a.ComputeActiveState();
            var st = Override(a) ?? a.ActiveState;
            var from = a.State;
            if (st != from)
            {
                a.State = st;
                a.StateSinceMs = tickStartMs;
            }
            if (a.PendingRepairEvent)
            {
                a.PendingRepairEvent = false;
                long dur = (tickStartMs - a.FaultStartMs) / 1000;
                Emit(EventKind.State, Severity.Info, $"{a.Id} repaired, back in service after {dur} s",
                     a.Id, AssetStateKind.Fault, st);
            }
            a.StateTicks[(int)st]++;

            double target = a.AmbientC + a.Load * a.TempRiseC;
            a.TempC += (target - a.TempC) * _tempAlpha;
            a.ClearTickFlags();
        }
    }

    public void Advance(TimeSpan simTime)
    {
        if (simTime < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(simTime), "Must be non-negative.");
        // Carry the sub-tick remainder so many small advances (e.g. 25 ms at 0.25x) still add up.
        _pendingTimeSpanTicks += simTime.Ticks;
        long n = _pendingTimeSpanTicks / TimeSpanTicksPerTick;
        _pendingTimeSpanTicks -= n * TimeSpanTicksPerTick;
        for (long i = 0; i < n; i++) Step();
    }

    // ---------------------------------------------------------------- queries

    public IReadOnlyList<AssetState> GetAssetStates()
    {
        var list = new AssetState[_assets.Length];
        for (int i = 0; i < _assets.Length; i++) list[i] = ToState(_assets[i]);
        return list;
    }

    public IReadOnlyList<SensorValue> GetSensorValues()
    {
        var list = new SensorValue[_sensors.Length];
        for (int i = 0; i < _sensors.Length; i++)
            list[i] = new SensorValue(_sensors[i].Id, _sensors[i].Read(Seed, Tick));
        return list;
    }

    public IReadOnlyList<PartPosition> GetParts()
    {
        var list = new List<PartPosition>(Math.Max(Wip, 4));
        foreach (var a in _assets) a.AppendParts(list);
        return list;
    }

    public IReadOnlyList<AssetStats> GetAssetStats()
    {
        var list = new AssetStats[_assets.Length];
        for (int i = 0; i < _assets.Length; i++)
        {
            var a = _assets[i];
            var t = a.StateTicks;
            var sb = new StateBreakdown(
                t[(int)AssetStateKind.Off] * TickSeconds,
                t[(int)AssetStateKind.Idle] * TickSeconds,
                t[(int)AssetStateKind.Running] * TickSeconds,
                t[(int)AssetStateKind.Starved] * TickSeconds,
                t[(int)AssetStateKind.Blocked] * TickSeconds,
                t[(int)AssetStateKind.Fault] * TickSeconds,
                t[(int)AssetStateKind.Maintenance] * TickSeconds);
            list[i] = new AssetStats(a.Id, sb, a.Total, a.Good, a.Scrap, a.IdealCycleTimeS);
        }
        return list;
    }

    public IReadOnlyList<EventRecord> DrainEvents()
    {
        if (_events.Count == 0) return Array.Empty<EventRecord>();
        var copy = _events.ToArray();
        _events.Clear();
        return copy;
    }

    // ---------------------------------------------------------------- commands

    public AssetDef UpdateParams(string assetId, IReadOnlyDictionary<string, double> changes)
    {
        var a = Get(assetId);
        ArgumentNullException.ThrowIfNull(changes);
        if (changes.Count == 0) return a.Def;
        ParamValidator.Validate(assetId, changes);

        var parts = new List<string>(changes.Count);
        foreach (var (k, v) in changes)
        {
            string old = a.Params.TryGetValue(k, out var o) ? Fmt(o) : "-";
            parts.Add($"{k} {old} → {Fmt(v)}");
        }
        a.MergeParams(changes);
        _plantCache = null;
        Emit(EventKind.Command, Severity.Info, $"{a.Id} params: {string.Join(", ", parts)}", a.Id);
        return a.Def;
    }

    public void InjectFault(string assetId, double? durationS = null)
    {
        var a = Get(assetId);
        if (durationS is { } d && (!double.IsFinite(d) || d <= 0))
            throw new ArgumentException($"{assetId}: fault duration must be > 0 s (got {d}).", nameof(durationS));
        StartFault(a, durationS, injected: true);
    }

    public void ClearFault(string assetId)
    {
        var a = Get(assetId);
        if (!a.Faulted) return;
        Repair(a);
        a.PendingRepairEvent = false;
        long dur = (SimTimeMs - a.FaultStartMs) / 1000;
        var (from, to) = Refresh(a);
        Emit(EventKind.Command, Severity.Info, $"{a.Id} fault cleared by operator after {dur} s", a.Id, from, to);
    }

    public void SetMaintenance(string assetId, bool on)
    {
        var a = Get(assetId);
        if (a.Maintenance == on) return;
        a.Maintenance = on;
        if (!on) a.Wear = 0; // leaving maintenance = serviced
        var (from, to) = Refresh(a);
        Emit(EventKind.Command, Severity.Info,
             on ? $"{a.Id} maintenance ON" : $"{a.Id} maintenance OFF (wear reset)", a.Id, from, to);
    }

    public void SetEnabled(string assetId, bool enabled)
    {
        var a = Get(assetId);
        if (a.Enabled == enabled) return;
        a.Enabled = enabled;
        var (from, to) = Refresh(a);
        Emit(EventKind.Command, enabled ? Severity.Info : Severity.Warning,
             enabled ? $"{a.Id} enabled" : $"{a.Id} switched OFF", a.Id, from, to);
    }

    public void Reset(int? seed = null)
    {
        ResetCore(seed ?? Seed);
        Emit(EventKind.Info, Severity.Info, $"Simulation reset (seed {Seed})");
    }

    // ---------------------------------------------------------------- internals used by assets

    /// <summary>First downstream (round-robin from the last choice) that accepts a part, or null.</summary>
    internal AssetRuntime? FindAcceptor(AssetRuntime from)
    {
        var ds = from.Downstream;
        int n = ds.Length;
        for (int k = 0; k < n; k++)
        {
            int i = (from.RrIndex + k) % n;
            if (ds[i].CanAccept())
            {
                from.RrIndex = (i + 1) % n;
                return ds[i];
            }
        }
        return null;
    }

    internal Part ReleasePart()
    {
        Released++;
        return new Part(_nextPartId++);
    }

    internal void StartFault(AssetRuntime a, double? durationS, bool injected)
    {
        double d = durationS ?? SimRandom.Exponential(Rng, a.MttrS > 0 ? a.MttrS : 300);
        long ticks = Math.Max(1, (long)Math.Round(d / TickSeconds));
        var from = a.State;
        a.Faulted = true;
        a.PendingRepairEvent = false;
        if (injected)
        {
            // Applied between ticks: the next `ticks` ticks are spent in Fault.
            a.FaultTicksRemaining = ticks;
            a.FaultStartMs = SimTimeMs;
            Refresh(a);
        }
        else
        {
            // Raised during the current tick, which already counts as Fault.
            a.FaultTicksRemaining = ticks - 1;
            a.FaultStartMs = SimTimeMs;
        }
        long est = (long)Math.Round(ticks * TickSeconds);
        Emit(EventKind.State, injected ? Severity.Warning : Severity.Critical,
             injected ? $"{a.Id} FAULT injected (repair est. {est} s)" : $"{a.Id} FAULT (repair est. {est} s)",
             a.Id, from, AssetStateKind.Fault);
    }

    // ---------------------------------------------------------------- helpers

    private void Repair(AssetRuntime a)
    {
        a.Faulted = false;
        a.FaultTicksRemaining = 0;
        a.Wear *= 0.2;
        a.PendingRepairEvent = true;
    }

    private static AssetStateKind? Override(AssetRuntime a) =>
        !a.Enabled ? AssetStateKind.Off
        : a.Maintenance ? AssetStateKind.Maintenance
        : a.Faulted ? AssetStateKind.Fault
        : null;

    /// <summary>Re-evaluate the state after a command (between ticks).</summary>
    private (AssetStateKind From, AssetStateKind To) Refresh(AssetRuntime a)
    {
        var from = a.State;
        var to = Override(a) ?? a.ActiveState;
        if (to != from)
        {
            a.State = to;
            a.StateSinceMs = SimTimeMs;
        }
        return (from, to);
    }

    private void ResetCore(int seed)
    {
        Seed = seed;
        Rng = new Random(seed);
        Tick = 0;
        _pendingTimeSpanTicks = 0;
        _nextPartId = 1;
        Released = Consumed = Scrapped = 0;
        foreach (var a in _assets) a.ResetRuntime();
    }

    private AssetRuntime Get(string assetId)
    {
        ArgumentNullException.ThrowIfNull(assetId);
        return _byId.TryGetValue(assetId, out var a)
            ? a
            : throw new KeyNotFoundException($"Unknown asset '{assetId}'.");
    }

    private void Emit(EventKind kind, Severity sev, string message, string? assetId = null,
                      AssetStateKind? from = null, AssetStateKind? to = null) =>
        _events.Add(new EventRecord(_nextEventId++, SimTimeMs, kind, sev, message, assetId, from, to));

    private static AssetState ToState(AssetRuntime a) =>
        new(a.Id, a.State, a.StateSinceMs, a.Load, a.Wear, a.Wip, a.Good, a.Scrap, a.CycleProgress);

    private PlantModel BuildPlant()
    {
        var defs = new AssetDef[_assets.Length];
        for (int i = 0; i < _assets.Length; i++) defs[i] = _assets[i].Def;
        return _original with { Assets = defs };
    }

    private static string Fmt(double v) => v.ToString("0.###", CultureInfo.InvariantCulture);

    /// <summary>Reverse topological order (sinks first). Ties keep plant order; cycles fall back to plant order.</summary>
    private static AssetRuntime[] BuildProcessOrder(AssetRuntime[] assets)
    {
        int n = assets.Length;
        var remainingOut = new int[n];
        var upstream = new List<int>[n];
        for (int i = 0; i < n; i++) upstream[i] = new List<int>();
        for (int i = 0; i < n; i++)
        {
            remainingOut[i] = assets[i].Downstream.Length;
            foreach (var d in assets[i].Downstream) upstream[d.Index].Add(i);
        }

        var order = new List<AssetRuntime>(n);
        var done = new bool[n];
        var ready = new SortedSet<int>();
        for (int i = 0; i < n; i++) if (remainingOut[i] == 0) ready.Add(i);
        while (order.Count < n)
        {
            if (ready.Count == 0)
            {
                // Cycle: take the last unprocessed asset in plant order to break it.
                for (int i = n - 1; i >= 0; i--) if (!done[i]) { ready.Add(i); break; }
            }
            int next = ready.Min;
            ready.Remove(next);
            if (done[next]) continue;
            done[next] = true;
            order.Add(assets[next]);
            foreach (var u in upstream[next])
                if (!done[u] && --remainingOut[u] <= 0) ready.Add(u);
        }
        return order.ToArray();
    }
}
