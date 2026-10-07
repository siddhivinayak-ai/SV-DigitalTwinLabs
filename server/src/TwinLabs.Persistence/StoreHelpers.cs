using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence;

/// <summary>Ids, timestamps and request validation shared by the SQLite and in-memory stores.</summary>
internal static class StoreHelpers
{
    public const int IdLength = 8;
    public const int MaxNameLength = 200;
    private const int SqliteConstraint = 19;

    /// <summary>Short random lowercase hex id (8 chars = 32 bits).</summary>
    public static string NewId() => RandomNumberGenerator.GetHexString(IdLength, lowercase: true);

    /// <summary>True for ids this package could have generated; guards file paths and queries.</summary>
    public static bool IsValidId(string? id) =>
        id is { Length: > 0 and <= 32 } && id.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    /// <summary>ISO-8601 UTC, second precision, e.g. <c>2026-10-07T09:30:00Z</c> (same shape as the contract examples).</summary>
    public static string IsoNow(TimeProvider time) =>
        time.GetUtcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    public static string EnumText<T>(T value) where T : struct, Enum => JsonNamingPolicy.CamelCase.ConvertName(value.ToString());

    public static string ValidName(string? name)
    {
        var n = name?.Trim();
        if (string.IsNullOrEmpty(n)) throw new ArgumentException("Name must not be empty.", nameof(name));
        if (n.Length > MaxNameLength) throw new ArgumentException($"Name must be at most {MaxNameLength} characters.", nameof(name));
        return n;
    }

    public static (string Name, WhatIfRequest Request) Validate(SaveScenarioRequest? req)
    {
        if (req is null) throw new ArgumentException("Body is required.");
        var name = ValidName(req.Name);
        if (req.Request is null) throw new ArgumentException("request is required.");
        if (!(req.Request.DurationS > 0) || double.IsInfinity(req.Request.DurationS))
            throw new ArgumentException("request.durationS must be a positive number.");
        return (name, req.Request with { Overrides = req.Request.Overrides ?? [] });
    }

    public static (string Name, PlantModel Plant) Validate(SaveLayoutRequest? req)
    {
        if (req is null) throw new ArgumentException("Body is required.");
        var name = ValidName(req.Name);
        if (req.Plant is null) throw new ArgumentException("plant is required.");
        return (name, req.Plant);
    }

    public static int AssetCount(PlantModel plant) => plant.Assets?.Count ?? 0;

    public static void ValidLimit(int limit)
    {
        if (limit < 1) throw new ArgumentOutOfRangeException(nameof(limit), limit, "limit must be at least 1.");
    }

    public static string MeshUrl(string id) => $"/api/meshes/{id}/file";

    /// <summary>Runs <paramref name="insert"/> with fresh ids until it does not collide with an existing primary key.</summary>
    public static string InsertWithNewId(Action<string> insert)
    {
        for (var attempt = 0; ; attempt++)
        {
            var id = NewId();
            try
            {
                insert(id);
                return id;
            }
            catch (SqliteException ex) when (ex.SqliteErrorCode == SqliteConstraint && attempt < 8)
            {
                // id collision, try another
            }
        }
    }
}
