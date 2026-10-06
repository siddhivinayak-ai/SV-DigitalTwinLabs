using System.Net.WebSockets;
using System.Threading.Channels;

namespace TwinLabs.Api.Realtime;

/// <summary>
/// Bounded per-client send queue. <see cref="Enqueue"/> never blocks: when the queue is at
/// <see cref="Capacity"/> the oldest queued <c>tick</c> is evicted (or the incoming tick is dropped if none is
/// queued). Non-droppable frames (snapshot, event, alarm, kpi, params, ack) are never dropped; if a client is so
/// slow that they pile up past <see cref="HardLimit"/>, the client is closed instead.
/// </summary>
public sealed class ClientOutbox
{
    public const int DefaultCapacity = 256;

    private readonly Lock _gate = new();
    private readonly LinkedList<Frame> _queue = new();
    // Capacity-1 "doorbell": the sender waits on it, enqueuers ring it. Collapses many wake-ups into one.
    private readonly Channel<bool> _doorbell = Channel.CreateBounded<bool>(
        new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });
    private bool _completed;

    public ClientOutbox(int capacity = DefaultCapacity)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 2);
        Capacity = capacity;
        HardLimit = capacity * 4;
    }

    public int Capacity { get; }
    public int HardLimit { get; }
    public long DroppedTicks { get; private set; }
    public WebSocketCloseStatus? CloseStatus { get; private set; }
    public string? CloseReason { get; private set; }

    public int Count { get { lock (_gate) return _queue.Count; } }

    /// <returns>false once the outbox is completed (the client is going away).</returns>
    public bool Enqueue(Frame frame)
    {
        lock (_gate)
        {
            if (_completed) return false;
            if (_queue.Count >= Capacity && !EvictOldestTick())
            {
                if (frame.Droppable) { DroppedTicks++; return true; }
                if (_queue.Count >= HardLimit)
                {
                    CompleteLocked(WebSocketCloseStatus.PolicyViolation, "Client too slow");
                    return false;
                }
            }
            _queue.AddLast(frame);
        }
        _doorbell.Writer.TryWrite(true);
        return true;
    }

    private bool EvictOldestTick()
    {
        for (var node = _queue.First; node is not null; node = node.Next)
        {
            if (!node.Value.Droppable) continue;
            _queue.Remove(node);
            DroppedTicks++;
            return true;
        }
        return false;
    }

    public bool TryDequeue(out Frame frame)
    {
        lock (_gate)
        {
            if (_queue.First is { } first)
            {
                _queue.RemoveFirst();
                frame = first.Value;
                return true;
            }
        }
        frame = null!;
        return false;
    }

    /// <summary>Wait until there may be frames to send. Returns false when completed and fully drained.</summary>
    public async ValueTask<bool> WaitToReadAsync(CancellationToken ct)
    {
        while (true)
        {
            lock (_gate)
            {
                if (_queue.Count > 0) return true;
                if (_completed) return false;
            }
            if (!await _doorbell.Reader.WaitToReadAsync(ct)) return Count > 0;
            _doorbell.Reader.TryRead(out _);
        }
    }

    /// <summary>No more frames will be accepted; the sender drains what is queued, then closes with <paramref name="status"/>.</summary>
    public void Complete(WebSocketCloseStatus status = WebSocketCloseStatus.NormalClosure, string? reason = null)
    {
        lock (_gate) CompleteLocked(status, reason);
    }

    private void CompleteLocked(WebSocketCloseStatus status, string? reason)
    {
        if (_completed) return;
        _completed = true;
        CloseStatus = status;
        CloseReason = reason;
        _doorbell.Writer.TryComplete();
    }
}
