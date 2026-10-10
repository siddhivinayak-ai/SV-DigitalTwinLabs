using Microsoft.Data.Sqlite;

namespace TwinLabs.Persistence;

/// <summary>
/// The <c>twinlabs.db</c> file. Created lazily on the first write (folder, WAL mode, migrations), so a host that never
/// stores anything never touches disk. Every <see cref="Open"/> returns a fresh pooled connection with <c>busy_timeout</c> set.
/// </summary>
public sealed class SqliteDatabase
{
    public const int BusyTimeoutMs = 5000;

    private readonly object _initLock = new();
    private readonly string _connectionString;
    private volatile bool _ready;

    public SqliteDatabase(string filePath)
    {
        FilePath = Path.GetFullPath(filePath);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = FilePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = true,
        }.ToString();
    }

    public string FilePath { get; }

    /// <summary>True once the file exists (created by this process or an earlier run).</summary>
    public bool Exists => _ready || File.Exists(FilePath);

    /// <summary>Opens a connection, creating and migrating the database first if needed.</summary>
    public SqliteConnection Open()
    {
        EnsureCreated();
        return OpenRaw();
    }

    /// <summary>Opens a connection only if the database already exists; null otherwise (reads never create the file).</summary>
    public SqliteConnection? OpenIfExists() => Exists ? Open() : null;

    /// <summary>Releases pooled handles to the file (tests call this before deleting the folder).</summary>
    public void ReleasePool()
    {
        using var c = new SqliteConnection(_connectionString);
        SqliteConnection.ClearPool(c);
    }

    public int SchemaVersion()
    {
        using var c = OpenIfExists();
        return c is null ? 0 : CurrentVersion(c);
    }

    private SqliteConnection OpenRaw()
    {
        var c = new SqliteConnection(_connectionString);
        c.Open();
        Exec(c, $"PRAGMA busy_timeout={BusyTimeoutMs}; PRAGMA synchronous=NORMAL;");
        return c;
    }

    private void EnsureCreated()
    {
        if (_ready) return;
        lock (_initLock)
        {
            if (_ready) return;
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            using var c = OpenRaw();
            Exec(c, "PRAGMA journal_mode=WAL;");
            Migrate(c);
            _ready = true;
        }
    }

    private static void Migrate(SqliteConnection c)
    {
        Exec(c, "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
        var current = CurrentVersion(c);
        for (var v = current + 1; v <= SchemaMigrations.All.Count; v++)
        {
            using var tx = c.BeginTransaction();
            Exec(c, SchemaMigrations.All[v - 1], tx);
            Exec(c, $"DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES ({v});", tx);
            tx.Commit();
        }
    }

    private static int CurrentVersion(SqliteConnection c)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version';";
        if (cmd.ExecuteScalar() is null) return 0;
        cmd.CommandText = "SELECT COALESCE(MAX(version), 0) FROM schema_version;";
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    internal static void Exec(SqliteConnection c, string sql, SqliteTransaction? tx = null)
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }
}

/// <summary>Forward-only migrations; index + 1 = schema version. Never edit a shipped entry, append a new one.</summary>
internal static class SchemaMigrations
{
    public static readonly IReadOnlyList<string> All =
    [
        // v1: history, scenarios, layouts, meshes
        """
        CREATE TABLE events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id     INTEGER NOT NULL,
            time_ms      INTEGER NOT NULL,
            kind         TEXT    NOT NULL,
            severity     TEXT    NOT NULL,
            asset_id     TEXT,
            recorded_utc TEXT    NOT NULL,
            json         TEXT    NOT NULL
        );
        CREATE TABLE alarms (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            alarm_id      TEXT    NOT NULL,
            change        TEXT    NOT NULL,
            severity      TEXT    NOT NULL,
            asset_id      TEXT    NOT NULL,
            active        INTEGER NOT NULL,
            acknowledged  INTEGER NOT NULL,
            raised_at_ms  INTEGER NOT NULL,
            cleared_at_ms INTEGER,
            recorded_utc  TEXT    NOT NULL,
            json          TEXT    NOT NULL
        );
        CREATE INDEX ix_alarms_alarm_id ON alarms (alarm_id);
        CREATE TABLE scenarios (
            id           TEXT PRIMARY KEY,
            name         TEXT    NOT NULL,
            created_utc  TEXT    NOT NULL,
            duration_s   REAL    NOT NULL,
            overrides    INTEGER NOT NULL,
            request_json TEXT    NOT NULL,
            result_json  TEXT
        );
        CREATE TABLE layouts (
            id          TEXT PRIMARY KEY,
            name        TEXT    NOT NULL,
            created_utc TEXT    NOT NULL,
            updated_utc TEXT    NOT NULL,
            asset_count INTEGER NOT NULL,
            plant_json  TEXT    NOT NULL
        );
        CREATE TABLE meshes (
            id           TEXT PRIMARY KEY,
            name         TEXT    NOT NULL,
            file_name    TEXT    NOT NULL,
            content_type TEXT    NOT NULL,
            size_bytes   INTEGER NOT NULL,
            created_utc  TEXT    NOT NULL
        );
        """,
    ];
}
