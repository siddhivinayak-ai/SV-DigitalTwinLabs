using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence;

/// <summary>Uploaded meshes as files <c>&lt;dir&gt;/&lt;id&gt;.glb|gltf</c>, metadata in the <c>meshes</c> table.</summary>
public sealed class FileMeshStore(SqliteDatabase db, string directory, long maxBytes = TwinDataOptions.MaxMeshBytes, TimeProvider? time = null)
    : IMeshStore
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    public string Directory { get; } = Path.GetFullPath(directory);
    public long MaxBytes { get; } = maxBytes;

    public IReadOnlyList<MeshInfo> List()
    {
        using var c = db.OpenIfExists();
        if (c is null) return [];
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, size_bytes FROM meshes ORDER BY created_utc DESC, rowid DESC;";
        using var r = cmd.ExecuteReader();
        var list = new List<MeshInfo>();
        while (r.Read()) list.Add(new MeshInfo(r.GetString(0), r.GetString(1), StoreHelpers.MeshUrl(r.GetString(0)), r.GetInt64(2)));
        return list;
    }

    public async Task<MeshInfo> SaveAsync(string name, Stream data, CancellationToken ct)
    {
        var n = StoreHelpers.ValidName(name);
        ArgumentNullException.ThrowIfNull(data);
        System.IO.Directory.CreateDirectory(Directory);
        var id = StoreHelpers.NewId();
        var tmp = Path.Combine(Directory, $"{id}.upload");
        try
        {
            MeshFormat format;
            long size;
            await using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true))
                (format, size) = await MeshUpload.CopyAsync(data, fs, MaxBytes, ct).ConfigureAwait(false);

            var created = StoreHelpers.IsoNow(_time);
            using var c = db.Open();
            id = StoreHelpers.InsertWithNewId(useId =>
            {
                using var cmd = c.CreateCommand();
                cmd.CommandText = """
                    INSERT INTO meshes (id, name, file_name, content_type, size_bytes, created_utc)
                    VALUES ($id, $name, $file, $type, $size, $created);
                    """;
                cmd.Parameters.AddWithValue("$id", useId);
                cmd.Parameters.AddWithValue("$name", n);
                cmd.Parameters.AddWithValue("$file", FileName(useId, format));
                cmd.Parameters.AddWithValue("$type", MeshUpload.ContentType(format));
                cmd.Parameters.AddWithValue("$size", size);
                cmd.Parameters.AddWithValue("$created", created);
                cmd.ExecuteNonQuery();
            }, firstId: id);
            File.Move(tmp, Path.Combine(Directory, FileName(id, format)), overwrite: true);
            return new MeshInfo(id, n, StoreHelpers.MeshUrl(id), size);
        }
        finally
        {
            TryDelete(tmp);
        }
    }

    public (Stream Stream, string ContentType)? Open(string id)
    {
        var row = Find(id);
        if (row is null) return null;
        try
        {
            var fs = new FileStream(Path.Combine(Directory, row.Value.FileName), FileMode.Open, FileAccess.Read,
                FileShare.Read | FileShare.Delete, 81920, useAsync: true);
            return (fs, row.Value.ContentType);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    public bool Delete(string id)
    {
        var row = Find(id);
        if (row is null) return false;
        SqliteScenarioStore.DeleteRow(db, "meshes", id);
        TryDelete(Path.Combine(Directory, row.Value.FileName));
        return true;
    }

    private (string FileName, string ContentType)? Find(string id)
    {
        if (!StoreHelpers.IsValidId(id)) return null;
        using var c = db.OpenIfExists();
        if (c is null) return null;
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT file_name, content_type FROM meshes WHERE id = $id;";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        return r.Read() ? (r.GetString(0), r.GetString(1)) : null;
    }

    private static string FileName(string id, MeshFormat f) => $"{id}.{MeshUpload.Extension(f)}";

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
