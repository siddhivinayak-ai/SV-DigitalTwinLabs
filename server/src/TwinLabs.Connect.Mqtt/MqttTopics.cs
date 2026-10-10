using System.Globalization;
using System.Text;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt;

/// <summary>
/// The MQTT topic rule shared by <see cref="MqttSimPublisher"/> and <c>contracts/plant/sample_line.mqtt.json</c>.
/// <para>
/// Topic = <c>&lt;lineId-lowercase&gt;/&lt;assetId&gt;/&lt;name-lowercase&gt;</c>, e.g. <c>linea/CNC-01/temp</c>.
/// </para>
/// <list type="bullet">
/// <item><c>lineId</c>: the plant id with a trailing <c>-connected</c> dropped, split on <c>-</c> and <c>_</c>, each part
/// PascalCased (<c>line-a</c> and <c>line-a-connected</c> → <c>LineA</c>), then lowercased (<c>linea</c>).</item>
/// <item><c>assetId</c>: verbatim, case preserved (<c>CNC-01</c>).</item>
/// <item><c>name</c> for assets: <c>state, good, scrap, wip, load, wear</c>; for sensors: the sensor id suffix after the
/// last <c>.</c> mapped by the contract table (temp, vib, power, current, speed, level, rejects, good) and lowercased.
/// A sensor's asset is its <see cref="SensorDef.AssetId"/>.</item>
/// </list>
/// Payload: <c>{"value":&lt;number&gt;,"t":&lt;simMs&gt;}</c>; state is an integer in enum order (off=0 … maintenance=6).
/// </summary>
public static class MqttTopics
{
    public static readonly IReadOnlyList<string> AssetNames = ["state", "good", "scrap", "wip", "load", "wear"];

    private static readonly Dictionary<string, string> SensorSuffixNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["temp"] = "Temp", ["vib"] = "Vib", ["power"] = "Power", ["current"] = "Current",
        ["speed"] = "Speed", ["level"] = "Level", ["rejects"] = "Rejects", ["good"] = "Good",
    };

    /// <summary>PascalCase LineId per the contract (<c>line-a-connected</c> → <c>LineA</c>).</summary>
    public static string LineId(string plantId)
    {
        var id = plantId ?? "";
        if (id.EndsWith("-connected", StringComparison.OrdinalIgnoreCase)) id = id[..^"-connected".Length];
        var sb = new StringBuilder(id.Length);
        foreach (var part in id.Split(['-', '_'], StringSplitOptions.RemoveEmptyEntries))
            sb.Append(char.ToUpperInvariant(part[0])).Append(part, 1, part.Length - 1);
        return sb.ToString();
    }

    /// <summary>First topic level: <see cref="LineId"/> lowercased.</summary>
    public static string LinePrefix(string plantId) => LineId(plantId).ToLowerInvariant();

    /// <summary>Contract name for a sensor suffix (<c>temp</c> → <c>Temp</c>); unknown suffixes are PascalCased as-is.</summary>
    public static string SensorName(string sensorId)
    {
        var dot = sensorId.LastIndexOf('.');
        var suffix = dot >= 0 ? sensorId[(dot + 1)..] : sensorId;
        if (SensorSuffixNames.TryGetValue(suffix, out var n)) return n;
        return suffix.Length == 0 ? suffix : char.ToUpperInvariant(suffix[0]) + suffix[1..];
    }

    public static string AssetTopic(string plantId, string assetId, string field) =>
        $"{LinePrefix(plantId)}/{assetId}/{field.ToLowerInvariant()}";

    public static string SensorTopic(string plantId, SensorDef sensor) =>
        $"{LinePrefix(plantId)}/{sensor.AssetId}/{SensorName(sensor.Id).ToLowerInvariant()}";

    /// <summary>Sensor topic when only the sensor id is known (<c>CNC-01.temp</c>): asset = the part before the last dot.</summary>
    public static string SensorTopic(string plantId, string sensorId)
    {
        var dot = sensorId.LastIndexOf('.');
        var asset = dot > 0 ? sensorId[..dot] : sensorId;
        return $"{LinePrefix(plantId)}/{asset}/{SensorName(sensorId).ToLowerInvariant()}";
    }

    /// <summary><c>{"value":x,"t":simMs}</c> with invariant, round-trippable number formatting.</summary>
    public static string Payload(double value, long simTimeMs) =>
        "{\"value\":" + value.ToString("R", CultureInfo.InvariantCulture) + ",\"t\":" +
        simTimeMs.ToString(CultureInfo.InvariantCulture) + "}";

    public static string Payload(long value, long simTimeMs) =>
        "{\"value\":" + value.ToString(CultureInfo.InvariantCulture) + ",\"t\":" +
        simTimeMs.ToString(CultureInfo.InvariantCulture) + "}";
}
