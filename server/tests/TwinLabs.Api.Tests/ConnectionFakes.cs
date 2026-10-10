using System.Collections.Concurrent;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

/// <summary>A tag source the test drives: push values, flip the status.</summary>
public sealed class FakeTagSource(ConnectionDef def) : ITagSource
{
    public ConnectionDef Definition { get; } = def;
    public ConnectionStatus Status { get; private set; } = new(def.Id, def.Kind, def.Endpoint, ConnectionState.Disabled, 0);
    public event Action<ConnectionStatus>? StatusChanged;
    public event Action<IReadOnlyList<TagUpdate>>? Updates;

    public IReadOnlyList<BindingDef> Bindings { get; private set; } = [];
    public int StartCount { get; private set; }
    public int StopCount { get; private set; }
    public bool Disposed { get; private set; }

    public static long NowMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public Task StartAsync(IReadOnlyList<BindingDef> bindings, CancellationToken ct)
    {
        Bindings = bindings;
        StartCount++;
        SetStatus(ConnectionState.Connected);
        return Task.CompletedTask;
    }

    public Task StopAsync()
    {
        StopCount++;
        Status = Status with { Status = ConnectionState.Disabled };
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }

    public void Push(string address, double value, long? wallMs = null) =>
        Updates?.Invoke([new TagUpdate(Definition.Id, address, value, wallMs ?? NowMs)]);

    public void SetStatus(ConnectionState state, string? error = null)
    {
        Status = Status with { Status = state, BoundTags = Bindings.Count, Error = error, LastValueMs = state == ConnectionState.Connected ? 0 : null };
        StatusChanged?.Invoke(Status);
    }
}

public sealed class FakeTagSourceFactory(ConnectionKind kind) : ITagSourceFactory
{
    public ConnectionKind Kind { get; } = kind;
    public ConcurrentQueue<FakeTagSource> Created { get; } = new();
    public FakeTagSource Last => Created.Last();
    /// <summary>Set to make Create throw (like the v0.2 stubs).</summary>
    public bool Throw { get; set; }

    public ITagSource Create(ConnectionDef definition)
    {
        if (Throw) throw new NotImplementedException("fake factory: not implemented");
        var s = new FakeTagSource(definition);
        Created.Enqueue(s);
        return s;
    }
}

public sealed class FakePublisher(string name, bool enabled = true) : ITwinPublisher
{
    public string Name { get; } = name;
    public bool Enabled { get; } = enabled;
    public ConcurrentQueue<long> Published { get; } = new();
    public ConcurrentQueue<PlantModel> Started { get; } = new();
    public int StopCount;
    /// <summary>Runs inside Publish (block, throw...).</summary>
    public Action<long>? OnPublish { get; set; }
    public IReadOnlyList<SensorValue>? LastSensors { get; private set; }

    public Task StartAsync(PlantModel plant, CancellationToken ct)
    {
        Started.Enqueue(plant);
        return Task.CompletedTask;
    }

    public void Publish(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors)
    {
        Published.Enqueue(simTimeMs);
        LastSensors = sensors;
        OnPublish?.Invoke(simTimeMs);
    }

    public Task StopAsync()
    {
        Interlocked.Increment(ref StopCount);
        return Task.CompletedTask;
    }
}

public sealed class FakeSink : IHostEventSink
{
    public ConcurrentQueue<EventRecord> Events { get; } = new();
    public ConcurrentQueue<Alarm> Alarms { get; } = new();
    public int ThreadId = -1;

    public void OnEvent(EventRecord e)
    {
        ThreadId = Environment.CurrentManagedThreadId;
        Events.Enqueue(e);
    }

    public void OnAlarm(Alarm a) => Alarms.Enqueue(a);
}

public static class Eventually
{
    public static async Task True(Func<bool> condition, string because, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (!condition())
        {
            if (Environment.TickCount64 > deadline) Assert.Fail($"Timed out waiting: {because}");
            await Task.Delay(10);
        }
    }
}
