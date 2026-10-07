using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace TwinLabs.Connect.Mqtt;

/// <summary>
/// Turns an MQTT payload into a number.
/// <list type="bullet">
/// <item>With a jsonPath (<c>$.a.b</c> subset): the payload must be a JSON object; the path's value must be a JSON number,
/// <c>true</c>/<c>false</c> (1/0) or a numeric string.</item>
/// <item>Without: the payload is a plain number (<c>42.5</c>, which is also a JSON number) or <c>true</c>/<c>false</c>.</item>
/// </list>
/// Anything else (and NaN/Infinity) is rejected.
/// </summary>
public static class MqttPayload
{
    public static bool TryParsePlain(string text, out double value)
    {
        var s = text.Trim();
        if (s.Equals("true", StringComparison.OrdinalIgnoreCase)) { value = 1; return true; }
        if (s.Equals("false", StringComparison.OrdinalIgnoreCase)) { value = 0; return true; }
        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value) && double.IsFinite(value);
    }

    /// <summary>Splits <c>$.a.b</c> into <c>["a","b"]</c>; null when the path is not in the supported subset.</summary>
    public static string[]? ParsePath(string jsonPath)
    {
        if (string.IsNullOrWhiteSpace(jsonPath) || !jsonPath.StartsWith("$.", StringComparison.Ordinal)) return null;
        var parts = jsonPath[2..].Split('.');
        return parts.Any(p => p.Length == 0) ? null : parts;
    }

    public static bool TryEvaluate(JsonElement root, string[] path, out double value)
    {
        value = 0;
        var cur = root;
        foreach (var seg in path)
        {
            if (cur.ValueKind != JsonValueKind.Object || !cur.TryGetProperty(seg, out cur)) return false;
        }
        switch (cur.ValueKind)
        {
            case JsonValueKind.Number:
                return cur.TryGetDouble(out value) && double.IsFinite(value);
            case JsonValueKind.True: value = 1; return true;
            case JsonValueKind.False: value = 0; return true;
            case JsonValueKind.String:
                return TryParsePlain(cur.GetString() ?? "", out value);
            default: return false;
        }
    }

    /// <summary>Parse a payload; <paramref name="path"/> null = plain number.</summary>
    public static bool TryParse(ReadOnlySequence<byte> payload, string[]? path, out double value)
    {
        value = 0;
        if (payload.Length == 0 || payload.Length > 1 << 20) return false;
        if (path is null) return TryParsePlain(Encoding.UTF8.GetString(payload), out value);
        try
        {
            var reader = new Utf8JsonReader(payload);
            using var doc = JsonDocument.ParseValue(ref reader);
            return TryEvaluate(doc.RootElement, path, out value);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    public static bool TryParse(string payload, string? jsonPath, out double value)
    {
        string[]? path = null;
        if (jsonPath is not null && (path = ParsePath(jsonPath)) is null) { value = 0; return false; }
        return TryParse(new ReadOnlySequence<byte>(Encoding.UTF8.GetBytes(payload)), path, out value);
    }
}

/// <summary><c>mqtt://host:port</c>, <c>tcp://host:port</c> (default 1883) or <c>mqtts://host:port</c> (TLS, default 8883).</summary>
public sealed record MqttEndpoint(string Host, int Port, bool Tls)
{
    public static bool TryParse(string? endpoint, out MqttEndpoint result, out string? error)
    {
        result = new("localhost", 1883, false);
        error = null;
        if (string.IsNullOrWhiteSpace(endpoint) || !Uri.TryCreate(endpoint.Trim(), UriKind.Absolute, out var uri))
        {
            error = $"Invalid MQTT endpoint '{endpoint}' (expected mqtt://host:port)";
            return false;
        }
        var scheme = uri.Scheme.ToLowerInvariant();
        bool tls;
        switch (scheme)
        {
            case "mqtt" or "tcp": tls = false; break;
            case "mqtts" or "ssl" or "tls": tls = true; break;
            default:
                error = $"Unsupported MQTT scheme '{uri.Scheme}' (use mqtt://, tcp:// or mqtts://)";
                return false;
        }
        if (string.IsNullOrEmpty(uri.Host)) { error = $"MQTT endpoint '{endpoint}' has no host"; return false; }
        var port = uri.IsDefaultPort || uri.Port <= 0 ? (tls ? 8883 : 1883) : uri.Port;
        result = new(uri.Host, port, tls);
        return true;
    }
}
