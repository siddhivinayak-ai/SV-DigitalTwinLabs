using System.Diagnostics;
using System.Threading.Channels;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence;

/// <summary>
/// Event and alarm history in SQLite. <see cref="OnEvent"/>/<see cref="OnAlarm"/> only enqueue into a bounded channel
/// (drop-oldest, counted in <see cref="Dropped"/>) and return immediately; a background writer batch-inserts every
/// 250 ms or 200 rows and prunes each table to the newest <c>retention</c> rows.
/// <para>Returned <see cref="EventRecord.Id"/> values are the history row ids (monotonic across sim resets), so they
/// can be passed back as <c>beforeId</c>. The engine's own event id is kept in the <c>event_id</c> column.</para>
/// </summary>
public sealed class SqliteHistoryStore : IHistoryStore, IAsyncDisposable, IDisposable
{
    public const int BatchSize = 200;
    public static readonly TimeSpan BatchInterval = TimeSpan.FromMilliseconds(250);
    public const int DefaultCapacity = 10_000;
    private static readonly TimeSpan PruneInterval = TimeSpan.FromSeconds(30);
    private const int PruneEveryRows = 5_000;

    private sealed record Item(EventRecord? Event, Alarm? Alarm, string RecordedUtc, TaskCompletionSource? Flush = null);

    private readonly SqliteDatabase _db;
    private readonly int _retention;
    private readonly TimeProvider _time;
    private readonly ILogger _log;
    private readonly Channel<Item> _channel;
    private readonly Dictionary<string, Alarm> _lastAlarm = new(); // writer thread only
    private readonly object _startLock = new();
    private Task? _writer;
    private long _dropped;
    private long _batches;
    private long _rowsSincePrune;
    private long _lastPruneTicks = Stopwatch.GetTimestamp();

    public SqliteHistoryStore(SqliteDatabase db, int retention = TwinDataOptions.DefaultHistoryRetention,
        int capacity = DefaultCapacity, TimeProvider? time = null, ILogger<SqliteHistoryStore>? logger = null)
        : this(db, retention, capacity, time, logger, startWriter: true) { }

