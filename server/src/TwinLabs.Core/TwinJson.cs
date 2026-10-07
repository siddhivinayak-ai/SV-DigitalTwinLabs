using System.Text.Json;
using System.Text.Json.Serialization;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Core;

/// <summary>The one JSON configuration for every wire payload (WS, REST, plant files).</summary>
public static class TwinJson
{
    public static readonly JsonSerializerOptions Options = Configure(new JsonSerializerOptions());

    public static JsonSerializerOptions Configure(JsonSerializerOptions o)
    {
        o.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.PropertyNameCaseInsensitive = true;
        o.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        o.NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals;
        o.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return o;
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T Deserialize<T>(string json) =>
        JsonSerializer.Deserialize<T>(json, Options) ?? throw new JsonException($"Null {typeof(T).Name}");

    public static PlantModel LoadPlant(string path) => Deserialize<PlantModel>(File.ReadAllText(path));
}
