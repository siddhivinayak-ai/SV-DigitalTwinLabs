using System.Collections.Concurrent;
using TwinLabs.Connect;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// v0.2 connected twin (feature/shadow-mode): twin modes, the shadow state applier, deviation alarms, and the hooks
/// that feed connections, publishers and event sinks.
/// <para>
/// <b>Shadow semantics.</b> External tag values (from <see cref="ConnectionManager"/>) are queued lock-free by
/// <see cref="EnqueueTagUpdates"/> and applied under the host lock at the start of every <see cref="Advance"/>. The
/// engine keeps stepping as a free-running <b>predictor</b> at speed 1. The engine has no state-injection API, so
/// the predictor is aligned with the real line <b>in time only</b> (it is reset when shadow mode starts) and does
/// not resynchronise its internal state (parts, timers, wear) from the actual values. Broadcast state uses the
/// actual value of every bound target that is fresh (see <see cref="ShadowState"/>), and the predictor for unbound
/// or stale targets; part positions always come from the predictor. KPIs, history, CSV and the anomaly detector all
/// see the actual values. Publishers (virtual PLC, MQTT) receive the predictor in shadow mode, so a twin that reads
/// its own virtual PLC does not feed its output back into its input.
/// </para>
/// </summary>
public sealed partial class SimulationHost
{
    public const int MaxQueuedTagUpdates = 200_000;

    private readonly ConcurrentQueue<(string ConnectionId, ResolvedUpdate Update)> _tagQueue = new();
    private TwinMode _mode;
    private ShadowState _shadow = null!;
    private ShadowEngineView _view = null!;
    private ConnectionManager? _connections;
    private PublisherPump? _pump;
    private EventSinkForwarder? _sinks;
    private long _droppedTagUpdates;

    /// <summary>Current twin mode.</summary>
    public TwinMode Mode { get { lock (_gate) return _mode; } }

    /// <summary>Tag updates dropped because the sim loop fell behind (queue full).</summary>
    public long DroppedTagUpdates => Interlocked.Read(ref _droppedTagUpdates);

    /// <summary>Switch between simulate and shadow. Shadow needs at least one binding (409) and resets the predictor.</summary>
    public SimStatus SetMode(TwinMode mode) => Command(CommandActions.TwinMode, null, ModeName(mode), () =>
    {
        if (!Enum.IsDefined(mode)) throw new ArgumentException($"Unknown twin mode '{mode}'");
        if (mode == _mode) return StatusLocked();

        if (mode == TwinMode.Shadow)
        {
            if (_shadow.BindingCount == 0)
                throw new TwinConflictException($"Shadow mode needs at least one binding; plant '{_engine.Plant.Id}' has none.");
            _mode = TwinMode.Shadow;
            _speed = 1;
            ResetLocked($"Shadow mode: predictor reset (seed {_seed})");
        }
        else
        {
            foreach (var cleared in _shadow.ClearDeviations(_engine.SimTimeMs)) PublishAlarmLocked(cleared);
            _mode = TwinMode.Simulate;
            _kpi.Reset();
            AddEventLocked(EventKind.Info, Severity.Info, "Simulate mode: the engine drives the twin");
        }
        BroadcastLocked(MessageTypes.Snapshot, SnapshotLocked());
        return StatusLocked();
    });

    /// <summary>Called by tag sources (any thread). Never blocks and never touches the engine.</summary>
    public void EnqueueTagUpdates(string connectionId, IReadOnlyList<ResolvedUpdate> updates)
    {
        foreach (var u in updates)
        {
            if (_tagQueue.Count >= MaxQueuedTagUpdates)
            {
                Interlocked.Increment(ref _droppedTagUpdates);
                continue;
            }
            _tagQueue.Enqueue((connectionId, u));
        }
    }

    /// <summary>Broadcast a WS <c>connection</c> frame; log an event when the connection state itself changed.</summary>
    public void PublishConnection(ConnectionStatus status, bool stateChanged)
    {
        lock (_gate)
        {
            BroadcastLocked(MessageTypes.Connection, status);
            if (!stateChanged) return;
            var sev = status.Status == ConnectionState.Error ? Severity.Warning : Severity.Info;
            var what = status.Status.ToString().ToLowerInvariant();
            AddEventLocked(EventKind.Info, sev, $"Connection {status.Id} {what}" + (status.Error is { Length: > 0 } e ? $": {e}" : ""));
        }
    }

    /// <summary>Current live tick payload (what the next <c>tick</c> frame carries).</summary>
    internal TickData GetTick() { lock (_gate) return TickLocked(); }

    /// <summary>
    /// Wire the connectivity services in (done once by <see cref="ConnectivityService"/> at startup). The sink receives
    /// the events and active alarms recorded so far, so nothing logged during construction is lost.
    /// </summary>
    internal void AttachConnectivity(ConnectionManager? connections, PublisherPump? pump, EventSinkForwarder? sinks)
    {
        lock (_gate)
        {
            _connections = connections;
            _pump = pump;
            _sinks = sinks;
            if (sinks is null) return;
            foreach (var e in _events) sinks.Post(e);
            foreach (var a in ActiveAlarmsLocked()) sinks.Post(a);
        }
    }

    // ------------------------------------------------------------------ hooks (called from SimulationHost.cs)

