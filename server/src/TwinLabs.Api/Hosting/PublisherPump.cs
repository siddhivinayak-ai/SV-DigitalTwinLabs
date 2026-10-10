using System.Diagnostics;
using System.Threading.Channels;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Feeds every enabled <see cref="ITwinPublisher"/> (virtual PLC, MQTT publisher) once per sim second, off the host
/// lock. Each publisher has its own worker task and queue, so a slow or blocked publisher only delays itself.
/// <see cref="Post"/> never blocks: when a worker already has <see cref="MaxPendingSamples"/> samples queued the new
/// one is dropped. Plant changes are queued on the same worker (Stop then Start), so <c>Publish</c> never runs
/// concurrently with <c>StartAsync</c>. Publisher exceptions are logged (throttled) and never stop the worker.
/// </summary>
public sealed class PublisherPump(IEnumerable<ITwinPublisher> publishers, ILogger<PublisherPump> log) : IAsyncDisposable
{
    public const int MaxPendingSamples = 4;
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(5);

    private readonly IReadOnlyList<ITwinPublisher> _publishers = [.. publishers];
    private readonly Lock _gate = new();
    private readonly CancellationTokenSource _cts = new();
    private List<Worker> _workers = [];
    private bool _stopped;

    private sealed record Sample(long SimTimeMs, IReadOnlyList<AssetState> Assets, IReadOnlyList<SensorValue> Sensors);

    /// <summary>Number of running publisher workers (enabled publishers).</summary>
    public int Count { get { lock (_gate) return _workers.Count; } }

    /// <summary>Start a worker for every enabled publisher and have it call <c>StartAsync(plant)</c>. Returns at once.</summary>
    public Task StartAsync(PlantModel plant, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (_stopped || _workers.Count > 0) return Task.CompletedTask;
            foreach (var p in _publishers)
            {
                bool enabled;
                try { enabled = p.Enabled; }
                catch (Exception ex) { log.LogError(ex, "Publisher {Type}: Enabled threw; skipping it", p.GetType().Name); continue; }
                if (!enabled) continue;
                var w = new Worker(p, log, _cts.Token);
                w.Restart(plant);
                _workers.Add(w);
                log.LogInformation("Publisher '{Name}' enabled", SafeName(p));
            }
        }
        return Task.CompletedTask;
    }

    /// <summary>Stop and restart every publisher on the new plant (queued behind pending samples).</summary>
    public void OnPlantChanged(PlantModel plant)
    {
        lock (_gate)
            foreach (var w in _workers) w.Restart(plant);
    }

    /// <summary>Hand one sample to every worker. Called under the host lock; never blocks.</summary>
    public void Post(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors)
    {
        List<Worker> workers;
        lock (_gate) workers = _workers;
        if (workers.Count == 0) return;
        var s = new Sample(simTimeMs, assets, sensors);
        foreach (var w in workers) w.Post(s);
    }

    public async Task StopAsync()
    {
        List<Worker> workers;
        lock (_gate)
        {
            if (_stopped) return;
            _stopped = true;
            workers = _workers;
            _workers = [];
        }
        await Task.WhenAll(workers.Select(w => w.StopAsync(StopTimeout)));
        _cts.Cancel();
    }

    public async ValueTask DisposeAsync() => await StopAsync();

    private static string SafeName(ITwinPublisher p)
    {
        try { return p.Name; } catch { return p.GetType().Name; }
    }

    private sealed class Worker
    {
        private static readonly long ErrorLogInterval = Stopwatch.Frequency * 10;

        private readonly ITwinPublisher _p;
        private readonly ILogger _log;
        private readonly CancellationToken _ct;
        private readonly Channel<object> _queue = Channel.CreateUnbounded<object>(new UnboundedChannelOptions { SingleReader = true });
        private readonly Task _loop;
        private int _pending;
        private bool _started;
        private long _lastErrorLog;
        private int _suppressed;

        public Worker(ITwinPublisher p, ILogger log, CancellationToken ct)
        {
            _p = p;
            _log = log;
            _ct = ct;
            _loop = Task.Run(RunAsync);
        }

        public void Restart(PlantModel plant) => _queue.Writer.TryWrite(plant);

        public void Post(Sample s)
        {
            if (Interlocked.Increment(ref _pending) > MaxPendingSamples || !_queue.Writer.TryWrite(s))
                Interlocked.Decrement(ref _pending);
        }

        private async Task RunAsync()
        {
            try
            {
                await foreach (var item in _queue.Reader.ReadAllAsync(_ct))
                {
                    switch (item)
                    {
                        case PlantModel plant:
                            if (_started) await Guard("StopAsync", () => _p.StopAsync());
                            _started = await Guard("StartAsync", () => _p.StartAsync(plant, _ct));
                            break;
                        case Sample s:
                            Interlocked.Decrement(ref _pending);
                            if (!_started) break;
                            try
                            {
                                _p.Publish(s.SimTimeMs, s.Assets, s.Sensors);
                            }
                            catch (Exception ex)
                            {
                                LogThrottled(ex);
                            }
                            break;
                    }
                }
            }
            catch (OperationCanceledException) when (_ct.IsCancellationRequested)
            {
                // shutdown
            }
        }

        private async Task<bool> Guard(string what, Func<Task> call)
        {
            try
            {
                await call();
                return true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !_ct.IsCancellationRequested)
            {
                // e.g. the virtual PLC's StartAsync throws when its port is in use: log, keep the host running.
                try { _log.LogError(ex, "Publisher '{Name}' {What} failed", SafeName(_p), what); } catch { }
                return false;
            }
            catch (OperationCanceledException)
            {
                return false;
            }
        }

        private void LogThrottled(Exception ex)
        {
            var now = Stopwatch.GetTimestamp();
            if (_lastErrorLog != 0 && now - _lastErrorLog < ErrorLogInterval)
            {
                _suppressed++;
                return;
            }
            try { _log.LogError(ex, "Publisher '{Name}' Publish failed ({Suppressed} similar errors suppressed)", SafeName(_p), _suppressed); } catch { }
            _lastErrorLog = now;
            _suppressed = 0;
        }

        public async Task StopAsync(TimeSpan timeout)
        {
            _queue.Writer.TryComplete();
            try
            {
                await _loop.WaitAsync(timeout);
            }
            catch (TimeoutException)
            {
                try { _log.LogWarning("Publisher '{Name}' did not drain within {Timeout}", SafeName(_p), timeout); } catch { }
            }
            catch (Exception)
            {
                // the loop never faults by design
            }
            if (_started) await Guard("StopAsync", () => _p.StopAsync());
        }
    }
}
