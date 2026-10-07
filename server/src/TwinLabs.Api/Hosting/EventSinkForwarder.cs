using System.Threading.Channels;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Forwards every host event and every changed alarm to all <see cref="IHostEventSink"/> registrations (persistence)
/// on a background task, so sinks never run under the host lock. <see cref="Post(EventRecord)"/> never blocks: the
/// queue holds <see cref="Capacity"/> items and drops the oldest beyond that. A failing sink is logged and skipped.
/// With no sinks registered, posting is a no-op.
/// </summary>
public sealed class EventSinkForwarder : IAsyncDisposable
{
    public const int Capacity = 50_000;
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(5);

    private readonly IReadOnlyList<IHostEventSink> _sinks;
    private readonly ILogger<EventSinkForwarder> _log;
    private readonly Channel<object> _queue;
    private readonly CancellationTokenSource _cts = new();
    private Task _loop = Task.CompletedTask;
    private int _started;
    private int _stopped;

    public EventSinkForwarder(IEnumerable<IHostEventSink> sinks, ILogger<EventSinkForwarder> log)
    {
        _sinks = [.. sinks.Distinct()];
        _log = log;
        _queue = Channel.CreateBounded<object>(new BoundedChannelOptions(Capacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });
    }

    public int SinkCount => _sinks.Count;

    public void Start()
    {
        if (_sinks.Count == 0 || Interlocked.Exchange(ref _started, 1) != 0) return;
        _loop = Task.Run(RunAsync);
    }

    public void Post(EventRecord e)
    {
        if (_sinks.Count > 0) _queue.Writer.TryWrite(e);
    }

    public void Post(Alarm a)
    {
        if (_sinks.Count > 0) _queue.Writer.TryWrite(a);
    }

    private async Task RunAsync()
    {
        try
        {
            await foreach (var item in _queue.Reader.ReadAllAsync(_cts.Token))
            {
                foreach (var sink in _sinks)
                {
                    try
                    {
                        if (item is EventRecord e) sink.OnEvent(e);
                        else if (item is Alarm a) sink.OnAlarm(a);
                    }
                    catch (Exception ex)
                    {
                        _log.LogError(ex, "Event sink {Sink} failed", sink.GetType().Name);
                    }
                }
            }
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested)
        {
            // shutdown
        }
    }

    /// <summary>Stop accepting items and drain what is queued (bounded by a timeout).</summary>
    public async Task StopAsync()
    {
        if (Interlocked.Exchange(ref _stopped, 1) != 0) return;
        _queue.Writer.TryComplete();
        try
        {
            await _loop.WaitAsync(StopTimeout);
        }
        catch (TimeoutException)
        {
            _log.LogWarning("Event sinks did not drain within {Timeout}", StopTimeout);
        }
        _cts.Cancel();
    }

    /// <summary>Same as <see cref="StopAsync"/>; the CTS is left to the GC so a late stop never hits a disposed token.</summary>
    public async ValueTask DisposeAsync() => await StopAsync();
}