    /// <summary>Constructor hook, before the first reset.</summary>
    private void InitShadow(TwinOptions o)
    {
        _shadow = new ShadowState(_engine.Plant);
        _view = new ShadowEngineView(_engine);
        if (o.Mode == TwinMode.Shadow)
        {
            if (_shadow.BindingCount > 0)
            {
                _mode = TwinMode.Shadow;
                _speed = 1;
            }
            else
            {
                _log.LogWarning("Twin:Mode is shadow but plant '{Plant}' has no bindings; starting in simulate mode", _engine.Plant.Id);
            }
        }
        PlantChanged += OnPlantChangedShadow;
    }

    private void OnPlantChangedShadow(PlantModel plant)
    {
        lock (_gate)
        {
            _shadow = new ShadowState(plant, _shadow);
            _view.Reset(_engine);
            _shadow.ResetSession(_engine.SimTimeMs);
            if (_mode == TwinMode.Shadow && _shadow.BindingCount == 0)
            {
                _mode = TwinMode.Simulate;
                _kpi.Reset();
                AddEventLocked(EventKind.Info, Severity.Warning, $"Plant '{plant.Id}' has no bindings: back to simulate mode");
                BroadcastLocked(MessageTypes.Snapshot, SnapshotLocked());
            }
        }
    }

    /// <summary>ResetLocked hook: new predictor session.</summary>
    private void ResetShadowLocked()
    {
        _shadow.ResetSession(_engine.SimTimeMs);
        _view.Reset(_engine);
    }

    /// <summary>Advance hook: apply queued tag values (in every mode, so a switch to shadow has values at once).</summary>
    private void ApplyTagUpdatesLocked()
    {
        if (_tagQueue.IsEmpty) return;
        var t = _engine.SimTimeMs;
        var n = 0;
        while (n++ < MaxQueuedTagUpdates && _tagQueue.TryDequeue(out var item))
        {
            if (_shadow.Apply(item.ConnectionId, item.Update, t) is not { } change || _mode != TwinMode.Shadow) continue;
            var id = item.Update.Id;
            PushEventLocked(new EventRecord(0, t, EventKind.State, change.To == AssetStateKind.Fault ? Severity.Warning : Severity.Info,
                $"{id} {Lower(change.From)} -> {Lower(change.To)} (actual)", id, change.From, change.To));
        }
    }

    /// <summary>In shadow, predictor state events of assets whose state is bound are dropped; the actual transitions are logged instead.</summary>
    private bool KeepEngineEventLocked(EventRecord e) =>
        _mode != TwinMode.Shadow || e.Kind != EventKind.State || e.AssetId is null || !_shadow.IsStateBound(e.AssetId);

    /// <summary>SampleIfDueLocked hook, once per sim second after history and the anomaly detector.</summary>
    private void OnSimSecondLocked(long simMs, IReadOnlyList<AssetState> twinAssets, IReadOnlyList<SensorValue> twinSensors)
    {
        if (_mode == TwinMode.Shadow)
        {
            var now = NowWallMs();
            var predictedAssets = _engine.GetAssetStates();
            var predictedSensors = _engine.GetSensorValues();
            var counts = _shadow.KpiCounts(predictedAssets, now, out var wipDelta);
            _view.Accumulate(simMs, twinAssets, twinSensors, counts, wipDelta);
            foreach (var alarm in _shadow.EvaluateDeviations(simMs, predictedSensors, now)) PublishAlarmLocked(alarm);
            _pump?.Post(simMs, predictedAssets, predictedSensors);
        }
        else
        {
            _pump?.Post(simMs, twinAssets, twinSensors);
        }
    }

    private IReadOnlyList<AssetState> TwinAssetsLocked() =>
        _mode == TwinMode.Shadow ? _shadow.MergeAssets(_engine.GetAssetStates(), NowWallMs()) : _engine.GetAssetStates();

    private IReadOnlyList<SensorValue> TwinSensorsLocked() =>
        _mode == TwinMode.Shadow ? _shadow.MergeSensors(_engine.GetSensorValues(), NowWallMs()) : _engine.GetSensorValues();

    private TickData TickLocked() => new(StatusLocked(), TwinAssetsLocked(), TwinSensorsLocked(), _engine.GetParts());

    private ISimulationEngine KpiEngineLocked() => _mode == TwinMode.Shadow ? _view : _engine;

    private IReadOnlyList<Alarm> ActiveAlarmsLocked() => [.. _detector.Active, .. _shadow.ActiveDeviations];

    private Alarm? AcknowledgeDeviationLocked(string alarmId) => _shadow.Acknowledge(alarmId);

    private IReadOnlyList<ConnectionStatus> ConnectionsSnapshot() => _connections?.Statuses ?? [];

    private void RejectSpeedInShadowLocked()
    {
        if (_mode == TwinMode.Shadow)
            throw new TwinConflictException("Speed is fixed at 1x in shadow mode (the twin mirrors the real line); switch to simulate mode to change it.");
    }

    private void ForwardEventLocked(EventRecord e) => _sinks?.Post(e);

    private void ForwardAlarmLocked(Alarm a) => _sinks?.Post(a);

    private static TwinMode ParseMode(CommandData c) => c.Value switch
    {
        0 => TwinMode.Simulate,
        1 => TwinMode.Shadow,
        null => throw new ArgumentException("twin.mode requires 'value' 0 (simulate) or 1 (shadow)"),
        var v => throw new ArgumentException($"twin.mode 'value' must be 0 (simulate) or 1 (shadow), got {Num(v.Value)}"),
    };

    private long NowWallMs() => _time.GetUtcNow().ToUnixTimeMilliseconds();

    private static string ModeName(TwinMode m) => m.ToString().ToLowerInvariant();

    private static string Lower(AssetStateKind s) => s.ToString().ToLowerInvariant();
}
