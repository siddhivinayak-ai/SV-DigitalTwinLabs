using System.Diagnostics;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence.Tests;

public sealed class HistoryStoreTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task Events_are_batched_and_returned_newest_first()
    {
        await using var store = new SqliteHistoryStore(_dir.NewDatabase());
        for (var i = 1; i <= 450; i++) store.OnEvent(Samples.Event(i));
        await store.FlushAsync();

        var events = store.Events(1000);
        Assert.Equal(450, events.Count);
        Assert.Equal("event 450", events[0].Message);
        Assert.Equal("event 1", events[^1].Message);
        Assert.True(events.Zip(events.Skip(1)).All(p => p.First.Id > p.Second.Id), "ids strictly descending");
        Assert.InRange(store.BatchesWritten, 3, 10); // 200-row batches, not one insert per event
        Assert.Equal(0, store.Dropped);
    }

    [Fact]
    public async Task Partial_batch_is_written_after_the_interval_without_a_flush()
    {
        await using var store = new SqliteHistoryStore(_dir.NewDatabase());
        store.OnEvent(Samples.Event(1));
        store.OnEvent(Samples.Event(2));

        var sw = Stopwatch.StartNew();
        while (store.Events(10).Count < 2 && sw.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(25);
        Assert.Equal(2, store.Events(10).Count);
        Assert.Equal(1, store.BatchesWritten);
    }

    [Fact]
    public async Task Event_fields_round_trip_and_ids_are_history_row_ids()
    {
        var example = Examples.Data<EventRecord>("event.json");
        await using var store = new SqliteHistoryStore(_dir.NewDatabase());
        store.OnEvent(example);
        store.OnEvent(example); // same engine id twice (e.g. after a sim reset): rows stay distinct
        await store.FlushAsync();

        var events = store.Events(10);
        Assert.Equal(2, events.Count);
        Assert.NotEqual(events[0].Id, events[1].Id);
        Assert.Equal(example with { Id = events[1].Id }, events[1]);
    }

    [Fact]
    public async Task BeforeId_pages_through_all_events_without_overlap()
    {
        await using var store = new SqliteHistoryStore(_dir.NewDatabase());
        for (var i = 1; i <= 50; i++) store.OnEvent(Samples.Event(i));
        await store.FlushAsync();

        var seen = new List<string>();
        long? before = null;
        while (true)
        {
            var page = store.Events(20, before);
            if (page.Count == 0) break;
            Assert.All(page, e => Assert.True(before is null || e.Id < before));
            seen.AddRange(page.Select(e => e.Message));
            before = page[^1].Id;
        }
        Assert.Equal(Enumerable.Range(1, 50).Reverse().Select(i => $"event {i}"), seen);
    }

    [Fact]
    public async Task Pruning_keeps_only_the_newest_rows()
    {
        await using var store = new SqliteHistoryStore(_dir.NewDatabase(), retention: 100);
        for (var i = 1; i <= 250; i++)
        {
            store.OnEvent(Samples.Event(i));
            store.OnAlarm(Samples.Alarm($"ALM-{i}"));
        }
        await store.FlushAsync();
        store.PruneNow();

        var events = store.Events(1000);
        Assert.Equal(100, events.Count);
        Assert.Equal("event 250", events[0].Message);
        Assert.Equal("event 151", events[^1].Message);
        var alarms = store.Alarms(1000);
        Assert.Equal(100, alarms.Count);
        Assert.Equal("ALM-250", alarms[0].Id);
    }

    [Fact]
    public async Task Each_alarm_change_is_one_row_classified_raise_escalate_ack_clear()
    {
        var db = _dir.NewDatabase();
        await using var store = new SqliteHistoryStore(db);
        store.OnAlarm(Samples.Alarm(sev: Severity.Warning));
        store.OnAlarm(Samples.Alarm(sev: Severity.Critical));
        store.OnAlarm(Samples.Alarm(sev: Severity.Critical, ack: true));
        store.OnAlarm(Samples.Alarm(sev: Severity.Critical, ack: true, active: false, clearedAt: 5000));
        store.OnAlarm(Samples.Alarm(raisedAt: 9000)); // raised again later
        await store.FlushAsync();

        var alarms = store.Alarms(10);
        Assert.Equal(5, alarms.Count);
        Assert.Equal(9000, alarms[0].RaisedAtMs);
        Assert.False(alarms[1].Active);
        Assert.Equal(5000, alarms[1].ClearedAtMs);

        using var c = db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT change FROM alarms ORDER BY id;";
        using var r = cmd.ExecuteReader();
        var changes = new List<string>();
        while (r.Read()) changes.Add(r.GetString(0));
        Assert.Equal(["raise", "escalate", "ack", "clear", "raise"], changes);
    }

    [Fact]
    public async Task Alarm_example_round_trips()
    {
        var example = Examples.Data<Alarm>("alarm.json");
        await using var store = new SqliteHistoryStore(_dir.NewDatabase());
        store.OnAlarm(example);
        await store.FlushAsync();
        Assert.True(Examples.SameJson(Examples.Node("alarm.json")["data"], Examples.ToNode(store.Alarms(1)[0])));
    }

    [Fact]
    public async Task OnEvent_never_blocks_when_the_queue_is_full_and_drops_the_oldest()
    {
        // Writer not started: nothing drains the 10-slot queue.
        var store = new SqliteHistoryStore(_dir.NewDatabase(), 1000, capacity: 10, time: null, logger: null, startWriter: false);
        await using var _ = store;

        var sw = Stopwatch.StartNew();
        for (var i = 1; i <= 10_000; i++) store.OnEvent(Samples.Event(i));
        sw.Stop();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"10k OnEvent calls took {sw.Elapsed}");
        Assert.Equal(9_990, store.Dropped);

        store.Start(); // (no FlushAsync here: its marker would itself push one event out of the full queue)
        var wait = Stopwatch.StartNew();
        while (store.Events(100).Count < 10 && wait.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(25);
        Assert.Equal(Enumerable.Range(9_991, 10).Reverse().Select(i => $"event {i}"), store.Events(100).Select(e => e.Message));
    }

    [Fact]
    public async Task Stop_writes_everything_still_queued()
    {
        var db = _dir.NewDatabase();
        var store = new SqliteHistoryStore(db);
        for (var i = 1; i <= 30; i++) store.OnEvent(Samples.Event(i));
        await store.StopAsync();
        store.OnEvent(Samples.Event(99)); // ignored after stop, must not throw

        var reopened = new SqliteHistoryStore(db);
        await using var _ = reopened;
        Assert.Equal(30, reopened.Events(100).Count);
    }

    [Fact]
    public async Task Reads_before_any_write_do_not_create_the_database()
    {
        var db = _dir.NewDatabase();
        await using var store = new SqliteHistoryStore(db);
        Assert.Empty(store.Events(10));
        Assert.Empty(store.Alarms(10));
        await store.FlushAsync();
        Assert.False(File.Exists(db.FilePath));
    }

    [Fact]
    public async Task Schema_is_migrated_to_the_latest_version_with_wal()
    {
        var db = _dir.NewDatabase();
        await using var store = new SqliteHistoryStore(db);
        store.OnEvent(Samples.Event(1));
        await store.FlushAsync();

        Assert.Equal(SchemaMigrations.All.Count, db.SchemaVersion());
        using var c = db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "PRAGMA journal_mode;";
        Assert.Equal("wal", cmd.ExecuteScalar() as string);
        cmd.CommandText = "PRAGMA busy_timeout;";
        Assert.Equal((long)SqliteDatabase.BusyTimeoutMs, cmd.ExecuteScalar());

        // Re-opening an existing file must not re-run migrations.
        var again = new SqliteDatabase(db.FilePath);
        using var c2 = again.Open();
        Assert.Equal(SchemaMigrations.All.Count, again.SchemaVersion());
    }

    [Fact]
    public void Limit_below_one_is_rejected()
    {
        using var store = new SqliteHistoryStore(_dir.NewDatabase());
        Assert.Throws<ArgumentOutOfRangeException>(() => store.Events(0));
        Assert.Throws<ArgumentOutOfRangeException>(() => store.Alarms(0));
    }

    // ---- in-memory variant ----

    [Fact]
    public void InMemory_history_orders_pages_and_prunes()
    {
        var store = new InMemoryHistoryStore(retention: 30);
        for (var i = 1; i <= 50; i++) store.OnEvent(Samples.Event(i));
        for (var i = 1; i <= 40; i++) store.OnAlarm(Samples.Alarm($"ALM-{i}"));

        var all = store.Events(100);
        Assert.Equal(30, all.Count);
        Assert.Equal("event 50", all[0].Message);
        var page2 = store.Events(10, all[9].Id);
        Assert.Equal("event 40", page2[0].Message);
        Assert.Equal(30, store.Alarms(100).Count);
        Assert.Equal("ALM-40", store.Alarms(1)[0].Id);
        Assert.Throws<ArgumentOutOfRangeException>(() => store.Events(0));
    }
}
