using System.Globalization;
using Microsoft.Extensions.Options;
using TwinLabs.Api.Realtime;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Sole owner of the live <see cref="ISimulationEngine"/>, its <see cref="IKpiCalculator"/> and
/// <see cref="IAnomalyDetector"/>. Every access goes through one lock. REST endpoints, the WebSocket hub and the
/// <see cref="SimulationLoop"/> all call in here; the loop drives time via <see cref="Advance"/>.
/// </summary>
public sealed partial class SimulationHost
{
    public const double MinSpeed = 0.25;
    public const double MaxSpeed = 100;
    public const int MaxEvents = 1000;
    public const int SnapshotEvents = 200;
    public const double MaxWhatIfSeconds = 7 * 24 * 3600;
    public static readonly TimeSpan LoopInterval = TimeSpan.FromMilliseconds(50);

    private readonly Lock _gate = new();
    private readonly ISimulationEngine _engine;
    private readonly IKpiCalculator _kpi;
    private readonly IAnomalyDetector _detector;
    private readonly IWhatIfRunner _whatIf;
    private readonly ClientRegistry _clients;
    private readonly TimeProvider _time;
    private readonly ILogger<SimulationHost> _log;

    private readonly PlantModel _originalPlant;
    private readonly HashSet<string> _assetIds;
    private readonly int _seed;
    private readonly SensorHistory _history;
    private readonly Queue<EventRecord> _events = new();
    private readonly int _maxTicksPerWake;
    private readonly long _tickIntervalTs;
    private readonly long _kpiIntervalTs;

    private SimRunState _state;
    private double _speed;
    private double _accumS;          // sim seconds owed to the engine but not yet stepped
    private long _lastSampleSecond;  // last whole sim second recorded into history / the detector
    private long _eventId;
    private KpiReport? _lastKpi;
    private long _lastTickTs;
    private long _lastKpiTs;
    private int _whatIfBusy;

    public SimulationHost(
        PlantModel plant,
        ISimulationEngineFactory factory,
        IKpiCalculator kpi,
        IAnomalyDetector detector,
        IWhatIfRunner whatIf,
        ClientRegistry clients,
        IOptions<TwinOptions> options,
        TimeProvider time,
        ILogger<SimulationHost> log)
    {
        var o = options.Value;
        _kpi = kpi;
        _detector = detector;
        _whatIf = whatIf;
        _clients = clients;
        _time = time;
        _log = log;

        _originalPlant = ClonePlant(plant);
        _assetIds = [.. plant.Assets.Select(a => a.Id)];
        _seed = o.Seed ?? plant.Seed;
        _engine = factory.Create(ClonePlant(plant), _seed);
        _history = new SensorHistory(plant.Sensors, Math.Max(1, o.HistorySeconds));

        var tickHz = double.IsFinite(o.TickHz) && o.TickHz > 0 ? Math.Min(o.TickHz, 60) : 5;
        _tickIntervalTs = (long)(time.TimestampFrequency / tickHz);
        _kpiIntervalTs = time.TimestampFrequency;
        // Ticks needed per wake at max speed, with 2x headroom for a late wake. Anything beyond is dropped.
        _maxTicksPerWake = Math.Max(1, (int)Math.Ceiling(MaxSpeed * LoopInterval.TotalSeconds / _engine.Dt) * 2);

        _speed = ClampSpeed(o.Speed);
        _state = o.AutoStart ? SimRunState.Running : SimRunState.Stopped;
        _lastTickTs = _lastKpiTs = time.GetTimestamp();

        InitShadow(o); // v0.2 shadow-mode hook
        lock (_gate) ResetLocked($"Simulation initialised (seed {_seed})");
    }

    // ------------------------------------------------------------------ reads

    public SimStatus Status { get { lock (_gate) return StatusLocked(); } }

    public long SimTimeMs { get { lock (_gate) return _engine.SimTimeMs; } }

    public PlantModel GetPlant() { lock (_gate) return ClonePlant(_engine.Plant); }

    public SnapshotData GetSnapshot() { lock (_gate) return SnapshotLocked(); }

    public KpiReport GetKpi() { lock (_gate) return _lastKpi = _kpi.Compute(KpiEngineLocked()); }

