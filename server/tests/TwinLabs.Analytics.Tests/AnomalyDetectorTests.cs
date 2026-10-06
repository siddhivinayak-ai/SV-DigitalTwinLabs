using TwinLabs.Core.Contracts;
using static TwinLabs.Analytics.Tests.TestPlant;

namespace TwinLabs.Analytics.Tests;

public class AnomalyDetectorTests
{
    private readonly AnomalyDetector _d = new(Create());
    private long _t;

    private IReadOnlyList<Alarm> Feed(string sensor, double v, AssetStateKind? state = null, string assetId = "M1")
    {
        _t += 200;
        IReadOnlyList<AssetState> assets = state is { } s ? [State(assetId, s)] : [];
        return _d.Observe(_t, [new SensorValue(sensor, v)], assets);
    }

    // ---------------- limit ----------------

    [Fact]
    public void Limit_DebouncesThreeSamples_ThenRaisesWarning()
    {
        Assert.Empty(Feed("M1.vib", 4.62));
        Assert.Empty(Feed("M1.vib", 4.62));
        var raised = Assert.Single(Feed("M1.vib", 4.62));

        Assert.Equal("ALM-M1.vib-limit", raised.Id);
        Assert.Equal(AlarmSource.Limit, raised.Source);
        Assert.Equal(Severity.Warning, raised.Severity);
        Assert.Equal("M1", raised.AssetId);
        Assert.Equal("M1.vib", raised.SensorId);
        Assert.Equal(4.62, raised.Value);
        Assert.Equal(4.5, raised.Limit);
        Assert.Equal("M1.vib HI 4.62 mm/s > 4.5", raised.Message);
        Assert.True(raised.Active);
        Assert.False(raised.Acknowledged);
        Assert.Equal(_t, raised.RaisedAtMs);
        Assert.Single(_d.Active);

        // Staying high produces no further changes.
        Assert.Empty(Feed("M1.vib", 4.7));
    }

    [Fact]
    public void Limit_NoiseBelowDebounce_DoesNotRaise()
    {
        Feed("M1.vib", 5);
        Feed("M1.vib", 5);
        Feed("M1.vib", 4);
        Feed("M1.vib", 5);
        Assert.Empty(Feed("M1.vib", 5));
        Assert.Empty(_d.Active);
    }

    [Fact]
    public void Limit_EscalatesToCritical_AndRaisesCriticalDirectly()
    {
        for (var i = 0; i < 3; i++) Feed("M1.vib", 5);
        var esc = Assert.Single(Feed("M1.vib", 7.5));
        Assert.Equal(Severity.Critical, esc.Severity);
        Assert.Equal(7.1, esc.Limit);
        Assert.Equal("M1.vib HIHI 7.5 mm/s > 7.1", esc.Message);
        Assert.Empty(Feed("M1.vib", 8)); // already critical

        var d2 = new AnomalyDetector(Create());
        d2.Observe(1, [new("M1.vib", 9)], []);
        d2.Observe(2, [new("M1.vib", 9)], []);
        var direct = Assert.Single(d2.Observe(3, [new("M1.vib", 9)], []));
        Assert.Equal(Severity.Critical, direct.Severity);
    }

    [Fact]
    public void Limit_HiHiOnlySensor_RaisesCritical()
    {
        for (var i = 0; i < 2; i++) Feed("R1.hot", 70, AssetStateKind.Running, "R1");
        var a = Assert.Single(Feed("R1.hot", 70, AssetStateKind.Running, "R1"));
        Assert.Equal(Severity.Critical, a.Severity);
        Assert.Equal(65, a.Limit);
    }

    [Fact]
    public void Limit_HysteresisClear()
    {
        for (var i = 0; i < 3; i++) Feed("M1.vib", 5);
        Assert.Empty(Feed("M1.vib", 4.45)); // below hi but above hi*0.98 = 4.41
        Assert.Empty(Feed("M1.vib", 4.42));
        var cleared = Assert.Single(Feed("M1.vib", 4.40));
        Assert.False(cleared.Active);
        Assert.Equal(_t, cleared.ClearedAtMs);
        Assert.Equal("ALM-M1.vib-limit", cleared.Id);
        Assert.Empty(_d.Active);
    }

