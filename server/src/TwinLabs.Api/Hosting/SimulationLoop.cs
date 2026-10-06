namespace TwinLabs.Api.Hosting;

/// <summary>
/// Real-time pump. Wakes every <see cref="SimulationHost.LoopInterval"/> on a <see cref="PeriodicTimer"/> and
/// hands the elapsed wall time to <see cref="SimulationHost.Advance"/>. A long stall (debugger, GC, sleep) is
/// capped so the sim does not try to catch up minutes of backlog in one go.
/// </summary>
public sealed class SimulationLoop(SimulationHost host, TimeProvider time, ILogger<SimulationLoop> log) : BackgroundService
{
    private static readonly TimeSpan MaxWallDelta = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan ErrorLogInterval = TimeSpan.FromSeconds(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(SimulationHost.LoopInterval, time);
        var last = time.GetTimestamp();
        long lastErrorLog = 0;
        var suppressed = 0;

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                var now = time.GetTimestamp();
                var delta = time.GetElapsedTime(last, now);
                last = now;
                if (delta > MaxWallDelta) delta = MaxWallDelta;

                try
                {
                    host.Advance(delta);
                }
                catch (Exception ex)
                {
                    // Keep the loop alive; one bad step must not take the server down. Throttle the log.
                    if (lastErrorLog == 0 || time.GetElapsedTime(lastErrorLog, now) >= ErrorLogInterval)
                    {
                        log.LogError(ex, "Simulation loop step failed ({Suppressed} similar errors suppressed)", suppressed);
                        lastErrorLog = now;
                        suppressed = 0;
                    }
                    else
                    {
                        suppressed++;
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // shutdown
        }
    }
}