    public IReadOnlyList<Alarm> GetActiveAlarms() { lock (_gate) return ActiveAlarmsLocked(); }

    public IReadOnlyList<EventRecord> GetEvents(int limit)
    {
        if (limit < 1) throw new ArgumentException("limit must be >= 1", nameof(limit));
        lock (_gate)
        {
            var n = Math.Min(limit, _events.Count);
            return [.. _events.Skip(_events.Count - n)];
        }
    }

    public HistorySeries GetHistory(string sensorId, double seconds)
    {
        var window = WindowMs(seconds);
        lock (_gate) return _history.GetSeries(sensorId, _engine.SimTimeMs - window);
    }

    public (string FileName, HistoryTable Table) ExportHistory(double seconds)
    {
        var window = WindowMs(seconds);
        HistoryTable table;
        long now;
        string plantId;
        lock (_gate)
        {
            now = _engine.SimTimeMs;
            plantId = _engine.Plant.Id;
            table = _history.Slice(now - window);
        }
        return ($"{plantId}-history-{now / 1000}s.csv", table);
    }

    private long WindowMs(double seconds)
    {
        if (!double.IsFinite(seconds) || seconds <= 0) throw new ArgumentException("seconds must be > 0", nameof(seconds));
        // The window ends at "now": a sample exactly `seconds` ago is included.
        return (long)(Math.Min(seconds, _history.Capacity) * 1000);
    }

    // ------------------------------------------------------------------ run control

    public SimStatus Start() => Command(CommandActions.SimStart, null, null, () =>
    {
        _state = SimRunState.Running;
        return StatusLocked();
    });

    public SimStatus Pause() => Command(CommandActions.SimPause, null, null, () =>
    {
        if (_state == SimRunState.Running) _state = SimRunState.Paused;
        _accumS = 0;
        return StatusLocked();
    });

    /// <summary>Pause and rewind to t=0.</summary>
    public SimStatus Stop() => Command(CommandActions.SimStop, null, null, () =>
    {
        _state = SimRunState.Stopped;
        ResetLocked($"Simulation stopped and reset (seed {_seed})");
        BroadcastLocked(MessageTypes.Snapshot, SnapshotLocked());
        return StatusLocked();
    });

    /// <summary>Rewind engine, KPIs, alarms and history to t=0; the run state is kept.</summary>
    public SimStatus Reset() => Command(CommandActions.SimReset, null, null, () =>
    {
        ResetLocked($"Simulation reset (seed {_seed})");
        BroadcastLocked(MessageTypes.Snapshot, SnapshotLocked());
        return StatusLocked();
    });

    public SimStatus SetSpeed(double speed) => Command(CommandActions.SimSpeed, null, Num(speed), () =>
    {
        if (!double.IsFinite(speed) || speed <= 0)
            throw new ArgumentException($"Speed must be a positive number ({MinSpeed}..{MaxSpeed}), got {Num(speed)}");
        RejectSpeedInShadowLocked();
        _speed = ClampSpeed(speed);
        return StatusLocked();
    });

    private static double ClampSpeed(double s) => double.IsFinite(s) && s > 0 ? Math.Clamp(s, MinSpeed, MaxSpeed) : 1;

    // ------------------------------------------------------------------ asset commands

    public AssetDef UpdateParams(string assetId, IReadOnlyDictionary<string, double>? changes) =>
        Command(CommandActions.AssetParams, assetId, changes is null ? null : string.Join(", ", changes.Select(kv => $"{kv.Key}={Num(kv.Value)}")), () =>
        {
            RequireAsset(assetId);
            if (changes is null || changes.Count == 0) throw new ArgumentException("params must contain at least one entry");
            foreach (var (k, v) in changes)
            {
                if (string.IsNullOrWhiteSpace(k)) throw new ArgumentException("param keys must be non-empty");
                if (!double.IsFinite(v)) throw new ArgumentException($"param '{k}' must be a finite number");
            }
            var def = _engine.UpdateParams(assetId, changes);
            BroadcastLocked(MessageTypes.Params, new ParamsData(def.Id, new Dictionary<string, double>(def.Params)));
            return def;
        });

