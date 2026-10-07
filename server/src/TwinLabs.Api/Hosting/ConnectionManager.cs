using TwinLabs.Connect;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Owns one <see cref="ITagSource"/> per <see cref="ConnectionDef"/> of the live plant.
/// <list type="bullet">
/// <item>On start and on every <see cref="SimulationHost.PlantChanged"/>: stops the old sources, validates the plant
/// (<see cref="BindingResolver.Validate"/>), and creates and starts a source for every valid connection through the
/// <see cref="ITagSourceFactory"/> of its kind. Invalid connections are reported with status <c>error</c> and not started.</item>
/// <item>Source <c>Updates</c> are resolved (scale, offset, stateMap) here, on the source's thread, and handed to the
/// host's lock-free queue, which the sim loop drains under its lock. The engine is never touched from here.</item>
/// <item>Status changes are broadcast as WS <c>connection</c> frames via the host.</item>
/// </list>
/// Threading: start/stop/reconnect are serialised on <see cref="_ops"/>. <see cref="_gate"/> only guards the entry
/// table and is never held while calling the host or a source, so it cannot deadlock with the host lock.
/// </summary>
public sealed class ConnectionManager : IAsyncDisposable
{
    private readonly SimulationHost _host;
    private readonly IReadOnlyList<ITagSourceFactory> _factories;
    private readonly ILogger<ConnectionManager> _log;
    private readonly SemaphoreSlim _ops = new(1, 1);
    private readonly Lock _gate = new();
    private readonly CancellationTokenSource _cts = new();

    private List<Entry> _entries = [];
    private ConnectionStatus[] _statuses = [];
    private BindingResolver _resolver = new(new PlantModel("", "", 0, 0, [], []));
    private Task _last = Task.CompletedTask;
    private bool _stopped;

    private sealed class Entry(ConnectionDef def, IReadOnlyList<BindingDef> bindings, string? invalid)
    {
        public ConnectionDef Def { get; } = def;
        public IReadOnlyList<BindingDef> Bindings { get; } = bindings;
        public string? Invalid { get; } = invalid;
        public ITagSource? Source;
        public Action<ConnectionStatus>? OnStatus;
        public Action<IReadOnlyList<TagUpdate>>? OnUpdates;
        public ConnectionStatus Status = new(def.Id, def.Kind, def.Endpoint, ConnectionState.Disabled, 0);
    }

    public ConnectionManager(SimulationHost host, IEnumerable<ITagSourceFactory> factories, ILogger<ConnectionManager> log)
    {
        _host = host;
        _factories = [.. factories];
        _log = log;
        _host.PlantChanged += OnPlantChanged;
    }

    /// <summary>Current status of every connection of the live plant, in plant order. Lock-free.</summary>
    public IReadOnlyList<ConnectionStatus> Statuses => Volatile.Read(ref _statuses);

    /// <summary>Completes when every start/stop/reconnect queued so far has finished (tests, shutdown).</summary>
    public Task Idle { get { lock (_gate) return _last; } }

    /// <summary>Start the sources of <paramref name="plant"/>. Runs in the background; await it (or <see cref="Idle"/>) to wait.</summary>
    public Task StartAsync(PlantModel plant) => Enqueue(() => ApplyPlantAsync(plant));

    private void OnPlantChanged(PlantModel plant) => _ = StartAsync(plant);

    /// <summary>Stop and start one source. Throws <see cref="KeyNotFoundException"/> for an unknown id.</summary>
    public async Task<ConnectionStatus> ReconnectAsync(string id)
    {
        ConnectionStatus? result = null;
        await Enqueue(async () =>
        {
            Entry entry;
            lock (_gate) entry = _entries.FirstOrDefault(e => e.Def.Id == id) ?? throw TwinErrors.UnknownConnection(id);
            if (entry.Invalid is null)
            {
                _log.LogInformation("Reconnecting {Id}", id);
                await StopEntryAsync(entry);
                await StartEntryAsync(entry);
            }
            lock (_gate) result = entry.Status;
        }, rethrow: true);
        return result ?? throw new InvalidOperationException("The connection manager is stopped.");
    }

    public async Task StopAsync()
    {
        lock (_gate)
        {
            if (_stopped) return;
            _stopped = true;
        }
        _host.PlantChanged -= OnPlantChanged;
        _cts.Cancel();
        await Enqueue(StopAllAsync, ignoreStopped: true);
    }

    public async ValueTask DisposeAsync() => await StopAsync();

    // ------------------------------------------------------------------ internals

    private Task Enqueue(Func<Task> op, bool rethrow = false, bool ignoreStopped = false)
    {
        Task t;
        lock (_gate)
        {
            t = _last = Run(op, rethrow, ignoreStopped);
        }
        return t;
    }

    private async Task Run(Func<Task> op, bool rethrow, bool ignoreStopped)
    {
        await _ops.WaitAsync();
        try
        {
            if (!ignoreStopped && Volatile.Read(ref _stopped)) return;
            await op();
        }
        catch (Exception ex) when (!rethrow)
        {
            _log.LogError(ex, "Connection manager operation failed");
        }
        finally
        {
            _ops.Release();
        }
    }

