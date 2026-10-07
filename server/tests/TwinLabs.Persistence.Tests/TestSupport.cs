using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence.Tests;

/// <summary>A unique temp folder, deleted on dispose (after releasing SQLite's pooled file handles).</summary>
public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "twinlabs-persist-" + Guid.NewGuid().ToString("N"));

    public TempDir() => Directory.CreateDirectory(Path);

    public SqliteDatabase NewDatabase() => new(System.IO.Path.Combine(Path, "twinlabs.db"));

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        for (var i = 0; i < 20; i++)
        {
            try
            {
                if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
                return;
            }
            catch (IOException) { Thread.Sleep(50); }
            catch (UnauthorizedAccessException) { Thread.Sleep(50); }
        }
    }
}

public sealed class ManualTime(DateTimeOffset start) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = start;
    public override DateTimeOffset GetUtcNow() => Now;
    public void Advance(TimeSpan by) => Now += by;
}

public static class Examples
{
    public static string Text(string name) => File.ReadAllText(System.IO.Path.Combine(AppContext.BaseDirectory, "examples", name));
    public static JsonNode Node(string name) => JsonNode.Parse(Text(name))!;
    public static T Load<T>(string name) => TwinJson.Deserialize<T>(Text(name));
    /// <summary>The <c>data</c> payload of a WS frame example.</summary>
    public static T Data<T>(string name) => TwinJson.Deserialize<T>(Node(name)["data"]!.ToJsonString());

    public static bool SameJson(JsonNode? a, JsonNode? b) => JsonNode.DeepEquals(a, b);
    public static JsonNode ToNode<T>(T value) => JsonNode.Parse(TwinJson.Serialize(value))!;
}

public static class Samples
{
    public static EventRecord Event(int n) =>
        new(n, n * 100L, EventKind.Info, Severity.Info, $"event {n}", "CNC-01");

    public static Alarm Alarm(string id = "ALM-1", Severity sev = Severity.Warning, bool active = true, bool ack = false,
        long raisedAt = 1000, long? clearedAt = null) =>
        new(id, AlarmSource.Limit, sev, "CNC-01", $"{id} {sev}", raisedAt, active, ack, "CNC-01.vib", 4.6, 4.5, clearedAt);

    public static byte[] Glb(int size)
    {
        var bytes = new byte[size];
        "glTF"u8.CopyTo(bytes);
        for (var i = 4; i < size; i++) bytes[i] = (byte)(i % 251);
        return bytes;
    }

    public static byte[] Gltf() => """  {"asset":{"version":"2.0"}}"""u8.ToArray();
}

/// <summary>Produces <c>length</c> bytes on demand (GLB magic first) without allocating them; can report its position.</summary>
public sealed class GeneratedStream(long length) : Stream
{
    private long _pos;
    public long Served => _pos;
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => _pos; set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    public override int Read(byte[] buffer, int offset, int count)
    {
        var n = (int)Math.Min(count, length - _pos);
        for (var i = 0; i < n; i++)
        {
            var p = _pos + i;
            buffer[offset + i] = p < 4 ? "glTF"u8[(int)p] : (byte)(p % 251);
        }
        _pos += n;
        return n;
    }
}