    [Fact]
    public void Limit_Acknowledge_AndReRaiseStartsUnacknowledged()
    {
        Assert.Null(_d.Acknowledge("ALM-M1.vib-limit"));
        for (var i = 0; i < 3; i++) Feed("M1.vib", 5);

        var acked = _d.Acknowledge("ALM-M1.vib-limit");
        Assert.NotNull(acked);
        Assert.True(acked!.Acknowledged);
        Assert.True(_d.Active.Single().Acknowledged);
        Assert.Null(_d.Acknowledge("nope"));

        var cleared = Assert.Single(Feed("M1.vib", 1));
        Assert.True(cleared.Acknowledged);
        Assert.Null(_d.Acknowledge("ALM-M1.vib-limit")); // no longer active

        for (var i = 0; i < 2; i++) Feed("M1.vib", 5);
        var again = Assert.Single(Feed("M1.vib", 5));
        Assert.False(again.Acknowledged);
        Assert.Null(again.ClearedAtMs);
    }

    [Fact]
    public void Limit_LevelSensor_StillChecked()
    {
        for (var i = 0; i < 2; i++) Feed("BUF.level", 10);
        Assert.Equal("ALM-BUF.level-limit", Assert.Single(Feed("BUF.level", 10)).Id);
    }

    // ---------------- anomaly ----------------

    /// <summary>Independent EWMA replica to place test spikes at a known z.</summary>
    private sealed class Ewma
    {
        public double Mean, Var;
        private int _n;
        public void Add(double x)
        {
            if (_n++ == 0) { Mean = x; return; }
            var diff = x - Mean;
            var incr = 0.05 * diff;
            Mean += incr;
            Var = 0.95 * (Var + diff * incr);
        }
        public double At(double z) => Mean + z * Math.Sqrt(Var);
    }

    private static double Normal(int i) => 2.0 + (i % 2 == 0 ? 0.01 : -0.01) + (i % 7) * 0.001;

    private Ewma WarmUp(int samples, string sensor = "M1.temp")
    {
        var ewma = new Ewma();
        for (var i = 0; i < samples; i++)
        {
            var v = Normal(i);
            Assert.Empty(Feed(sensor, v, AssetStateKind.Running));
            ewma.Add(v);
        }
        return ewma;
    }

    [Fact]
    public void Anomaly_NoFlagsDuringWarmup()
    {
        for (var i = 0; i < 49; i++) Assert.Empty(Feed("M1.temp", i < 10 ? 2.0 + i * 0.01 : 2.0, AssetStateKind.Running));
        // A big spike while still warming up (sample 50 is the last warm-up sample)…
        Assert.Empty(Feed("M1.temp", 50, AssetStateKind.Running));
        Assert.Empty(_d.Active);
    }

    [Fact]
    public void Anomaly_SpikeRaisesWarning_EscalatesToCritical_ThenClears()
    {
        var ewma = WarmUp(200);
        var warn = ewma.At(5);

        Assert.Empty(Feed("M1.temp", warn, AssetStateKind.Running));
        Assert.Empty(Feed("M1.temp", warn, AssetStateKind.Running));
        var raised = Assert.Single(Feed("M1.temp", warn, AssetStateKind.Running));
        Assert.Equal("ALM-M1.temp-anomaly", raised.Id);
        Assert.Equal(AlarmSource.Anomaly, raised.Source);
        Assert.Equal(Severity.Warning, raised.Severity);
        Assert.Equal("M1.temp", raised.SensorId);
        Assert.Equal(warn, raised.Value);
        Assert.StartsWith("M1.temp ANOMALY z=+5.0", raised.Message);

        // The baseline is frozen while anomalous, so the replica stays valid.
        var esc = Assert.Single(Feed("M1.temp", ewma.At(8), AssetStateKind.Running));
        Assert.Equal(Severity.Critical, esc.Severity);

        // 9 calm samples are not enough; a non-calm one restarts the count.
        for (var i = 0; i < 9; i++) Assert.Empty(Feed("M1.temp", ewma.Mean, AssetStateKind.Running));
        Assert.Empty(Feed("M1.temp", ewma.At(3), AssetStateKind.Running));
        for (var i = 0; i < 9; i++) Assert.Empty(Feed("M1.temp", ewma.Mean, AssetStateKind.Running));
        var cleared = Assert.Single(Feed("M1.temp", ewma.Mean, AssetStateKind.Running));
        Assert.False(cleared.Active);
        Assert.NotNull(cleared.ClearedAtMs);
        Assert.Empty(_d.Active);
    }