    private async Task ApplyPlantAsync(PlantModel plant)
    {
        await StopAllAsync();

        foreach (var e in BindingResolver.Validate(plant))
            _log.LogWarning("Plant '{Plant}': {Error}", plant.Id, e);

        var connections = plant.Connections ?? [];
        var bindings = plant.Bindings ?? [];
        var resolver = new BindingResolver(plant);
        var dupes = connections.GroupBy(c => c.Id, StringComparer.Ordinal).Where(g => g.Count() > 1).Select(g => g.Key).ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var entries = new List<Entry>();
        foreach (var c in connections)
        {
            if (!seen.Add(c.Id)) continue; // the first definition of a duplicate id carries the error
            var own = bindings.Where(b => b.ConnectionId == c.Id).ToList();
            var errors = dupes.Contains(c.Id)
                ? [$"Duplicate connection id '{c.Id}'"]
                : BindingResolver.Validate(plant with { Connections = [c], Bindings = own });
            entries.Add(new Entry(c, resolver.BindingsFor(c.Id), errors.Count == 0 ? null : string.Join("; ", errors)));
        }

        lock (_gate)
        {
            _entries = entries;
            Volatile.Write(ref _resolver, resolver);
            Volatile.Write(ref _statuses, [.. entries.Select(e => e.Status)]);
        }

        foreach (var entry in entries)
        {
            if (entry.Invalid is { } why)
            {
                _log.LogWarning("Connection {Id} not started: {Errors}", entry.Def.Id, why);
                SetStatus(entry, entry.Status with { Status = ConnectionState.Error, Error = why });
                continue;
            }
            await StartEntryAsync(entry);
        }
    }

    private async Task StartEntryAsync(Entry entry)
    {
        var def = entry.Def;
        var factory = _factories.LastOrDefault(f => f.Kind == def.Kind);
        if (factory is null)
        {
            SetStatus(entry, entry.Status with { Status = ConnectionState.Error, Error = $"No tag source registered for kind '{def.Kind.ToString().ToLowerInvariant()}'" });
            return;
        }

        ITagSource source;
        try
        {
            source = factory.Create(def);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Connection {Id}: creating the {Kind} source failed", def.Id, def.Kind);
            SetStatus(entry, entry.Status with { Status = ConnectionState.Error, Error = ex.Message });
            return;
        }

        entry.OnStatus = s =>
        {
            if (ReferenceEquals(Volatile.Read(ref entry.Source), source)) SetStatus(entry, s with { Id = def.Id });
        };
        entry.OnUpdates = updates =>
        {
            if (ReferenceEquals(Volatile.Read(ref entry.Source), source)) Forward(def.Id, updates);
        };
        Volatile.Write(ref entry.Source, source);
        source.StatusChanged += entry.OnStatus;
        source.Updates += entry.OnUpdates;

        try
        {
            SetStatus(entry, source.Status with { Id = def.Id });
            await source.StartAsync(entry.Bindings, _cts.Token);
            SetStatus(entry, source.Status with { Id = def.Id });
            _log.LogInformation("Connection {Id} ({Kind} {Endpoint}) started with {Count} bindings", def.Id, def.Kind, def.Endpoint, entry.Bindings.Count);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Connection {Id}: StartAsync failed", def.Id);
            SetStatus(entry, entry.Status with { Status = ConnectionState.Error, Error = ex.Message });
        }
    }

    private async Task StopEntryAsync(Entry entry)
    {
        var source = Interlocked.Exchange(ref entry.Source, null);
        if (source is null) return;
        if (entry.OnStatus is not null) source.StatusChanged -= entry.OnStatus;
        if (entry.OnUpdates is not null) source.Updates -= entry.OnUpdates;
        try
        {
            await source.StopAsync();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Connection {Id}: StopAsync failed", entry.Def.Id);
        }
        try
        {
            await source.DisposeAsync();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Connection {Id}: dispose failed", entry.Def.Id);
        }
    }

    private async Task StopAllAsync()
    {
        List<Entry> entries;
        lock (_gate) entries = _entries;
        foreach (var e in entries) await StopEntryAsync(e);
    }

    private void Forward(string connectionId, IReadOnlyList<TagUpdate> updates)
    {
        var resolver = Volatile.Read(ref _resolver);
        List<ResolvedUpdate>? resolved = null;
        foreach (var u in updates)
        {
            var r = resolver.Resolve(u.ConnectionId == connectionId ? u : u with { ConnectionId = connectionId });
            if (r.Count == 0) continue;
            (resolved ??= new List<ResolvedUpdate>(updates.Count)).AddRange(r);
        }
        if (resolved is not null) _host.EnqueueTagUpdates(connectionId, resolved);
    }

    private void SetStatus(Entry entry, ConnectionStatus status)
    {
        bool stateChanged;
        lock (_gate)
        {
            stateChanged = entry.Status.Status != status.Status;
            if (entry.Status == status) return;
            entry.Status = status;
            if (!_entries.Contains(entry)) return;
            Volatile.Write(ref _statuses, [.. _entries.Select(e => e.Status)]);
        }
        _host.PublishConnection(status, stateChanged);
    }
}
