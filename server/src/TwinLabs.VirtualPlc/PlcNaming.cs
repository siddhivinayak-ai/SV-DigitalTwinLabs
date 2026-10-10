using System.Text;

namespace TwinLabs.VirtualPlc;

/// <summary>
/// Node-id naming from docs/V0.2-ImplementationContract.md: <c>ns=2;s=&lt;LineId&gt;.&lt;AssetId&gt;.&lt;Name&gt;</c>.
/// </summary>
public static class PlcNaming
{
    /// <summary>Namespace URI registered as the first custom namespace (index 2).</summary>
    public const string NamespaceUri = "urn:twinlabs:virtualplc";

    public const string RootName = "TwinLabs";

    public static readonly string[] AssetVariables = ["State", "Good", "Scrap", "Wip", "Load", "Wear"];

    private static readonly Dictionary<string, string> SensorNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["temp"] = "Temp",
        ["vib"] = "Vib",
        ["power"] = "Power",
        ["current"] = "Current",
        ["speed"] = "Speed",
        ["level"] = "Level",
        ["rejects"] = "Rejects",
        ["good"] = "Good",
    };

    /// <summary>Plant id to PascalCase, split on <c>-</c>/<c>_</c>, trailing <c>-connected</c> dropped (<c>line-a-connected</c> → <c>LineA</c>).</summary>
    public static string LineId(string plantId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(plantId);
        var id = plantId.Trim();
        const string suffix = "-connected";
        if (id.Length > suffix.Length && id.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            id = id[..^suffix.Length];
        var sb = new StringBuilder(id.Length);
        foreach (var part in id.Split(['-', '_'], StringSplitOptions.RemoveEmptyEntries))
            sb.Append(char.ToUpperInvariant(part[0])).Append(part, 1, part.Length - 1);
        return sb.Length > 0 ? sb.ToString() : plantId;
    }

    /// <summary>Sensor suffix to variable name (<c>temp</c> → <c>Temp</c>); unknown suffixes are capitalised.</summary>
    public static string SensorName(string suffix)
    {
        if (SensorNames.TryGetValue(suffix, out var n)) return n;
        return suffix.Length == 0 ? suffix : char.ToUpperInvariant(suffix[0]) + suffix[1..];
    }

    /// <summary>Suffix of a sensor id (<c>CNC-01.temp</c> → <c>temp</c>), given its asset id.</summary>
    public static string SensorSuffix(string sensorId, string assetId)
    {
        if (sensorId.StartsWith(assetId + ".", StringComparison.Ordinal)) return sensorId[(assetId.Length + 1)..];
        var dot = sensorId.LastIndexOf('.');
        return dot >= 0 ? sensorId[(dot + 1)..] : sensorId;
    }

    /// <summary>String identifier (without <c>ns=2;s=</c>).</summary>
    public static string VariableId(string lineId, string assetId, string name) => $"{lineId}.{assetId}.{name}";

    /// <summary>Full node id text, e.g. <c>ns=2;s=LineA.CNC-01.Temp</c>.</summary>
    public static string NodeIdText(string lineId, string assetId, string name) => $"ns=2;s={VariableId(lineId, assetId, name)}";
}
