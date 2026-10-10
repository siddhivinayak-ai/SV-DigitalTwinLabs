using Microsoft.Data.Sqlite;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence;

/// <summary>Saved what-if scenarios. Request and result are JSON columns (<see cref="TwinJson"/>). Lists newest first.</summary>
public sealed class SqliteScenarioStore(SqliteDatabase db, TimeProvider? time = null) : IScenarioStore
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public IReadOnlyList<ScenarioSummary> List()
    {
        using var c = db.OpenIfExists();
        if (c is null) return [];
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, created_utc, duration_s, overrides FROM scenarios ORDER BY created_utc DESC, rowid DESC;";
        using var r = cmd.ExecuteReader();
        var list = new List<ScenarioSummary>();
        while (r.Read()) list.Add(new ScenarioSummary(r.GetString(0), r.GetString(1), r.GetString(2), r.GetDouble(3), r.GetInt32(4)));
        return list;
    }

    public Scenario? Get(string id)
    {
        if (!StoreHelpers.IsValidId(id)) return null;
        using var c = db.OpenIfExists();
        if (c is null) return null;
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, created_utc, request_json, result_json FROM scenarios WHERE id = $id;";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return new Scenario(r.GetString(0), r.GetString(1), r.GetString(2),
            TwinJson.Deserialize<WhatIfRequest>(r.GetString(3)),
            r.IsDBNull(4) ? null : TwinJson.Deserialize<WhatIfResult>(r.GetString(4)));
    }

    public Scenario Save(SaveScenarioRequest request)
    {
        var (name, req) = StoreHelpers.Validate(request);
        var created = StoreHelpers.IsoNow(_time);
        var requestJson = TwinJson.Serialize(req);
        var resultJson = request.Result is null ? null : TwinJson.Serialize(request.Result);
        using var c = db.Open();
        var id = StoreHelpers.InsertWithNewId(newId =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = """
                INSERT INTO scenarios (id, name, created_utc, duration_s, overrides, request_json, result_json)
                VALUES ($id, $name, $created, $dur, $ovr, $req, $res);
                """;
            cmd.Parameters.AddWithValue("$id", newId);
            cmd.Parameters.AddWithValue("$name", name);
            cmd.Parameters.AddWithValue("$created", created);
            cmd.Parameters.AddWithValue("$dur", req.DurationS);
            cmd.Parameters.AddWithValue("$ovr", req.Overrides.Count);
            cmd.Parameters.AddWithValue("$req", requestJson);
            cmd.Parameters.AddWithValue("$res", (object?)resultJson ?? DBNull.Value);
            cmd.ExecuteNonQuery();
        });
        return new Scenario(id, name, created, req, request.Result);
    }

    public bool Delete(string id) => DeleteRow(db, "scenarios", id);

    internal static bool DeleteRow(SqliteDatabase db, string table, string id)
    {
        if (!StoreHelpers.IsValidId(id)) return false;
        using var c = db.OpenIfExists();
        if (c is null) return false;
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"DELETE FROM {table} WHERE id = $id;";
        cmd.Parameters.AddWithValue("$id", id);
        return cmd.ExecuteNonQuery() > 0;
    }
}

/// <summary>Saved plant layouts (Plant Builder drafts). <see cref="LayoutSummary.AssetCount"/> is derived from the plant.</summary>
public sealed class SqliteLayoutStore(SqliteDatabase db, TimeProvider? time = null) : ILayoutStore
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public IReadOnlyList<LayoutSummary> List()
    {
        using var c = db.OpenIfExists();
        if (c is null) return [];
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, updated_utc, asset_count FROM layouts ORDER BY updated_utc DESC, rowid DESC;";
        using var r = cmd.ExecuteReader();
        var list = new List<LayoutSummary>();
        while (r.Read()) list.Add(new LayoutSummary(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt32(3)));
        return list;
    }

    public Layout? Get(string id)
    {
        if (!StoreHelpers.IsValidId(id)) return null;
        using var c = db.OpenIfExists();
        if (c is null) return null;
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, updated_utc, plant_json FROM layouts WHERE id = $id;";
        cmd.Parameters.AddWithValue("$id", id);
        using var r = cmd.ExecuteReader();
        return r.Read()
            ? new Layout(r.GetString(0), r.GetString(1), r.GetString(2), TwinJson.Deserialize<PlantModel>(r.GetString(3)))
            : null;
    }

    public Layout Save(SaveLayoutRequest request)
    {
        var (name, plant) = StoreHelpers.Validate(request);
        var now = StoreHelpers.IsoNow(_time);
        var json = TwinJson.Serialize(plant);
        using var c = db.Open();
        var id = StoreHelpers.InsertWithNewId(newId =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = """
                INSERT INTO layouts (id, name, created_utc, updated_utc, asset_count, plant_json)
                VALUES ($id, $name, $now, $now, $count, $plant);
                """;
            Bind(cmd, newId, name, now, plant, json);
            cmd.ExecuteNonQuery();
        });
        return new Layout(id, name, now, plant);
    }

    public Layout? Update(string id, SaveLayoutRequest request)
    {
        var (name, plant) = StoreHelpers.Validate(request);
        if (!StoreHelpers.IsValidId(id)) return null;
        using var c = db.OpenIfExists();
        if (c is null) return null;
        var now = StoreHelpers.IsoNow(_time);
        using var cmd = c.CreateCommand();
        cmd.CommandText = "UPDATE layouts SET name = $name, updated_utc = $now, asset_count = $count, plant_json = $plant WHERE id = $id;";
        Bind(cmd, id, name, now, plant, TwinJson.Serialize(plant));
        return cmd.ExecuteNonQuery() > 0 ? new Layout(id, name, now, plant) : null;
    }

    public bool Delete(string id) => SqliteScenarioStore.DeleteRow(db, "layouts", id);

    private static void Bind(SqliteCommand cmd, string id, string name, string now, PlantModel plant, string json)
    {
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$name", name);
        cmd.Parameters.AddWithValue("$now", now);
        cmd.Parameters.AddWithValue("$count", StoreHelpers.AssetCount(plant));
        cmd.Parameters.AddWithValue("$plant", json);
    }
}