    [Fact]
    public void Anomaly_BigSpikeRaisesCriticalDirectly()
    {
        var ewma = WarmUp(100);
        Feed("M1.temp", ewma.At(10), AssetStateKind.Running);
        Feed("M1.temp", ewma.At(10), AssetStateKind.Running);
        Assert.Equal(Severity.Critical, Assert.Single(Feed("M1.temp", ewma.At(10), AssetStateKind.Running)).Severity);
    }

    [Fact]
    public void Anomaly_TwoSpikesThenNormal_DoesNotRaise()
    {
        var ewma = WarmUp(100);
        Feed("M1.temp", ewma.At(5), AssetStateKind.Running);
        Feed("M1.temp", ewma.At(5), AssetStateKind.Running);
        Feed("M1.temp", ewma.Mean, AssetStateKind.Running);
        Assert.Empty(Feed("M1.temp", ewma.At(5), AssetStateKind.Running));
        Assert.Empty(_d.Active);
    }

    [Theory]
    [InlineData(AssetStateKind.Idle)]
    [InlineData(AssetStateKind.Starved)]
    [InlineData(AssetStateKind.Fault)]
    [InlineData(AssetStateKind.Maintenance)]
    public void Anomaly_NotFlaggedWhileAssetNotRunning(AssetStateKind state)
    {
        var ewma = WarmUp(100);
        for (var i = 0; i < 20; i++)
            Assert.DoesNotContain(Feed("M1.temp", ewma.At(50), state), a => a.Source == AlarmSource.Anomaly);

        // Back to Running with normal values: still no anomaly, and the baseline wasn't polluted.
        for (var i = 0; i < 5; i++)
            Assert.DoesNotContain(Feed("M1.temp", ewma.Mean, AssetStateKind.Running), a => a.Source == AlarmSource.Anomaly);
        Feed("M1.temp", ewma.At(5), AssetStateKind.Running);
        Feed("M1.temp", ewma.At(5), AssetStateKind.Running);
        Assert.Single(Feed("M1.temp", ewma.At(5), AssetStateKind.Running));
    }

    [Fact]
    public void Anomaly_SkipsCountAndLevelSensors()
    {
        for (var i = 0; i < 100; i++)
        {
            _t += 200;
            _d.Observe(_t, [new("SNK.good", i % 2), new("BUF.level", 1 + i % 2 * 0.01)], []);
        }
        for (var i = 0; i < 5; i++)
        {
            _t += 200;
            Assert.Empty(_d.Observe(_t, [new("SNK.good", 1e6), new("BUF.level", 5)], []));
        }
    }

    // ---------------- fault ----------------

    [Fact]
    public void Fault_RaisedWhileInFault_ClearedAfter()
    {
        var raised = Assert.Single(_d.Observe(1000, [], [State("M1", AssetStateKind.Fault), State("R1", AssetStateKind.Running)]));
        Assert.Equal("ALM-M1-fault", raised.Id);
        Assert.Equal(AlarmSource.Fault, raised.Source);
        Assert.Equal(Severity.Critical, raised.Severity);
        Assert.Equal("M1 in FAULT", raised.Message);
        Assert.Equal(1000, raised.RaisedAtMs);
        Assert.Null(raised.SensorId);

        Assert.Empty(_d.Observe(1200, [], [State("M1", AssetStateKind.Fault)]));
        Assert.Single(_d.Active);

        var cleared = Assert.Single(_d.Observe(1400, [], [State("M1", AssetStateKind.Running)]));
        Assert.False(cleared.Active);
        Assert.Equal(1400, cleared.ClearedAtMs);
        Assert.Equal(1000, cleared.RaisedAtMs);
        Assert.Empty(_d.Active);
    }

    [Fact]
    public void Reset_AndTimeGoingBackwards_ClearState()
    {
        _d.Observe(5000, [], [State("M1", AssetStateKind.Fault)]);
        Assert.Single(_d.Active);
        _d.Observe(100, [], []);
        Assert.Empty(_d.Active);

        _d.Observe(200, [], [State("M1", AssetStateKind.Fault)]);
        _d.Reset();
        Assert.Empty(_d.Active);
        Assert.Single(_d.Observe(300, [], [State("M1", AssetStateKind.Fault)])); // re-raised fresh
    }

    [Fact]
    public void UnknownSensorsAndNaN_AreIgnored()
    {
        Assert.Empty(_d.Observe(1, [new("XX.unknown", 1e9), new("M1.vib", double.NaN)], []));
    }
}
