using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// Mutable run-time state of one asset. Subclasses implement the kind-specific behaviour
/// (spec §2). The engine owns ordering, the RNG, events and the state bookkeeping.
/// </summary>
internal abstract class AssetRuntime
{
    public const string RejectRateKey = "rejectRate";
    public const int StateCount = 7; // AssetStateKind.Off .. Maintenance

    protected AssetRuntime(AssetDef def, int index)
    {
        Def = def;
        Index = index;
        Params = new Dictionary<string, double>(def.Params, StringComparer.Ordinal);
    }

    public AssetDef Def { get; private set; }
    public string Id => Def.Id;
    public AssetKind Kind => Def.Kind;
    public int Index { get; }
    public Dictionary<string, double> Params { get; }

    public AssetRuntime[] Downstream = [];
    public int RrIndex;

    // ---- operator / failure flags ----
    public bool Enabled = true;
    public bool Maintenance;
    public bool Faulted;
    /// <summary>v0.3: false while the asset's shift window is closed (state Off, nothing moves).</summary>
    public bool OnShift = true;
    public long FaultTicksRemaining;
    public long FaultStartMs;
    public bool PendingRepairEvent;

    // ---- state bookkeeping ----
    public AssetStateKind State = AssetStateKind.Idle;
    /// <summary>State implied by activity alone (ignores the Off/Maintenance/Fault overrides).</summary>
    public AssetStateKind ActiveState = AssetStateKind.Idle;
    public long StateSinceMs;
    public readonly long[] StateTicks = new long[StateCount];

    // ---- counters / physics ----
    public long Good;
    public long Scrap;
    /// <summary>True once the asset has had any work since reset (distinguishes Idle from Starved).</summary>
    public bool HasWork;
    public double Wear;
    public double TempC;

    // ---- cached params (refreshed by LoadParams) ----
    public double MtbfS, MttrS, RatedKw, IdleKw, AmbientC, TempRiseC, VibBaselineMms;

    public bool Operational => Enabled && OnShift && !Maintenance && !Faulted;

    public double P(string key, double fallback) => Params.TryGetValue(key, out var v) ? v : fallback;

    /// <summary>Refresh cached fields from <see cref="Params"/>. Called at init and after every param change.</summary>
    public virtual void LoadParams()
    {
        MtbfS = P(ParamKeys.MtbfS, 0);
        MttrS = P(ParamKeys.MttrS, 300);
        RatedKw = P(ParamKeys.RatedKw, 0);
        IdleKw = P(ParamKeys.IdleKw, 0);
        AmbientC = P(ParamKeys.AmbientC, 24);
        TempRiseC = P(ParamKeys.TempRiseC, 0);
        VibBaselineMms = P(ParamKeys.VibBaselineMms, 0);
    }

    public void MergeParams(IReadOnlyDictionary<string, double> changes)
    {
        foreach (var (k, v) in changes) Params[k] = v;
        Def = Def with { Params = new Dictionary<string, double>(Params, StringComparer.Ordinal) };
        LoadParams();
    }

    /// <summary>Clear all run-time state back to t=0. Params are kept.</summary>
    public virtual void ResetRuntime()
    {
        RrIndex = 0;
        Enabled = true;
        Maintenance = false;
        Faulted = false;
        FaultTicksRemaining = 0;
        FaultStartMs = 0;
        PendingRepairEvent = false;
        OnShift = true;
        State = AssetStateKind.Idle;
        ActiveState = AssetStateKind.Idle;
        StateSinceMs = 0;
        Array.Clear(StateTicks);
        Good = 0;
        Scrap = 0;
        HasWork = false;
        Wear = 0;
        TempC = AmbientC;
        ClearParts();
        ClearTickFlags();
    }

    // ---- behaviour ----

    /// <summary>Advance this asset by one tick. Only called when the asset is operational.</summary>
    public abstract void Step(SimulationEngine e);
    public abstract bool CanAccept();
    public abstract void Accept(Part part, SimulationEngine e);
    /// <summary>Activity state at the end of the tick (Running / Starved / Blocked / Idle).</summary>
    public abstract AssetStateKind ComputeActiveState();
    public virtual void ClearTickFlags() { }
    protected abstract void ClearParts();

    /// <summary>Parts currently inside.</summary>
    public abstract int Wip { get; }
    /// <summary>Parts finished by (or passed through) this asset.</summary>
    public virtual long Total => Good + Scrap;
    public virtual double CycleProgress => 0;
    public virtual double IdealCycleTimeS => 0;
    /// <summary>0..1 utilisation right now; drives power and temperature.</summary>
    public virtual double Load => State == AssetStateKind.Running ? 1 : 0;
    /// <summary>Current belt speed (conveyors only).</summary>
    public virtual double BeltSpeedMps => 0;
    public abstract void AppendParts(List<PartPosition> into);
}
