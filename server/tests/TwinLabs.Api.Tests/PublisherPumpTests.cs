using System.Diagnostics;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Tests;

public class PublisherPumpTests
{
    [Fact]
    public async Task Enabled_publishers_get_one_sample_per_sim_second()
    {
        var pub = new FakePublisher("fake");
        var off = new FakePublisher("off", enabled: false);
        await using var f = new TwinApiFactory { Publishers = [pub, off] };
        f.Host.Start();
        await Eventually.True(() => pub.Started.Count == 1, "StartAsync(plant) at host start");
        Assert.Equal("line-a", pub.Started.Single().Id);

        for (var s = 1; s <= 5; s++)
        {
            f.Host.Advance(TimeSpan.FromSeconds(1));
            await Eventually.True(() => pub.Published.Count == s, $"sample {s}");
        }
        f.Host.Advance(TimeSpan.FromMilliseconds(500)); // half a second: no new sample
        await Task.Delay(50);
        Assert.Equal([1000L, 2000, 3000, 4000, 5000], pub.Published);
        Assert.Empty(off.Started);
        Assert.Empty(off.Published);
    }

    [Fact]
    public async Task A_blocked_publisher_never_blocks_the_loop_or_other_publishers()
    {
        using var gate = new ManualResetEventSlim(false);
        var blocked = new FakePublisher("blocked") { OnPublish = _ => gate.Wait(TimeSpan.FromSeconds(30)) };
        var fast = new FakePublisher("fast");
        await using var f = new TwinApiFactory { Publishers = [blocked, fast] };
        f.Host.Start();

        var sw = Stopwatch.StartNew();
        for (var s = 1; s <= 20; s++)
        {
            f.Host.Advance(TimeSpan.FromSeconds(1));
            await Eventually.True(() => fast.Published.Count == s, $"fast publisher sample {s}");
        }
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10), $"loop took {sw.Elapsed}");
        Assert.Equal(20_000, f.Host.SimTimeMs);
        Assert.Single(blocked.Published);
        gate.Set();
        await Eventually.True(() => blocked.Published.Count >= 2, "blocked publisher resumes");
        Assert.True(blocked.Published.Count <= 1 + Hosting.PublisherPump.MaxPendingSamples, "pending samples are bounded");
    }

    [Fact]
    public async Task A_throwing_publisher_is_logged_and_keeps_receiving_samples()
    {
        var bad = new FakePublisher("bad") { OnPublish = _ => throw new InvalidOperationException("kaboom") };
        await using var f = new TwinApiFactory { Publishers = [bad] };
        f.Host.Start();
        for (var s = 1; s <= 3; s++)
        {
            f.Host.Advance(TimeSpan.FromSeconds(1));
            await Eventually.True(() => bad.Published.Count == s, $"sample {s}");
        }
    }

    [Fact]
    public async Task Plant_change_restarts_publishers_and_shutdown_stops_them()
    {
        var pub = new FakePublisher("fake");
        var f = new TwinApiFactory { Publishers = [pub] };
        f.Host.Start();
        await Eventually.True(() => pub.Started.Count == 1, "started");

        var plant = f.Host.GetPlant() with { Name = "Edited" };
        f.Host.RaisePlantChanged(plant);
        await Eventually.True(() => pub.Started.Count == 2, "restarted on PlantChanged");
        Assert.Equal(1, pub.StopCount);
        Assert.Equal("Edited", pub.Started.Last().Name);

        f.Host.Advance(TimeSpan.FromSeconds(1));
        await Eventually.True(() => pub.Published.Count == 1, "publishes after restart");

        await f.DisposeAsync();
        Assert.Equal(2, pub.StopCount);
    }

    [Fact]
    public async Task In_shadow_mode_publishers_get_the_predictor_not_the_actual_values()
    {
        var pub = new FakePublisher("fake");
        var (f, src) = await ShadowModeTests.ConnectedAsync(factory: new TwinApiFactory { PlantPath = TwinApiFactory.ConnectedPlant, Publishers = [pub] });
        await using var _f = f;
        src.Push(ShadowModeTests.Temp, 99);
        f.Host.Advance(TimeSpan.FromSeconds(1));
        await Eventually.True(() => pub.Published.Count == 1, "one sample");
        Assert.Equal(1, pub.LastSensors!.Single(s => s.Id == "CNC-01.temp").V);
        Assert.Equal(99, f.Host.GetTick().Sensors.Single(s => s.Id == "CNC-01.temp").V);
        Assert.Equal(TwinMode.Shadow, f.Host.Mode);
    }
}
