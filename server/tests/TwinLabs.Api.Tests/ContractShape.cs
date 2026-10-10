using System.Text.Json.Nodes;

namespace TwinLabs.Api.Tests;

/// <summary>Compares JSON produced by the API with the documented examples in contracts/examples.</summary>
public static class ContractShape
{
    // Free-form maps whose keys are data, not field names.
    private static readonly HashSet<string> MapProperties = ["params"];

    public static string ContractsDir
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts", "examples")))
                dir = dir.Parent;
            return Path.Combine(dir?.FullName ?? throw new DirectoryNotFoundException("contracts/"), "contracts");
        }
    }

    public static JsonNode Example(string file) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(ContractsDir, "examples", file)))!;

    /// <summary>
    /// <c>snapshot.json</c> data plus <c>connections[]</c> (shaped like <c>connection.json</c>). The v0.2 contract
    /// documents <c>snapshot.connections[]</c> but the frozen example does not show it.
    /// </summary>
    public static JsonNode SnapshotDataExample()
    {
        var data = Example("snapshot.json")["data"]!.DeepClone();
        data["connections"] = new JsonArray(ConnectionDataExample());
        return data;
    }

    /// <summary>
    /// <c>connection.json</c> data plus <c>error</c>: <see cref="TwinLabs.Core.Contracts.ConnectionStatus.Error"/> and
    /// docs/V0.2-ConnectedTwin.md §4 define it, but the frozen example omits it.
    /// </summary>
    public static JsonNode ConnectionDataExample()
    {
        var data = Example("connection.json")["data"]!.DeepClone();
        data["error"] = "connect failed";
        return data;
    }

    /// <summary>
    /// Every property name in <paramref name="actual"/> must also appear (at the same path) in
    /// <paramref name="example"/>. Catches casing / naming drift without requiring optional fields.
    /// </summary>
    public static void AssertKnownFields(JsonNode? example, JsonNode? actual, string path = "$")
    {
        if (example is null || actual is null) return;
        switch (actual)
        {
            case JsonObject a when example is JsonObject e:
                foreach (var (key, value) in a)
                {
                    Assert.True(e.ContainsKey(key), $"{path}.{key} is not a documented field (documented: {string.Join(", ", e.Select(p => p.Key))})");
                    if (!MapProperties.Contains(key)) AssertKnownFields(e[key], value, $"{path}.{key}");
                }
                break;
            case JsonArray a when example is JsonArray e && e.Count > 0:
                // Union the documented elements so optional fields seen in any example element count.
                var merged = e[0] is JsonObject ? Merge(e) : e[0];
                foreach (var item in a) AssertKnownFields(merged, item, $"{path}[]");
                break;
        }
    }

    /// <summary>Both objects have exactly the same property names.</summary>
    public static void AssertSameFields(JsonNode? example, JsonNode? actual, string what)
    {
        var e = example!.AsObject().Select(p => p.Key).Order().ToArray();
        var a = actual!.AsObject().Select(p => p.Key).Order().ToArray();
        Assert.True(e.SequenceEqual(a), $"{what}: expected fields [{string.Join(", ", e)}] but got [{string.Join(", ", a)}]");
    }

    private static JsonObject Merge(JsonArray items)
    {
        var merged = new JsonObject();
        foreach (var item in items.OfType<JsonObject>())
            foreach (var (k, v) in item)
                if (!merged.ContainsKey(k)) merged[k] = v?.DeepClone();
        return merged;
    }
}
