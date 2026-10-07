using TwinLabs.Api.Hosting;
using TwinLabs.Api.Realtime;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

public class SensorHistoryTests
{
    private static readonly SensorDef[] Sensors =
    [
        new("A.temp", "A", SensorKind.Temperature, "°C", 0),
        new("A.vib", "A", SensorKind.Vibration, "mm/s", 0),
    ];

    [Fact]
    public void Ring_buffer_keeps_only_the_newest_capacity_samples()
    {
        var h = new SensorHistory(Sensors, 3);
        for (var i = 0; i < 10; i++) h.Record(i * 1000, [new SensorValue("A.temp", i), new SensorValue("A.vib", -i)]);

        var s = h.GetSeries("A.temp", 0);
        Assert.Equal([7000L, 8000, 9000], s.T);
        Assert.Equal([7d, 8, 9], s.V);
        Assert.Equal("°C", s.Unit);
        Assert.Equal([9000L], h.GetSeries("A.temp", 8500).T);
        Assert.Empty(h.GetSeries("A.temp", 10_000).T);
        Assert.Throws<KeyNotFoundException>(() => h.GetSeries("B.temp", 0));
    }

    [Fact]
    public void Missing_sensor_repeats_last_value_and_csv_is_invariant()
    {
        var h = new SensorHistory(Sensors, 10);
        h.Record(0, [new SensorValue("A.temp", 1.5), new SensorValue("A.vib", 0.25)]);
        h.Record(1000, [new SensorValue("A.temp", 2.5)]);
        Assert.Equal([0.25, 0.25], h.GetSeries("A.vib", 0).V);
        Assert.Equal("simTimeMs,A.temp,A.vib\n0,1.5,0.25\n1000,2.5,0.25\n", h.Slice(0).ToCsv());
    }
}

public class PlantLocatorTests
{
    [Fact]
    public void Walks_up_to_contracts_plant_or_honours_explicit_path()
    {
        var found = PlantLocator.Resolve(null, AppContext.BaseDirectory);
        Assert.True(File.Exists(found));
        Assert.EndsWith(PlantLocator.DefaultFile, found);

        Assert.Equal(Path.GetFullPath(found), PlantLocator.Resolve(found, "C:\\"));
        Assert.Throws<FileNotFoundException>(() => PlantLocator.Resolve("nope/missing.json", AppContext.BaseDirectory));
    }

    [Fact]
    public void Published_layout_has_plant_next_to_binaries() =>
        Assert.True(File.Exists(Path.Combine(AppContext.BaseDirectory, "plant", PlantLocator.DefaultFile)));
}

public class ClientOutboxTests
{
    private static Frame F(string type, long t = 0) => new(type, t, "{}"u8.ToArray());

    private static List<Frame> Drain(ClientOutbox o)
    {
        var list = new List<Frame>();
        while (o.TryDequeue(out var f)) list.Add(f);
        return list;
    }

    [Fact]
    public void Full_queue_evicts_oldest_tick_first()
    {
        var o = new ClientOutbox(capacity: 4);
        o.Enqueue(F(MessageTypes.Tick, 1));
        o.Enqueue(F(MessageTypes.Event, 2));
        o.Enqueue(F(MessageTypes.Tick, 3));
        o.Enqueue(F(MessageTypes.Alarm, 4));
        o.Enqueue(F(MessageTypes.Tick, 5)); // evicts tick@1
        o.Enqueue(F(MessageTypes.Ack, 6));  // evicts tick@3

        Assert.Equal([2L, 4, 5, 6], Drain(o).Select(f => f.T));
        Assert.Equal(2, o.DroppedTicks);
    }

    [Fact]
    public void Critical_frames_are_never_dropped_until_hard_limit()
    {
        var o = new ClientOutbox(capacity: 2);
        for (var i = 0; i < o.HardLimit; i++) Assert.True(o.Enqueue(F(MessageTypes.Event, i)));
        Assert.True(o.Enqueue(F(MessageTypes.Tick)));         // tick silently dropped, client kept
        Assert.Equal(o.HardLimit, o.Count);
        Assert.False(o.Enqueue(F(MessageTypes.Event)));       // past the hard limit: client is closed
        Assert.Equal(System.Net.WebSockets.WebSocketCloseStatus.PolicyViolation, o.CloseStatus);
        Assert.All(Drain(o), f => Assert.Equal(MessageTypes.Event, f.Type));
    }

    [Fact]
    public async Task Wait_returns_false_after_complete_and_drain()
    {
        var o = new ClientOutbox();
        o.Enqueue(F(MessageTypes.Event));
        o.Complete();
        Assert.False(o.Enqueue(F(MessageTypes.Event)));
        Assert.True(await o.WaitToReadAsync(CancellationToken.None));
        Assert.Single(Drain(o));
        Assert.False(await o.WaitToReadAsync(CancellationToken.None));
    }
}