    public AssetState InjectFault(string assetId, double? durationS) =>
        Command(CommandActions.AssetFault, assetId, durationS is { } d ? $"{Num(d)} s" : null, () =>
        {
            RequireAsset(assetId);
            if (durationS is { } dur && (!double.IsFinite(dur) || dur <= 0))
                throw new ArgumentException("durationS must be > 0");
            _engine.InjectFault(assetId, durationS);
            return AssetStateLocked(assetId);
        });

    public AssetState ClearFault(string assetId) => Command(CommandActions.AssetClearFault, assetId, null, () =>
    {
        RequireAsset(assetId);
        _engine.ClearFault(assetId);
        return AssetStateLocked(assetId);
    });

    public AssetState SetMaintenance(string assetId, bool on) => Command(CommandActions.AssetMaintenance, assetId, on ? "on" : "off", () =>
    {
        RequireAsset(assetId);
        _engine.SetMaintenance(assetId, on);
        return AssetStateLocked(assetId);
    });

    public AssetState SetEnabled(string assetId, bool enabled) => Command(CommandActions.AssetEnable, assetId, enabled ? "on" : "off", () =>
    {
        RequireAsset(assetId);
        _engine.SetEnabled(assetId, enabled);
        return AssetStateLocked(assetId);
    });

    public Alarm AcknowledgeAlarm(string alarmId) => Command(CommandActions.AlarmAck, null, alarmId, () =>
    {
        if (string.IsNullOrWhiteSpace(alarmId)) throw new ArgumentException("alarmId is required");
        var alarm = _detector.Acknowledge(alarmId) ?? AcknowledgeDeviationLocked(alarmId) ?? throw TwinErrors.UnknownAlarm(alarmId);
        PublishAlarmLocked(alarm);
        return alarm;
    });

    /// <summary>Dispatch a WebSocket command. Never throws for client errors; returns the ack to send.</summary>
    public AckData Execute(CommandData cmd)
    {
        var id = cmd.Id ?? "";
        try
        {
            switch (cmd.Action)
            {
                case CommandActions.SimStart: Start(); break;
                case CommandActions.SimPause: Pause(); break;
                case CommandActions.SimStop: Stop(); break;
                case CommandActions.SimReset: Reset(); break;
                case CommandActions.SimSpeed: SetSpeed(cmd.Value ?? throw new ArgumentException("sim.speed requires 'value'")); break;
                case CommandActions.AssetParams: UpdateParams(RequireId(cmd), cmd.Params); break;
                case CommandActions.AssetFault: InjectFault(RequireId(cmd), cmd.DurationS); break;
                case CommandActions.AssetClearFault: ClearFault(RequireId(cmd)); break;
                case CommandActions.AssetMaintenance: SetMaintenance(RequireId(cmd), Toggle(cmd)); break;
                case CommandActions.AssetEnable: SetEnabled(RequireId(cmd), Toggle(cmd)); break;
                case CommandActions.AlarmAck: AcknowledgeAlarm(cmd.AlarmId ?? throw new ArgumentException("alarm.ack requires 'alarmId'")); break;
                case CommandActions.TwinMode: SetMode(ParseMode(cmd)); break;
                default: throw new ArgumentException($"Unknown action '{cmd.Action}'");
            }
            return new AckData(id, true);
        }
        catch (Exception ex) when (TwinErrors.TryMap(ex, out _, out _))
        {
            return new AckData(id, false, ex.Message);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Command {Action} ({Id}) failed", cmd.Action, id);
            return new AckData(id, false, $"Internal error: {ex.Message}");
        }

        static string RequireId(CommandData c) =>
            string.IsNullOrWhiteSpace(c.AssetId) ? throw new ArgumentException($"{c.Action} requires 'assetId'") : c.AssetId;

        static bool Toggle(CommandData c) => c.Value switch
        {
            1 => true,
            0 => false,
            null => throw new ArgumentException($"{c.Action} requires 'value' 1 or 0"),
            var v => throw new ArgumentException($"{c.Action} 'value' must be 1 or 0, got {Num(v.Value)}"),
        };
    }

    // ------------------------------------------------------------------ what-if

