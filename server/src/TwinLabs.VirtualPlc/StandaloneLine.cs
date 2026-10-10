using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Opc.Ua;
using TwinLabs.Core;

namespace TwinLabs.VirtualPlc;

/// <summary>
/// The emulated physical line: its own engine on its own wall-clock loop (real time × speed).
/// Only the loop thread writes to the address space; commands set a dirty flag so the next loop
/// iteration (≤ <see cref="LoopInterval"/>) publishes the result. This keeps lock order trivial
/// (engine lock and node-manager lock are never nested).
/// </summary>
internal sealed class StandaloneLine : IPlcCommands, IAsyncDisposable
{
    public static readonly TimeSpan LoopInterval = TimeSpan.FromMilliseconds(100);
    public const double MaxSpeed = 1000;
    private const int MaxStepsPerIteration = 20_000;

    private readonly ISimulationEngine _engine;
    private readonly ILogger _log;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly Stopwatch _wall = Stopwatch.StartNew();
    private Task? _loop;
    private Func<PlcNodeManager?> _target = () => null;

    private bool _running = true;
    private double _speed;
    private double _anchorWallMs;
    private long _anchorSimMs;
    private bool _dirty = true;

    public StandaloneLine(ISimulationEngine engine, double speed, ILogger log)
    {
        _engine = engine;
        _speed = speed;
        _log = log;
    }

    public bool Running { get { lock (_gate) return _running; } }
    public double Speed { get { lock (_gate) return _speed; } }

    public void Run(Func<PlcNodeManager?> target)
    {
        _target = target;
        lock (_gate) Rebase();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private void Rebase()
    {
        _anchorWallMs = _wall.Elapsed.TotalMilliseconds;
        _anchorSimMs = _engine.SimTimeMs;
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(LoopInterval);
        try
        {
            do
            {
                try { Iterate(); }
                catch (Exception ex) { _log.LogError(ex, "Virtual PLC standalone loop iteration failed"); }
            } while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false));
        }
        catch (OperationCanceledException) { }
    }

    private void Iterate()
    {
        long simMs;
        IReadOnlyList<Core.Contracts.AssetState> assets;
        IReadOnlyList<Core.Contracts.SensorValue> sensors;
        bool running;
        double speed;
        lock (_gate)
        {
            var publish = _dirty;
            if (_running)
            {
                var target = _anchorSimMs + (long)((_wall.Elapsed.TotalMilliseconds - _anchorWallMs) * _speed);
                var steps = 0;
                var startSecond = _engine.SimTimeMs / 1000;
                while (_engine.SimTimeMs < target && steps++ < MaxStepsPerIteration) _engine.Step();
                if (steps >= MaxStepsPerIteration) Rebase(); // fell behind: drop the backlog rather than spiral
                publish |= _engine.SimTimeMs / 1000 != startSecond;
            }
            if (!publish) return;
            _engine.DrainEvents(); // nobody consumes them; keep the queue bounded
            _dirty = false;
            simMs = _engine.SimTimeMs;
            assets = _engine.GetAssetStates();
            sensors = _engine.GetSensorValues();
            running = _running;
            speed = _speed;
        }
        _target()?.Write(simMs, assets, sensors, running, speed);
    }

    // ---- IPlcCommands (called on OPC UA request threads) ----

    public ServiceResult Start()
    {
        lock (_gate)
        {
            if (!_running) { _running = true; Rebase(); }
            _dirty = true;
        }
        _log.LogInformation("Virtual PLC: line started");
        return ServiceResult.Good;
    }

    public ServiceResult Pause()
    {
        lock (_gate) { _running = false; _dirty = true; }
        _log.LogInformation("Virtual PLC: line paused");
        return ServiceResult.Good;
    }

    public ServiceResult SetSpeed(double speed)
    {
        if (!double.IsFinite(speed) || speed <= 0 || speed > MaxSpeed)
            return Bad(StatusCodes.BadOutOfRange, $"speed must be in (0, {MaxSpeed}]");
        lock (_gate) { Rebase(); _speed = speed; _dirty = true; }
        return ServiceResult.Good;
    }

    public ServiceResult InjectFault(string assetId, double durationS)
    {
        if (string.IsNullOrWhiteSpace(assetId)) return Bad(StatusCodes.BadInvalidArgument, "assetId is required");
        if (!double.IsFinite(durationS) || durationS < 0) return Bad(StatusCodes.BadOutOfRange, "durationS must be >= 0 (0 = draw from MTTR)");
        lock (_gate)
        {
            try { _engine.InjectFault(assetId, durationS == 0 ? null : durationS); }
            catch (KeyNotFoundException) { return Bad(StatusCodes.BadInvalidArgument, $"unknown asset '{assetId}'"); }
            catch (ArgumentException ex) { return Bad(StatusCodes.BadInvalidArgument, ex.Message); }
            catch (InvalidOperationException ex) { return Bad(StatusCodes.BadInvalidState, ex.Message); }
            _dirty = true;
        }
        _log.LogInformation("Virtual PLC: fault injected on {AssetId}", assetId);
        return ServiceResult.Good;
    }

    public ServiceResult ClearFault(string assetId)
    {
        if (string.IsNullOrWhiteSpace(assetId)) return Bad(StatusCodes.BadInvalidArgument, "assetId is required");
        lock (_gate)
        {
            try { _engine.ClearFault(assetId); }
            catch (KeyNotFoundException) { return Bad(StatusCodes.BadInvalidArgument, $"unknown asset '{assetId}'"); }
            catch (ArgumentException ex) { return Bad(StatusCodes.BadInvalidArgument, ex.Message); }
            _dirty = true;
        }
        return ServiceResult.Good;
    }

    private static ServiceResult Bad(StatusCode code, string message) => new(code, new LocalizedText(message));

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null)
        {
            try { await _loop.ConfigureAwait(false); } catch { /* already logged */ }
        }
        _cts.Dispose();
    }
}
