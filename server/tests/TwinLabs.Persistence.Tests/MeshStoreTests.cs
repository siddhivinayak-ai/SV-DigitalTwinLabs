using TwinLabs.Core;

namespace TwinLabs.Persistence.Tests;

public sealed class MeshStoreTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private string MeshDir => Path.Combine(_dir.Path, "meshes");

    public static TheoryData<string> Kinds => ["file", "memory"];

    private IMeshStore Store(string kind, long max = TwinDataOptions.MaxMeshBytes) =>
        kind == "file" ? new FileMeshStore(_dir.NewDatabase(), MeshDir, max) : new InMemoryMeshStore(max);

    private static async Task<byte[]> ReadAll(Stream s)
    {
        await using (s)
        {
            using var ms = new MemoryStream();
            await s.CopyToAsync(ms);
            return ms.ToArray();
        }
    }

    [Theory, MemberData(nameof(Kinds))]
    public async Task Upload_list_open_delete_glb(string kind)
    {
        var store = Store(kind);
        var bytes = Samples.Glb(5000);
        var info = await store.SaveAsync("cnc-mill.glb", new MemoryStream(bytes), default);

        Assert.Matches("^[0-9a-f]{8}$", info.Id);
        Assert.Equal("cnc-mill.glb", info.Name);
        Assert.Equal($"/api/meshes/{info.Id}/file", info.Url);
        Assert.Equal(5000, info.SizeBytes);
        Assert.Equal(info, Assert.Single(store.List()));

        var opened = store.Open(info.Id)!.Value;
        Assert.Equal("model/gltf-binary", opened.ContentType);
        Assert.Equal(bytes, await ReadAll(opened.Stream));

        if (kind == "file") Assert.True(File.Exists(Path.Combine(MeshDir, $"{info.Id}.glb")));
        Assert.True(store.Delete(info.Id));
        Assert.False(store.Delete(info.Id));
        Assert.Null(store.Open(info.Id));
        Assert.Empty(store.List());
        if (kind == "file") Assert.Empty(Directory.GetFiles(MeshDir));
    }

    [Theory, MemberData(nameof(Kinds))]
    public async Task Gltf_json_is_detected(string kind)
    {
        var store = Store(kind);
        var info = await store.SaveAsync("part.gltf", new MemoryStream(Samples.Gltf()), default);
        var opened = store.Open(info.Id)!.Value;
        await opened.Stream.DisposeAsync();
        Assert.Equal("model/gltf+json", opened.ContentType);
        if (kind == "file") Assert.True(File.Exists(Path.Combine(MeshDir, $"{info.Id}.gltf")));
    }

    [Theory, MemberData(nameof(Kinds))]
    public async Task Bad_magic_empty_file_and_empty_name_are_rejected(string kind)
    {
        var store = Store(kind);
        await Assert.ThrowsAsync<ArgumentException>(() => store.SaveAsync("x.png", new MemoryStream("\x89PNG\r\n\x1a\n"u8.ToArray()), default));
        await Assert.ThrowsAsync<ArgumentException>(() => store.SaveAsync("x.glb", new MemoryStream([]), default));
        await Assert.ThrowsAsync<ArgumentException>(() => store.SaveAsync(" ", new MemoryStream(Samples.Glb(10)), default));
        Assert.Empty(store.List());
        if (kind == "file" && Directory.Exists(MeshDir)) Assert.Empty(Directory.GetFiles(MeshDir));
    }

    [Theory, MemberData(nameof(Kinds))]
    public async Task Size_limit_is_inclusive_and_enforced_while_streaming(string kind)
    {
        var store = Store(kind, max: 100_000);
        var ok = await store.SaveAsync("exact.glb", new GeneratedStream(100_000), default);
        Assert.Equal(100_000, ok.SizeBytes);

        var big = new GeneratedStream(10_000_000);
        await Assert.ThrowsAsync<MeshTooLargeException>(() => store.SaveAsync("big.glb", big, default));
        Assert.True(big.Served < 300_000, $"read {big.Served} bytes before rejecting"); // stopped early, did not drain
        Assert.Single(store.List());
        if (kind == "file") Assert.Single(Directory.GetFiles(MeshDir));
    }

    [Fact]
    public async Task Default_limit_is_20_MB()
    {
        var store = Store("file");
        await Assert.ThrowsAsync<MeshTooLargeException>(() =>
            store.SaveAsync("huge.glb", new GeneratedStream(TwinDataOptions.MaxMeshBytes + 1), default));
        Assert.Empty(Directory.GetFiles(MeshDir));
    }

    [Fact]
    public async Task Metadata_survives_a_new_store_instance_and_ids_are_path_safe()
    {
        var db = _dir.NewDatabase();
        var info = await new FileMeshStore(db, MeshDir).SaveAsync("a.glb", new MemoryStream(Samples.Glb(64)), default);
        var reopened = new FileMeshStore(new SqliteDatabase(db.FilePath), MeshDir);
        Assert.Equal(info, Assert.Single(reopened.List()));
        Assert.Null(reopened.Open("..\\twinlabs"));
        Assert.False(reopened.Delete("../twinlabs.db"));
    }

    [Fact]
    public void Sniff_rules()
    {
        Assert.Equal(MeshFormat.Glb, MeshUpload.Sniff("glTF\x02\0\0\0"u8));
        Assert.Equal(MeshFormat.Gltf, MeshUpload.Sniff("{\"asset\":{}}"u8));
        Assert.Equal(MeshFormat.Gltf, MeshUpload.Sniff([0xEF, 0xBB, 0xBF, (byte)'\n', (byte)'{']));
        Assert.Null(MeshUpload.Sniff("GLTF"u8));
        Assert.Null(MeshUpload.Sniff("[1]"u8));
        Assert.Null(MeshUpload.Sniff("gl"u8));
    }
}