    /// <summary>
    /// Copies the base plant under the lock, then runs the scenario on a pool thread so the live loop never
    /// stalls. Only one run at a time (<see cref="WhatIfBusyException"/> otherwise).
    /// </summary>
    public async Task<WhatIfResult> RunWhatIfAsync(WhatIfRequest request, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!double.IsFinite(request.DurationS) || request.DurationS <= 0 || request.DurationS > MaxWhatIfSeconds)
            throw new ArgumentException($"durationS must be in (0, {MaxWhatIfSeconds}]");
        var req = request with { Overrides = request.Overrides ?? [] };

        PlantModel basePlant;
        lock (_gate)
        {
            foreach (var ov in req.Overrides)
            {
                if (ov?.AssetId is null) throw new ArgumentException("every override needs an assetId");
                RequireAsset(ov.AssetId);
                if (ov.Params is null) throw new ArgumentException($"override for '{ov.AssetId}' needs params");
                foreach (var (k, v) in ov.Params)
                    if (!double.IsFinite(v)) throw new ArgumentException($"override {ov.AssetId}.{k} must be a finite number");
            }
            basePlant = ClonePlant(req.FromLive ? _engine.Plant : _originalPlant);
        }

        if (Interlocked.CompareExchange(ref _whatIfBusy, 1, 0) != 0) throw new WhatIfBusyException();
        try
        {
            return await Task.Run(() => _whatIf.Run(req, basePlant), ct);
        }
        finally
        {
            Volatile.Write(ref _whatIfBusy, 0);
        }
    }

    // ------------------------------------------------------------------ realtime

    /// <summary>Register a client. Its first frame is a snapshot, queued atomically with the registration.</summary>
    public void Connect(ClientOutbox client)
    {
        lock (_gate)
        {
            client.Enqueue(Frame.Create(MessageTypes.Snapshot, _engine.SimTimeMs, SnapshotLocked()));
            _clients.Add(client);
        }
    }

    public void Disconnect(ClientOutbox client) => _clients.Remove(client);

    /// <summary>
    /// Called by the loop on every wake with the elapsed wall time. Steps whole engine ticks worth
    /// <c>wallDelta × speed</c>, samples history / anomaly detection each sim second, drains engine events, and
    /// emits <c>tick</c> at TickHz and <c>kpi</c> at 1 Hz wall time.
    /// </summary>
    public void Advance(TimeSpan wallDelta)
    {
        lock (_gate)
        {
            ApplyTagUpdatesLocked();
            if (_state == SimRunState.Running && wallDelta > TimeSpan.Zero)
            {
                var dt = _engine.Dt;
                _accumS += wallDelta.TotalSeconds * _speed;
                var n = (long)Math.Floor(_accumS / dt + 1e-9);
                if (n > _maxTicksPerWake)
                {
                    n = _maxTicksPerWake;
                    _accumS = 0; // drop the backlog instead of spiralling behind
                }
                else
                {
                    _accumS = Math.Max(0, _accumS - n * dt);
                }

                for (var i = 0; i < n; i++)
                {
                    _engine.Step();
                    SampleIfDueLocked();
                }
                DrainEngineEventsLocked();
            }

            var now = _time.GetTimestamp();
            if (now - _lastTickTs >= _tickIntervalTs)
            {
                _lastTickTs = now;
                if (_clients.Count > 0)
                    BroadcastLocked(MessageTypes.Tick, TickLocked());
            }
            if (now - _lastKpiTs >= _kpiIntervalTs)
            {
                _lastKpiTs = now;
                _lastKpi = _kpi.Compute(KpiEngineLocked());
                BroadcastLocked(MessageTypes.Kpi, _lastKpi);
            }
        }
    }

    // ------------------------------------------------------------------ internals (call with _gate held)

    private T Command<T>(string action, string? assetId, string? detail, Func<T> body)
    {
        lock (_gate)
        {
            var what = action + (assetId is null ? "" : " " + assetId) + (detail is null ? "" : " " + detail);
            try
            {
                var result = body();
                DrainEngineEventsLocked();
                AddEventLocked(EventKind.Command, Severity.Info, $"Command {what}", assetId);
                return result;
            }
            catch (Exception ex)
            {
                AddEventLocked(EventKind.Command, Severity.Warning, $"Command {what} rejected: {ex.Message}",
                    assetId is not null && _assetIds.Contains(assetId) ? assetId : null);
                throw;
            }
        }
    }

    private void ResetLocked(string message)
    {
        _engine.DrainEvents(); // stale
        _engine.Reset(_seed);
        _engine.DrainEvents();
        _kpi.Reset();
        _detector.Reset();
        _history.Clear();
        _events.Clear();
        _eventId = 0;
        _accumS = 0;
        _lastKpi = null;
        _history.Record(_engine.SimTimeMs, _engine.GetSensorValues());
        _lastSampleSecond = _engine.SimTimeMs / 1000;
        ResetShadowLocked();
        AddEventLocked(EventKind.Info, Severity.Info, message);
    }

    private void SampleIfDueLocked()
    {
        var t = _engine.SimTimeMs;
        var sec = t / 1000;
        if (sec <= _lastSampleSecond) return;
        _lastSampleSecond = sec;

        var sensors = TwinSensorsLocked();
        _history.Record(t, sensors);
        DrainEngineEventsLocked(); // keep fault events ahead of the alarms they cause
        var assets = TwinAssetsLocked();
        foreach (var alarm in _detector.Observe(t, sensors, assets))
            PublishAlarmLocked(alarm);
        OnSimSecondLocked(t, assets, sensors);
    }

    private void PublishAlarmLocked(Alarm alarm)
    {
        BroadcastLocked(MessageTypes.Alarm, alarm);
        ForwardAlarmLocked(alarm);
        var (severity, prefix) = alarm switch
        {
            { Active: false } => (Severity.Info, "CLEARED "),
            { Acknowledged: true } => (Severity.Info, "ACK "),
            _ => (alarm.Severity, ""),
        };
        AddEventLocked(EventKind.Alarm, severity, prefix + alarm.Message, alarm.AssetId);
    }

    private void DrainEngineEventsLocked()
    {
        foreach (var e in _engine.DrainEvents())
            if (KeepEngineEventLocked(e)) PushEventLocked(e);
    }

    private void AddEventLocked(EventKind kind, Severity severity, string message, string? assetId = null) =>
        PushEventLocked(new EventRecord(0, _engine.SimTimeMs, kind, severity, message, assetId));

    /// <summary>All events (engine and host) are renumbered from one counter so ids are unique and monotonic.</summary>
    private void PushEventLocked(EventRecord e)
    {
        var rec = e with { Id = ++_eventId };
        _events.Enqueue(rec);
        while (_events.Count > MaxEvents) _events.Dequeue();
        BroadcastLocked(MessageTypes.Event, rec);
        ForwardEventLocked(rec);
    }

    private void BroadcastLocked<T>(string type, T data)
    {
        if (_clients.Count == 0) return;
        _clients.Broadcast(Frame.Create(type, _engine.SimTimeMs, data));
    }

    private SimStatus StatusLocked() => new(_state, _speed, _engine.SimTimeMs, _engine.Tick, _engine.Seed, _mode);

    private SnapshotData SnapshotLocked() => new(
        ClonePlant(_engine.Plant),
        StatusLocked(),
        TwinAssetsLocked(),
        TwinSensorsLocked(),
        _engine.GetParts(),
        _lastKpi,
        ActiveAlarmsLocked(),
        [.. _events.Skip(Math.Max(0, _events.Count - SnapshotEvents))],
        ConnectionsSnapshot());

    private AssetState AssetStateLocked(string assetId) =>
        _engine.GetAssetStates().FirstOrDefault(a => a.Id == assetId) ?? throw TwinErrors.UnknownAsset(assetId);

    private void RequireAsset(string? assetId)
    {
        if (string.IsNullOrWhiteSpace(assetId)) throw new ArgumentException("assetId is required");
        if (!_assetIds.Contains(assetId)) throw TwinErrors.UnknownAsset(assetId);
    }

    private static string Num(double v) => v.ToString("0.###", CultureInfo.InvariantCulture);

    /// <summary>Deep copy, so callers off the lock never share mutable collections with the engine.</summary>
    internal static PlantModel ClonePlant(PlantModel p) => p with
    {
        Assets = [.. p.Assets.Select(a => a with
        {
            Downstream = [.. a.Downstream],
            Params = new Dictionary<string, double>(a.Params),
        })],
        Sensors = [.. p.Sensors],
    };
}