    internal SqliteHistoryStore(SqliteDatabase db, int retention, int capacity, TimeProvider? time, ILogger? logger, bool startWriter)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(retention, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        _db = db;
        _retention = retention;
        _time = time ?? TimeProvider.System;
        _log = logger ?? NullLogger.Instance;
        _channel = Channel.CreateBounded<Item>(
            new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true },
            OnDropped);
        if (startWriter) Start();
    }

    /// <summary>Items discarded because the queue was full (oldest first).</summary>
    public long Dropped => Interlocked.Read(ref _dropped);

    /// <summary>Insert transactions committed so far.</summary>
    public long BatchesWritten => Interlocked.Read(ref _batches);

    public void OnEvent(EventRecord e)
    {
        if (e is not null) _channel.Writer.TryWrite(new Item(e, null, StoreHelpers.IsoNow(_time)));
    }

    public void OnAlarm(Alarm a)
    {
        if (a is not null) _channel.Writer.TryWrite(new Item(null, a, StoreHelpers.IsoNow(_time)));
    }

    /// <summary>Completes once everything enqueued before this call has been written (or dropped).</summary>
    public Task FlushAsync(CancellationToken ct = default)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_channel.Writer.TryWrite(new Item(null, null, "", tcs))) tcs.TrySetResult(); // completed: writer drains on stop
        return tcs.Task.WaitAsync(ct);
    }

    public IReadOnlyList<EventRecord> Events(int limit, long? beforeId = null)
    {
        StoreHelpers.ValidLimit(limit);
        using var c = _db.OpenIfExists();
        if (c is null) return [];
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, json FROM events WHERE ($before IS NULL OR id < $before) ORDER BY id DESC LIMIT $limit;";
        cmd.Parameters.AddWithValue("$before", (object?)beforeId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$limit", limit);
        using var r = cmd.ExecuteReader();
        var list = new List<EventRecord>();
        while (r.Read()) list.Add(TwinJson.Deserialize<EventRecord>(r.GetString(1)) with { Id = r.GetInt64(0) });
        return list;
    }

    public IReadOnlyList<Alarm> Alarms(int limit)
    {
        StoreHelpers.ValidLimit(limit);
        using var c = _db.OpenIfExists();
        if (c is null) return [];
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT json FROM alarms ORDER BY id DESC LIMIT $limit;";
        cmd.Parameters.AddWithValue("$limit", limit);
        using var r = cmd.ExecuteReader();
        var list = new List<Alarm>();
        while (r.Read()) list.Add(TwinJson.Deserialize<Alarm>(r.GetString(0)));
        return list;
    }

    /// <summary>Deletes all but the newest <c>retention</c> rows of each table. Runs automatically; public for tests/ops.</summary>
    public void PruneNow()
    {
        using var c = _db.OpenIfExists();
        if (c is not null) Prune(c);
    }

    internal void Start()
    {
        lock (_startLock) _writer ??= Task.Run(WriterLoopAsync);
    }

    /// <summary>Stops accepting items, writes everything still queued and waits for the writer.</summary>
    public async Task StopAsync(CancellationToken ct = default)
    {
        _channel.Writer.TryComplete();
        Task? writer;
        lock (_startLock) writer = _writer;
        if (writer is not null) await writer.WaitAsync(ct).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        try { await StopAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token).ConfigureAwait(false); }
        catch (OperationCanceledException) { _log.LogWarning("History writer did not stop within 10 s"); }
    }

    public void Dispose() => DisposeAsync().AsTask().GetAwaiter().GetResult();

    private void OnDropped(Item item)
    {
        if (item.Flush is not null) item.Flush.TrySetResult();
        else Interlocked.Increment(ref _dropped);
    }

    private async Task WriterLoopAsync()
    {
        var reader = _channel.Reader;
        var batch = new List<Item>(BatchSize);
        var flushes = new List<TaskCompletionSource>();
        while (await reader.WaitToReadAsync().ConfigureAwait(false))
        {
            var deadline = Stopwatch.GetTimestamp() + (long)(BatchInterval.TotalSeconds * Stopwatch.Frequency);
            while (true)
            {
                while (batch.Count < BatchSize && flushes.Count == 0 && reader.TryRead(out var item))
                {
                    if (item.Flush is not null) flushes.Add(item.Flush);
                    else batch.Add(item);
                }
                if (batch.Count >= BatchSize || flushes.Count > 0) break;
                var remaining = Stopwatch.GetElapsedTime(Stopwatch.GetTimestamp(), deadline);
                if (remaining <= TimeSpan.Zero) break;
                using var timeout = new CancellationTokenSource(remaining);
                try
                {
                    if (!await reader.WaitToReadAsync(timeout.Token).ConfigureAwait(false)) break; // completed
                }
                catch (OperationCanceledException)
                {
                    break; // interval elapsed
                }
            }
            WriteBatch(batch);
            batch.Clear();
            foreach (var f in flushes) f.TrySetResult();
            flushes.Clear();
        }
    }

    private void WriteBatch(List<Item> batch)
    {
        if (batch.Count == 0) return;
        try
        {
            using var c = _db.Open();
            using (var tx = c.BeginTransaction())
            {
                using var ev = c.CreateCommand();
                ev.Transaction = tx;
                ev.CommandText = """
                    INSERT INTO events (event_id, time_ms, kind, severity, asset_id, recorded_utc, json)
                    VALUES ($eid, $t, $kind, $sev, $asset, $rec, $json);
                    """;
                var evParams = AddParams(ev, "$eid", "$t", "$kind", "$sev", "$asset", "$rec", "$json");

                using var al = c.CreateCommand();
                al.Transaction = tx;
                al.CommandText = """
                    INSERT INTO alarms (alarm_id, change, severity, asset_id, active, acknowledged, raised_at_ms, cleared_at_ms, recorded_utc, json)
                    VALUES ($aid, $change, $sev, $asset, $active, $ack, $raised, $cleared, $rec, $json);
                    """;
                var alParams = AddParams(al, "$aid", "$change", "$sev", "$asset", "$active", "$ack", "$raised", "$cleared", "$rec", "$json");

                foreach (var item in batch)
                {
                    if (item.Event is { } e)
                    {
                        Set(evParams, e.Id, e.TimeMs, StoreHelpers.EnumText(e.Kind), StoreHelpers.EnumText(e.Severity),
                            e.AssetId, item.RecordedUtc, TwinJson.Serialize(e));
                        ev.ExecuteNonQuery();
                    }
                    else if (item.Alarm is { } a)
                    {
                        Set(alParams, a.Id, ClassifyAlarm(a), StoreHelpers.EnumText(a.Severity), a.AssetId,
                            a.Active ? 1 : 0, a.Acknowledged ? 1 : 0, a.RaisedAtMs, a.ClearedAtMs, item.RecordedUtc,
                            TwinJson.Serialize(a));
                        al.ExecuteNonQuery();
                    }
                }
                tx.Commit();
            }
            Interlocked.Increment(ref _batches);

            _rowsSincePrune += batch.Count;
            if (_rowsSincePrune >= PruneEveryRows || Stopwatch.GetElapsedTime(_lastPruneTicks) >= PruneInterval)
            {
                Prune(c);
                _rowsSincePrune = 0;
                _lastPruneTicks = Stopwatch.GetTimestamp();
            }
        }
        catch (Exception ex)
        {
            // Never let the writer die: losing one batch beats losing all future history.
            _log.LogError(ex, "Failed to write {Count} history rows", batch.Count);
        }
    }

    /// <summary>raise / escalate / ack / clear, from the previous row of the same alarm id.</summary>
    private string ClassifyAlarm(Alarm a)
    {
        _lastAlarm.TryGetValue(a.Id, out var prev);
        string change;
        if (!a.Active) change = "clear";
        else if (prev is null || !prev.Active || prev.RaisedAtMs != a.RaisedAtMs) change = "raise";
        else if (a.Acknowledged && !prev.Acknowledged) change = "ack";
        else change = "escalate";

        if (a.Active) _lastAlarm[a.Id] = a;
        else _lastAlarm.Remove(a.Id);
        return change;
    }

    private void Prune(SqliteConnection c)
    {
        foreach (var table in new[] { "events", "alarms" })
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = $"DELETE FROM {table} WHERE id <= (SELECT id FROM {table} ORDER BY id DESC LIMIT 1 OFFSET $keep);";
            cmd.Parameters.AddWithValue("$keep", _retention);
            var n = cmd.ExecuteNonQuery();
            if (n > 0) _log.LogDebug("Pruned {Count} rows from {Table}", n, table);
        }
    }

    private static SqliteParameter[] AddParams(SqliteCommand cmd, params string[] names) =>
        names.Select(n => cmd.Parameters.Add(new SqliteParameter { ParameterName = n })).ToArray();

    private static void Set(SqliteParameter[] ps, params object?[] values)
    {
        for (var i = 0; i < ps.Length; i++) ps[i].Value = values[i] ?? DBNull.Value;
    }
}
