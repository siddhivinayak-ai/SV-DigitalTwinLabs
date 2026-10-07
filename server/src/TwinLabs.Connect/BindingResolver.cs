using System.Globalization;
using System.Text.RegularExpressions;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect;

public enum TargetKind { Sensor, AssetState, AssetGood, AssetScrap, AssetWip, AssetLoad, AssetWear }

/// <summary>A tag update translated into a twin value. <see cref="State"/> is set for <see cref="TargetKind.AssetState"/>.</summary>
public readonly record struct ResolvedUpdate(TargetKind Kind, string Id, double Value, AssetStateKind? State, long WallTimeMs);

/// <summary>
/// Shared by every tag source and by shadow mode: validates a plant's connections/bindings and turns raw
/// <see cref="TagUpdate"/>s into <see cref="ResolvedUpdate"/>s (scale/offset/stateMap applied).
/// Several bindings may use the same (connection, address); each target may be bound once.
/// </summary>
public sealed class BindingResolver
{
    private sealed record Parsed(BindingDef Def, TargetKind Kind, string Id);

    private static readonly Regex JsonPathRx = new(@"^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$", RegexOptions.Compiled);
    private readonly Dictionary<(string Conn, string Addr), List<Parsed>> _index = new();
    private readonly Dictionary<string, List<BindingDef>> _byConnection = new(StringComparer.Ordinal);

    public BindingResolver(PlantModel plant)
    {
        foreach (var b in plant.Bindings ?? [])
        {
            if (!TryParseTarget(b.Target, out var kind, out var id)) continue;
            var key = (b.ConnectionId, b.Address);
            if (!_index.TryGetValue(key, out var list)) _index[key] = list = [];
            list.Add(new Parsed(b, kind, id));
            if (!_byConnection.TryGetValue(b.ConnectionId, out var bl)) _byConnection[b.ConnectionId] = bl = [];
            bl.Add(b);
        }
    }

    public int BindingCount => _byConnection.Values.Sum(l => l.Count);

    public IReadOnlyList<BindingDef> BindingsFor(string connectionId) =>
        _byConnection.TryGetValue(connectionId, out var l) ? l : [];

    public IReadOnlyList<ResolvedUpdate> Resolve(TagUpdate u)
    {
        if (!_index.TryGetValue((u.ConnectionId, u.Address), out var list) || !double.IsFinite(u.Value)) return [];
        var res = new List<ResolvedUpdate>(list.Count);
        foreach (var p in list)
        {
            if (p.Kind == TargetKind.AssetState)
            {
                if (TryMapState(p.Def, u.Value, out var st)) res.Add(new(p.Kind, p.Id, u.Value, st, u.WallTimeMs));
                continue;
            }
            var v = u.Value * (p.Def.Scale ?? 1.0) + (p.Def.Offset ?? 0.0);
            res.Add(new(p.Kind, p.Id, v, null, u.WallTimeMs));
        }
        return res;
    }

    public static bool TryMapState(BindingDef b, double raw, out AssetStateKind state)
    {
        var r = (long)Math.Round(raw);
        if (b.StateMap is { Count: > 0 } map)
            return map.TryGetValue(r.ToString(CultureInfo.InvariantCulture), out state);
        if (r is >= 0 and <= 6) { state = (AssetStateKind)r; return true; }
        state = default;
        return false;
    }

    /// <summary>Parses <c>sensor:ID</c> or <c>asset:ID.field</c> (field = state|good|scrap|wip|load|wear).</summary>
    public static bool TryParseTarget(string? target, out TargetKind kind, out string id)
    {
        kind = default; id = "";
        if (string.IsNullOrWhiteSpace(target)) return false;
        if (target.StartsWith("sensor:", StringComparison.Ordinal))
        {
            id = target[7..];
            kind = TargetKind.Sensor;
            return id.Length > 0;
        }
        if (!target.StartsWith("asset:", StringComparison.Ordinal)) return false;
        var rest = target[6..];
        var dot = rest.LastIndexOf('.');
        if (dot <= 0 || dot == rest.Length - 1) return false;
        id = rest[..dot];
        switch (rest[(dot + 1)..])
        {
            case "state": kind = TargetKind.AssetState; return true;
            case "good": kind = TargetKind.AssetGood; return true;
            case "scrap": kind = TargetKind.AssetScrap; return true;
            case "wip": kind = TargetKind.AssetWip; return true;
            case "load": kind = TargetKind.AssetLoad; return true;
            case "wear": kind = TargetKind.AssetWear; return true;
            default: return false;
        }
    }

    /// <summary>Human-readable problems with the plant's connections and bindings; empty = valid.</summary>
    public static IReadOnlyList<string> Validate(PlantModel plant)
    {
        var errors = new List<string>();
        var conns = new Dictionary<string, ConnectionDef>(StringComparer.Ordinal);
        foreach (var c in plant.Connections ?? [])
        {
            if (!conns.TryAdd(c.Id, c)) errors.Add($"Duplicate connection id '{c.Id}'");
            if (string.IsNullOrWhiteSpace(c.Endpoint)) errors.Add($"Connection '{c.Id}' has no endpoint");
        }
        var assets = plant.Assets.Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
        var sensors = plant.Sensors.Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var b in plant.Bindings ?? [])
        {
            if (!TryParseTarget(b.Target, out var kind, out var id))
            {
                errors.Add($"Bad binding target '{b.Target}' (use sensor:<id> or asset:<id>.<state|good|scrap|wip|load|wear>)");
                continue;
            }
            if (!seen.Add(b.Target)) errors.Add($"Target '{b.Target}' is bound more than once");
            if (kind == TargetKind.Sensor ? !sensors.Contains(id) : !assets.Contains(id))
                errors.Add($"Binding target '{b.Target}' does not exist in the plant");
            if (!conns.TryGetValue(b.ConnectionId, out var c)) errors.Add($"Binding '{b.Target}' uses unknown connection '{b.ConnectionId}'");
            if (string.IsNullOrWhiteSpace(b.Address)) errors.Add($"Binding '{b.Target}' has no address");
            if (b.JsonPath is not null && (c is null || c.Kind != ConnectionKind.Mqtt || !JsonPathRx.IsMatch(b.JsonPath)))
                errors.Add($"Binding '{b.Target}': jsonPath '{b.JsonPath}' is only valid on MQTT connections and must look like $.a.b");
            if (b.StateMap is not null && kind != TargetKind.AssetState)
                errors.Add($"Binding '{b.Target}': stateMap is only valid on asset:<id>.state targets");
        }
        return errors;
    }
}
