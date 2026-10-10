using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

public class ShadowEventSinkTests
{
    private sealed class ThrowingSink : IHostEventSink
    {
        public void OnEvent(EventRecord e) => throw new InvalidOperationException("sink down");
        public void OnAlarm(Alarm a) => throw new InvalidOperationException("sink down");
    }

    [Fact]
    public async Task Sinks_receive_every_event_and_changed_alarm_off_the_lock()
    {
        var sink = new FakeSink();
        var other = new FakeSink();
        await using var f = new TwinApiFactory { Sinks = [sink, new FakeSink(), other] };
        f.Host.Start();
        f.Detector.Pending.Enqueue(FakeAnomalyDetector.VibAlarm());
        f.RunSimSeconds(1);
        f.Host.AcknowledgeAlarm("ALM-CNC-01.vib-limit");

        await Eventually.True(() => sink.Alarms.Count == 2, "raised + acked alarm");
        await Eventually.True(() => other.Events.Count == f.Host.GetEvents(1000).Count, "every event, to every sink");
        Assert.Equal("Simulation initialised (seed 42)", sink.Events.First().Message); // logged before the sink was attached
        Assert.Contains(sink.Events, e => e.Message == "Command sim.start");
        Assert.Equal(f.Host.GetEvents(1000).Select(e => e.Id), sink.Events.Select(e => e.Id));
        Assert.True(sink.Alarms.Last().Acknowledged);
        Assert.NotEqual(Environment.CurrentManagedThreadId, sink.ThreadId);
    }

    [Fact]
    public async Task A_failing_sink_does_not_affect_the_host_or_other_sinks()
    {
        var sink = new FakeSink();
        await using var f = new TwinApiFactory { Sinks = [new ThrowingSink(), sink] };
        f.Host.Start();
        f.Host.Pause();
        await Eventually.True(() => sink.Events.Count == 3, "init + 2 commands");
    }
}
