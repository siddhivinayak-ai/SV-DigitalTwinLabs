using System.Buffers;
using System.Text.Json;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Realtime;

/// <summary>
/// One outbound message before it gets its per-connection <c>seq</c>. <see cref="Data"/> is the pre-serialised
/// UTF-8 JSON of the payload, so a broadcast is serialised once no matter how many clients are connected.
/// </summary>
public sealed record Frame(string Type, long T, ReadOnlyMemory<byte> Data)
{
    /// <summary>Only ticks may be dropped under back-pressure; the next tick supersedes them anyway.</summary>
    public bool Droppable => Type == MessageTypes.Tick;

    public static Frame Create<T>(string type, long simTimeMs, T data) =>
        new(type, simTimeMs, JsonSerializer.SerializeToUtf8Bytes(data, TwinJson.Options));

    /// <summary>Write <c>{"type":..,"t":..,"seq":..,"data":..}</c> into <paramref name="buffer"/>.</summary>
    public void WriteEnvelope(IBufferWriter<byte> buffer, long seq)
    {
        using var w = new Utf8JsonWriter(buffer);
        w.WriteStartObject();
        w.WriteString("type", Type);
        w.WriteNumber("t", T);
        w.WriteNumber("seq", seq);
        w.WritePropertyName("data");
        w.WriteRawValue(Data.Span, skipInputValidation: true);
        w.WriteEndObject();
    }
}
