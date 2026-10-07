using System.Globalization;
using System.Text;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Hosting;

/// <summary>
/// Fixed-capacity 1 Hz ring buffer of sensor samples: one shared time column plus one ring per sensor
/// (column store, so reading a series is a straight copy). Not thread-safe; the host lock guards it.
/// </summary>
public sealed class SensorHistory
{
    private readonly SensorDef[] _sensors;
    private readonly Dictionary<string, int> _index;
    private readonly long[] _t;
    private readonly double[][] _v;
    private readonly double[] _last;
    private int _head;   // next write slot
    private int _count;

    public SensorHistory(IReadOnlyList<SensorDef> sensors, int capacity)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        _sensors = [.. sensors];
        _index = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < _sensors.Length; i++) _index[_sensors[i].Id] = i;
        _t = new long[capacity];
        _v = new double[_sensors.Length][];
        for (var i = 0; i < _v.Length; i++) _v[i] = new double[capacity];
        _last = new double[_sensors.Length];
    }

    public int Capacity => _t.Length;
    public int Count => _count;

    /// <summary>Record one sample set. Sensors missing from <paramref name="values"/> repeat their last value.</summary>
    public void Record(long simTimeMs, IReadOnlyList<SensorValue> values)
    {
        foreach (var sv in values)
            if (_index.TryGetValue(sv.Id, out var i) && double.IsFinite(sv.V)) _last[i] = sv.V;

        _t[_head] = simTimeMs;
        for (var i = 0; i < _v.Length; i++) _v[i][_head] = _last[i];
        _head = (_head + 1) % _t.Length;
        if (_count < _t.Length) _count++;
    }

    public void Clear()
    {
        _head = 0;
        _count = 0;
        Array.Clear(_last);
    }

    /// <summary>Physical index of the oldest kept sample with time &gt;= <paramref name="fromMs"/>, and how many follow.</summary>
    private (int Start, int Count) Window(long fromMs)
    {
        var cap = _t.Length;
        var oldest = (_head - _count + cap) % cap;
        // Times are monotonic inside the ring: binary search on the logical index.
        int lo = 0, hi = _count;
        while (lo < hi)
        {
            var mid = (lo + hi) >>> 1;
            if (_t[(oldest + mid) % cap] < fromMs) lo = mid + 1; else hi = mid;
        }
        return ((oldest + lo) % cap, _count - lo);
    }

    public HistorySeries GetSeries(string sensorId, long fromMs)
    {
        if (!_index.TryGetValue(sensorId, out var col)) throw TwinErrors.UnknownSensor(sensorId);
        var (start, n) = Window(fromMs);
        var t = new long[n];
        var v = new double[n];
        Copy(_t, start, t);
        Copy(_v[col], start, v);
        return new HistorySeries(sensorId, _sensors[col].Unit, t, v);
    }

    /// <summary>Copy every column from <paramref name="fromMs"/>. Cheap enough for the lock; formatting happens outside.</summary>
    public HistoryTable Slice(long fromMs)
    {
        var (start, n) = Window(fromMs);
        var t = new long[n];
        Copy(_t, start, t);
        var cols = new double[_v.Length][];
        for (var i = 0; i < cols.Length; i++)
        {
            cols[i] = new double[n];
            Copy(_v[i], start, cols[i]);
        }
        return new HistoryTable([.. _sensors.Select(s => s.Id)], t, cols);
    }

    private static void Copy<T>(T[] ring, int start, T[] dest)
    {
        var first = Math.Min(dest.Length, ring.Length - start);
        Array.Copy(ring, start, dest, 0, first);
        if (first < dest.Length) Array.Copy(ring, 0, dest, first, dest.Length - first);
    }
}

/// <summary>A detached copy of the history window, ready to format as CSV.</summary>
public sealed record HistoryTable(string[] SensorIds, long[] T, double[][] Columns)
{
    public string ToCsv()
    {
        var inv = CultureInfo.InvariantCulture;
        var sb = new StringBuilder(64 + T.Length * (12 + SensorIds.Length * 8));
        sb.Append("simTimeMs");
        foreach (var id in SensorIds) sb.Append(',').Append(Escape(id));
        sb.Append('\n');
        for (var r = 0; r < T.Length; r++)
        {
            sb.Append(T[r].ToString(inv));
            foreach (var col in Columns) sb.Append(',').Append(col[r].ToString("R", inv));
            sb.Append('\n');
        }
        return sb.ToString();
    }

    private static string Escape(string s) =>
        s.AsSpan().IndexOfAny(",\"\n\r") < 0 ? s : "\"" + s.Replace("\"", "\"\"") + "\"";
}
