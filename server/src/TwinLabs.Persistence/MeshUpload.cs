using System.Buffers;

namespace TwinLabs.Persistence;

/// <summary>Upload larger than the mesh limit (HTTP 413).</summary>
public sealed class MeshTooLargeException(long limitBytes)
    : InvalidOperationException($"Mesh exceeds the {limitBytes / (1024 * 1024)} MB limit.")
{
    public long LimitBytes { get; } = limitBytes;
}

public enum MeshFormat { Glb, Gltf }

/// <summary>Streaming copy with magic-byte sniffing and a hard size limit; never buffers more than one chunk.</summary>
public static class MeshUpload
{
    public const string GlbContentType = "model/gltf-binary";
    public const string GltfContentType = "model/gltf+json";
    private const int HeadBytes = 64;

    public static string ContentType(MeshFormat f) => f == MeshFormat.Glb ? GlbContentType : GltfContentType;
    public static string Extension(MeshFormat f) => f == MeshFormat.Glb ? "glb" : "gltf";

    /// <summary><c>glTF</c> = GLB; <c>{</c> (after an optional UTF-8 BOM and whitespace) = glTF JSON; else null.</summary>
    public static MeshFormat? Sniff(ReadOnlySpan<byte> head)
    {
        if (head.Length >= 4 && head[0] == (byte)'g' && head[1] == (byte)'l' && head[2] == (byte)'T' && head[3] == (byte)'F')
            return MeshFormat.Glb;
        var i = head.StartsWith((ReadOnlySpan<byte>)[0xEF, 0xBB, 0xBF]) ? 3 : 0;
        while (i < head.Length && head[i] is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n') i++;
        return i < head.Length && head[i] == (byte)'{' ? MeshFormat.Gltf : null;
    }

    /// <summary>
    /// Copies <paramref name="source"/> to <paramref name="destination"/>. Throws <see cref="ArgumentException"/> for an
    /// empty or unrecognised file and <see cref="MeshTooLargeException"/> as soon as more than <paramref name="maxBytes"/> arrive.
    /// </summary>
    public static async Task<(MeshFormat Format, long Size)> CopyAsync(Stream source, Stream destination, long maxBytes, CancellationToken ct)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(81920);
        try
        {
            // Fill the head (or hit EOF) before deciding the format.
            var head = 0;
            while (head < HeadBytes)
            {
                var n = await source.ReadAsync(buffer.AsMemory(head, HeadBytes - head), ct).ConfigureAwait(false);
                if (n == 0) break;
                head += n;
            }
            if (head == 0) throw new ArgumentException("The mesh file is empty.");
            var format = Sniff(buffer.AsSpan(0, head))
                ?? throw new ArgumentException("Not a glTF file: expected the 'glTF' magic (GLB) or a JSON object (glTF).");
            if (head > maxBytes) throw new MeshTooLargeException(maxBytes);
            await destination.WriteAsync(buffer.AsMemory(0, head), ct).ConfigureAwait(false);

            long total = head;
            int read;
            while ((read = await source.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
            {
                total += read;
                if (total > maxBytes) throw new MeshTooLargeException(maxBytes);
                await destination.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
            }
            return (format, total);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
