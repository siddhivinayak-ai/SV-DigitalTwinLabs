using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence;

/// <summary>In-memory history (used when <c>Twin:Data:Enabled</c> is false, and in tests). Same semantics as SQLite: row ids, newest first, retention.</summary>
public sealed class InMemoryHistoryStore(int retention = TwinDataOptions.DefaultHistoryRetention) : IHistoryStore
{
    private readonly object _lock = new();
    private readonly LinkedList<EventRecord> _events = new();
    private readonly LinkedList<Alarm> _alarms = new();
    private long _nextId;

    public void OnEvent(EventRecord e)
    {
        if (e is null) return;
        lock (_lock)
        {
            _events.AddLast(e with { Id = ++_nextId });
            if (_events.Count > retention) _events.RemoveFirst();
        }
    }

    public void OnAlarm(Alarm a)
    {
        if (a is null) return;
        lock (_lock)
        {
            _alarms.AddLast(a);
            if (_alarms.Count > retention) _alarms.RemoveFirst();
        }
    }

    public IReadOnlyList<EventRecord> Events(int limit, long? beforeId = null)
    {
        StoreHelpers.ValidLimit(limit);
        lock (_lock)
        {
            var list = new List<EventRecord>(Math.Min(limit, _events.Count));
            for (var n = _events.Last; n is not null && list.Count < limit; n = n.Previous)
                if (beforeId is null || n.Value.Id < beforeId) list.Add(n.Value);
            return list;
        }
    }

    public IReadOnlyList<Alarm> Alarms(int limit)
    {
        StoreHelpers.ValidLimit(limit);
        lock (_lock) return _alarms.Reverse().Take(limit).ToList();
    }
}

/// <summary>In-memory scenarios. Values are round-tripped through <see cref="TwinJson"/> so behaviour matches SQLite.</summary>
public sealed class InMemoryScenarioStore(TimeProvider? time = null) : IScenarioStore
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly object _lock = new();
    private readonly List<Scenario> _items = new(); // insertion order

    public IReadOnlyList<ScenarioSummary> List()
    {
        lock (_lock)
            return _items.AsEnumerable().Reverse()
                .OrderByDescending(s => s.CreatedAtUtc, StringComparer.Ordinal)
                .Select(s => new ScenarioSummary(s.Id, s.Name, s.CreatedAtUtc, s.Request.DurationS, s.Request.Overrides.Count))
                .ToList();
    }

    public Scenario? Get(string id)
    {
        lock (_lock) return _items.FirstOrDefault(s => s.Id == id);
    }

    public Scenario Save(SaveScenarioRequest request)
    {
        var (name, req) = StoreHelpers.Validate(request);
        lock (_lock)
        {
            var id = UniqueId(_items.Select(s => s.Id));
            var s = new Scenario(id, name, StoreHelpers.IsoNow(_time), Clone(req), request.Result is null ? null : Clone(request.Result));
            _items.Add(s);
            return s;
        }
    }

    public bool Delete(string id)
    {
        lock (_lock) return _items.RemoveAll(s => s.Id == id) > 0;
    }

    internal static T Clone<T>(T value) => TwinJson.Deserialize<T>(TwinJson.Serialize(value));

    internal static string UniqueId(IEnumerable<string> existing)
    {
        var set = existing.ToHashSet();
        string id;
        do id = StoreHelpers.NewId(); while (set.Contains(id));
        return id;
    }
}

public sealed class InMemoryLayoutStore(TimeProvider? time = null) : ILayoutStore
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly object _lock = new();
    private readonly List<Layout> _items = new();

    public IReadOnlyList<LayoutSummary> List()
    {
        lock (_lock)
            return _items.AsEnumerable().Reverse()
                .OrderByDescending(l => l.UpdatedAtUtc, StringComparer.Ordinal)
                .Select(l => new LayoutSummary(l.Id, l.Name, l.UpdatedAtUtc, StoreHelpers.AssetCount(l.Plant)))
                .ToList();
    }

    public Layout? Get(string id)
    {
        lock (_lock) return _items.FirstOrDefault(l => l.Id == id);
    }

    public Layout Save(SaveLayoutRequest request)
    {
        var (name, plant) = StoreHelpers.Validate(request);
        lock (_lock)
        {
            var l = new Layout(InMemoryScenarioStore.UniqueId(_items.Select(x => x.Id)), name, StoreHelpers.IsoNow(_time),
                InMemoryScenarioStore.Clone(plant));
            _items.Add(l);
            return l;
        }
    }

    public Layout? Update(string id, SaveLayoutRequest request)
    {
        var (name, plant) = StoreHelpers.Validate(request);
        lock (_lock)
        {
            var i = _items.FindIndex(l => l.Id == id);
            if (i < 0) return null;
            var l = new Layout(id, name, StoreHelpers.IsoNow(_time), InMemoryScenarioStore.Clone(plant));
            _items.RemoveAt(i);
            _items.Add(l); // keep the list in update order so ties on updatedAtUtc list the latest first
            return l;
        }
    }

    public bool Delete(string id)
    {
        lock (_lock) return _items.RemoveAll(l => l.Id == id) > 0;
    }
}

/// <summary>In-memory meshes; same sniffing and size limit as <see cref="FileMeshStore"/>.</summary>
public sealed class InMemoryMeshStore(long maxBytes = TwinDataOptions.MaxMeshBytes) : IMeshStore
{
    private sealed record Entry(MeshInfo Info, string ContentType, byte[] Data);

    private readonly object _lock = new();
    private readonly List<Entry> _items = new();

    public long MaxBytes { get; } = maxBytes;

    public IReadOnlyList<MeshInfo> List()
    {
        lock (_lock) return _items.AsEnumerable().Reverse().Select(e => e.Info).ToList();
    }

    public async Task<MeshInfo> SaveAsync(string name, Stream data, CancellationToken ct)
    {
        var n = StoreHelpers.ValidName(name);
        ArgumentNullException.ThrowIfNull(data);
        using var ms = new MemoryStream();
        var (format, size) = await MeshUpload.CopyAsync(data, ms, MaxBytes, ct).ConfigureAwait(false);
        lock (_lock)
        {
            var id = InMemoryScenarioStore.UniqueId(_items.Select(e => e.Info.Id));
            var info = new MeshInfo(id, n, StoreHelpers.MeshUrl(id), size);
            _items.Add(new Entry(info, MeshUpload.ContentType(format), ms.ToArray()));
            return info;
        }
    }

    public (Stream Stream, string ContentType)? Open(string id)
    {
        lock (_lock)
        {
            var e = _items.FirstOrDefault(x => x.Info.Id == id);
            return e is null ? null : (new MemoryStream(e.Data, writable: false), e.ContentType);
        }
    }

    public bool Delete(string id)
    {
        lock (_lock) return _items.RemoveAll(e => e.Info.Id == id) > 0;
    }
}
