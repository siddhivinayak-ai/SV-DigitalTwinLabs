using System.Globalization;
using TwinLabs.Core.Contracts;
using C = TwinLabs.Core.Validation.ValidationCodes;

namespace TwinLabs.Core.Validation;

/// <summary>
/// Structural validation of a plant model (docs/V0.3-PlantBuilder.md §3): ids, flow-graph rules, references,
/// parameter ranges per asset kind, bindings and layout warnings. Used by <c>POST /api/plant/validate</c> and
/// <c>PUT /api/plant</c>. Never throws; null lists are treated as empty. Critical issues are listed before warnings.
/// </summary>
public static class PlantValidator
{
    public static ValidationResult Validate(PlantModel? plant)
    {
        var v = new Run();
        try
        {
            v.Execute(plant);
        }
        catch (Exception ex)
        {
            // Defensive only: every rule is written not to throw.
            v.Crit(C.ValidatorError, $"Validator error: {ex.Message}");
        }
        var issues = v.Issues.Where(i => i.Severity == Severity.Critical)
            .Concat(v.Issues.Where(i => i.Severity != Severity.Critical))
            .ToList();
        return new ValidationResult(issues.All(i => i.Severity != Severity.Critical), issues);
    }

    /// <summary>True when <paramref name="id"/> is non-empty and only uses <c>A-Za-z0-9._-</c>.</summary>
    public static bool IsValidId(string? id)
    {
        if (string.IsNullOrEmpty(id)) return false;
        foreach (var ch in id)
            if (!(ch is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '.' or '_' or '-')) return false;
        return true;
    }

    private sealed class Run
    {
        public readonly List<ValidationIssue> Issues = [];

        public void Crit(string code, string message, string? assetId = null) =>
            Issues.Add(new ValidationIssue(Severity.Critical, code, message, assetId));

        private void Warn(string code, string message, string? assetId = null) =>
            Issues.Add(new ValidationIssue(Severity.Warning, code, message, assetId));

        public void Execute(PlantModel? plant)
        {
            var assets = NonNull(plant?.Assets);
            var sensors = NonNull(plant?.Sensors);
            var connections = NonNull(plant?.Connections);
            var bindings = NonNull(plant?.Bindings);
            var lines = NonNull(plant?.Lines);
            var resources = NonNull(plant?.Resources);
            var shifts = NonNull(plant?.Calendar?.Shifts);

            // ---- ids
            CheckIds("asset", assets.Select(a => ((string?)a.Id, (string?)a.Id)));
            CheckIds("sensor", sensors.Select(s => ((string?)s.Id, (string?)s.AssetId)));
            CheckIds("line", lines.Select(l => ((string?)l.Id, (string?)null)));
            CheckIds("resource", resources.Select(r => ((string?)r.Id, (string?)null)));
            CheckIds("shift", shifts.Select(s => ((string?)s.Id, (string?)null)));
            CheckIds("connection", connections.Select(c => ((string?)c.Id, (string?)null)));

            var byId = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < assets.Count; i++)
                if (assets[i].Id is { } id) byId.TryAdd(id, i);

            if (assets.Count == 0) Crit(C.EmptyPlant, "The plant has no assets");
            else CheckGraph(assets, byId);

            CheckParams(assets);
            CheckRefs(assets, sensors, lines, resources, shifts, byId);
            CheckResources(resources);
            CheckShifts(plant?.Calendar, shifts);
            CheckBindings(sensors, connections, bindings, byId);

            CheckOverlap(assets);
            CheckSensors(assets, sensors);
            CheckMeshes(assets);
        }

        private static List<T> NonNull<T>(IReadOnlyList<T?>? list) where T : class =>
            list is null ? [] : list.Where(x => x is not null).Select(x => x!).ToList();

        private void CheckIds(string what, IEnumerable<(string? Id, string? AssetId)> items)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var reported = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (id, assetId) in items)
            {
                if (!IsValidId(id))
                {
                    Crit(C.BadId, string.IsNullOrEmpty(id)
                        ? $"Empty {what} id"
                        : $"The {what} id '{id}' has characters outside A-Za-z0-9._-", string.IsNullOrEmpty(id) ? null : assetId);
                    if (string.IsNullOrEmpty(id)) continue;
                }
                if (!seen.Add(id!) && reported.Add(id!))
                    Crit(C.DuplicateId, $"The {what} id '{id}' is used more than once", assetId);
            }
        }

        // ------------------------------------------------------------ flow graph

        private void CheckGraph(List<AssetDef> assets, Dictionary<string, int> byId)
        {
            var n = assets.Count;
            var adj = new List<int>[n];
            var upstream = new List<int>?[n];

            for (var i = 0; i < n; i++)
            {
                var a = assets[i];
                adj[i] = [];
                var ds = a.Downstream ?? [];
                if (a.Kind == AssetKind.Sink && ds.Count > 0)
                    Crit(C.SinkHasDownstream, $"Sink '{a.Id}' has downstream ({string.Join(", ", ds)}); a sink must end the flow", a.Id);
                if (a.Kind != AssetKind.Sink && ds.Count == 0)
                    Crit(C.DeadEnd, $"Asset '{a.Id}' has no downstream; only sinks may end the flow", a.Id);

                foreach (var d in ds)
                {
                    if (d is not null && d == a.Id)
                    {
                        Crit(C.SelfLoop, $"Asset '{a.Id}' flows into itself", a.Id);
                        continue;
                    }
                    if (d is null || !byId.TryGetValue(d, out var j))
                    {
                        Crit(C.UnknownDownstream, $"Asset '{a.Id}' has unknown downstream '{d}'", a.Id);
                        continue;
                    }
                    if (j == i || adj[i].Contains(j)) continue; // repeated entry, or a duplicate-id alias of itself
                    adj[i].Add(j);
                    (upstream[j] ??= []).Add(i);
                }
            }

            var sources = new List<int>();
            var sinks = new List<int>();
            for (var i = 0; i < n; i++)
            {
                if (assets[i].Kind == AssetKind.Source) sources.Add(i);
                else if (assets[i].Kind == AssetKind.Sink) sinks.Add(i);
            }
            if (sources.Count == 0) Crit(C.NoSource, "The plant has no source; add at least one source asset");
            if (sinks.Count == 0) Crit(C.NoSink, "The plant has no sink; add at least one sink asset");

            foreach (var s in sources)
                if (upstream[s] is { Count: > 0 } ups)
                    Crit(C.SourceHasUpstream,
                        $"Source '{assets[s].Id}' has upstream ({string.Join(", ", ups.Select(u => assets[u].Id))}); nothing may flow into a source",
                        assets[s].Id);

            // Cycles: strongly connected components with more than one member (self-loops are reported above).
            foreach (var scc in StronglyConnected(adj))
            {
                if (scc.Count < 2) continue;
                scc.Sort();
                var ids = scc.Select(k => assets[k].Id).ToList();
                Crit(C.Cycle, $"Flow cycle between {string.Join(", ", ids)}; the flow must be acyclic", ids[0]);
            }

            // Reachability from any source (forward) and to any sink (backward).
            var fromSource = Reach(sources, n, k => adj[k]);
            var toSink = Reach(sinks, n, k => upstream[k] ?? []);
            for (var i = 0; i < n; i++)
            {
                var a = assets[i];
                // Second copies of a duplicate id are only reported as DUPLICATE_ID (edges resolve to the first copy).
                if (a.Id is null || byId[a.Id] != i) continue;
                // With no source / no sink at all, NO_SOURCE / NO_SINK already says it all.
                if (sources.Count > 0 && !fromSource[i] && a.Kind != AssetKind.Source)
                    Crit(C.Unreachable, $"Asset '{a.Id}' is not reachable from any source", a.Id);
                // A dead end is already reported as DEAD_END; don't report the same asset twice.
                if (sinks.Count > 0 && !toSink[i] && a.Kind != AssetKind.Sink && (a.Downstream?.Count ?? 0) > 0)
                    Crit(C.NoSinkReachable, $"Asset '{a.Id}' has no path to a sink", a.Id);
            }
        }

        private static bool[] Reach(List<int> starts, int n, Func<int, List<int>> next)
        {
            var seen = new bool[n];
            var stack = new Stack<int>();
            foreach (var s in starts) { seen[s] = true; stack.Push(s); }
            while (stack.Count > 0)
                foreach (var m in next(stack.Pop()))
                    if (!seen[m]) { seen[m] = true; stack.Push(m); }
            return seen;
        }

        /// <summary>Iterative Tarjan SCC (no recursion, so huge inputs cannot overflow the stack).</summary>
        private static List<List<int>> StronglyConnected(List<int>[] adj)
        {
            var n = adj.Length;
            var index = new int[n];
            var low = new int[n];
            var onStack = new bool[n];
            Array.Fill(index, -1);
            var stack = new Stack<int>();
            var result = new List<List<int>>();
            var counter = 0;
            var work = new Stack<(int Node, int Edge)>();

            for (var root = 0; root < n; root++)
            {
                if (index[root] >= 0) continue;
                work.Push((root, 0));
                while (work.Count > 0)
                {
                    var (v, e) = work.Pop();
                    if (e == 0)
                    {
                        index[v] = low[v] = counter++;
                        stack.Push(v);
                        onStack[v] = true;
                    }
                    else
                    {
                        // Returning from the child at edge e-1.
                        low[v] = Math.Min(low[v], low[adj[v][e - 1]]);
                    }

                    var descended = false;
                    for (; e < adj[v].Count; e++)
                    {
                        var w = adj[v][e];
                        if (index[w] < 0)
                        {
                            work.Push((v, e + 1));
                            work.Push((w, 0));
                            descended = true;
                            break;
                        }
                        if (onStack[w]) low[v] = Math.Min(low[v], index[w]);
                    }
                    if (descended || low[v] != index[v]) continue;

                    var comp = new List<int>();
                    int x;
                    do
                    {
                        x = stack.Pop();
                        onStack[x] = false;
                        comp.Add(x);
                    } while (x != v);
                    result.Add(comp);
                }
            }
            return result;
        }

        // ------------------------------------------------------------ params

        private void CheckParams(List<AssetDef> assets)
        {
            foreach (var a in assets)
            {
                var ps = a.Params ?? new Dictionary<string, double>();
                foreach (var key in ParamRules.Required(a.Kind))
                    if (!ps.ContainsKey(key))
                        Crit(C.MissingParam, $"{Kind(a.Kind)} '{a.Id}' needs parameter '{key}'", a.Id);
                foreach (var (key, value) in ps)
                    if (ParamRules.Check(key, value) is { } why)
                        Crit(C.BadParam, $"Asset '{a.Id}' parameter '{key}' = {Num(value)}: {why}", a.Id);
            }
        }

        // ------------------------------------------------------------ references

        private void CheckRefs(List<AssetDef> assets, List<SensorDef> sensors, List<LineDef> lines,
            List<ResourceDef> resources, List<ShiftDef> shifts, Dictionary<string, int> byId)
        {
            var lineIds = lines.Select(l => l.Id).OfType<string>().ToHashSet(StringComparer.Ordinal);
            var resIds = resources.Select(r => r.Id).OfType<string>().ToHashSet(StringComparer.Ordinal);
            var shiftIds = shifts.Select(s => s.Id).OfType<string>().ToHashSet(StringComparer.Ordinal);

            foreach (var s in sensors)
                if (s.AssetId is null || !byId.ContainsKey(s.AssetId))
                    Crit(C.UnknownRef, $"Sensor '{s.Id}' refers to unknown asset '{s.AssetId}'");

            foreach (var a in assets)
            {
                if (Present(a.LineId) && !lineIds.Contains(a.LineId!))
                    Crit(C.UnknownRef, $"Asset '{a.Id}' refers to unknown line '{a.LineId}'", a.Id);
                if (Present(a.ResourceId))
                {
                    if (!resIds.Contains(a.ResourceId!))
                        Crit(C.UnknownRef, $"Asset '{a.Id}' refers to unknown resource '{a.ResourceId}'", a.Id);
                    if (a.Kind is AssetKind.Source or AssetKind.Conveyor or AssetKind.Buffer or AssetKind.Sink)
                        Crit(C.ResourceKind, $"{Kind(a.Kind)} '{a.Id}' cannot use a resource; only machines, robots and inspections can", a.Id);
                }
                if (Present(a.ShiftId) && !shiftIds.Contains(a.ShiftId!))
                    Crit(C.UnknownRef, $"Asset '{a.Id}' refers to unknown shift '{a.ShiftId}'", a.Id);
            }
        }

        private void CheckResources(List<ResourceDef> resources)
        {
            foreach (var r in resources)
                if (r.Count < 1)
                    Crit(C.BadResourceCount, $"Resource '{r.Id}' has count {r.Count}; it needs at least 1 unit");
        }

        private void CheckShifts(CalendarDef? calendar, List<ShiftDef> shifts)
        {
            if (calendar is not null && !InDay(calendar.StartHourOfDay))
                Crit(C.BadShift, $"Calendar startHourOfDay {Num(calendar.StartHourOfDay)} is outside 0..24");
            foreach (var s in shifts)
            {
                if (!InDay(s.StartHour) || !InDay(s.EndHour))
                    Crit(C.BadShift, $"Shift '{s.Id}' hours {Num(s.StartHour)}..{Num(s.EndHour)} are outside 0..24");
                else if (s.StartHour == s.EndHour)
                    Crit(C.BadShift, $"Shift '{s.Id}' starts and ends at {Num(s.StartHour)}; the window would be empty");
            }
        }

        private static bool InDay(double h) => double.IsFinite(h) && h >= 0 && h <= 24;

        // ------------------------------------------------------------ bindings (mirrors BindingResolver.Validate)

        private void CheckBindings(List<SensorDef> sensors, List<ConnectionDef> connections,
            List<BindingDef> bindings, Dictionary<string, int> byId)
        {
            // Duplicate connection ids are reported once, as DUPLICATE_ID.
            var conns = new Dictionary<string, ConnectionDef>(StringComparer.Ordinal);
            foreach (var c in connections)
            {
                if (c.Id is not null) conns.TryAdd(c.Id, c);
                if (string.IsNullOrWhiteSpace(c.Endpoint))
                    Crit(C.BindingNoEndpoint, $"Connection '{c.Id}' has no endpoint");
            }

            var sensorAsset = new Dictionary<string, string?>(StringComparer.Ordinal);
            foreach (var s in sensors)
                if (s.Id is not null) sensorAsset.TryAdd(s.Id, s.AssetId);

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var b in bindings)
            {
                if (!TryParseTarget(b.Target, out var isSensor, out var isState, out var id))
                {
                    Crit(C.BindingBadTarget,
                        $"Bad binding target '{b.Target}' (use sensor:<id> or asset:<id>.<state|good|scrap|wip|load|wear>)");
                    continue;
                }
                var exists = isSensor ? sensorAsset.ContainsKey(id) : byId.ContainsKey(id);
                var assetId = !exists ? null : isSensor ? sensorAsset[id] : id;

                if (!seen.Add(b.Target!))
                    Crit(C.BindingDuplicateTarget, $"Target '{b.Target}' is bound more than once", assetId);
                if (!exists)
                    Crit(C.BindingUnknownTarget, $"Binding target '{b.Target}' does not exist in the plant");
                ConnectionDef? c = null;
                if (b.ConnectionId is null || !conns.TryGetValue(b.ConnectionId, out c))
                    Crit(C.BindingUnknownConnection, $"Binding '{b.Target}' uses unknown connection '{b.ConnectionId}'", assetId);
                if (string.IsNullOrWhiteSpace(b.Address))
                    Crit(C.BindingNoAddress, $"Binding '{b.Target}' has no address", assetId);
                if (b.JsonPath is not null && (c is null || c.Kind != ConnectionKind.Mqtt || !IsJsonPath(b.JsonPath)))
                    Crit(C.BindingBadJsonPath,
                        $"Binding '{b.Target}': jsonPath '{b.JsonPath}' is only valid on MQTT connections and must look like $.a.b", assetId);
                if (b.StateMap is not null && !isState)
                    Crit(C.BindingBadStateMap, $"Binding '{b.Target}': stateMap is only valid on asset:<id>.state targets", assetId);
            }
        }

        /// <summary>Same grammar as <c>BindingResolver.TryParseTarget</c>.</summary>
        private static bool TryParseTarget(string? target, out bool isSensor, out bool isState, out string id)
        {
            isSensor = isState = false;
            id = "";
            if (string.IsNullOrWhiteSpace(target)) return false;
            if (target.StartsWith("sensor:", StringComparison.Ordinal))
            {
                id = target[7..];
                isSensor = true;
                return id.Length > 0;
            }
            if (!target.StartsWith("asset:", StringComparison.Ordinal)) return false;
            var rest = target[6..];
            var dot = rest.LastIndexOf('.');
            if (dot <= 0 || dot == rest.Length - 1) return false;
            id = rest[..dot];
            var field = rest[(dot + 1)..];
            isState = field == "state";
            return field is "state" or "good" or "scrap" or "wip" or "load" or "wear";
        }

        /// <summary><c>^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$</c> (the BindingResolver regex) without a regex.</summary>
        private static bool IsJsonPath(string p)
        {
            if (p.Length < 3 || p[0] != '$') return false;
            var i = 1;
            while (i < p.Length)
            {
                if (p[i] != '.') return false;
                i++;
                if (i >= p.Length || !(char.IsAsciiLetter(p[i]) || p[i] == '_')) return false;
                i++;
                while (i < p.Length && (char.IsAsciiLetterOrDigit(p[i]) || p[i] == '_')) i++;
            }
            return true;
        }

        // ------------------------------------------------------------ warnings

        private void CheckOverlap(List<AssetDef> assets)
        {
            var boxes = new List<(AssetDef A, double X, double Z, double Ex, double Ez)>(assets.Count);
            foreach (var a in assets)
            {
                if (a.Position is null || a.Size is null) continue;
                var (ex, ez) = HalfExtents(a.Size.X / 2, a.Size.Z / 2, a.RotationY);
                if (!double.IsFinite(ex) || !double.IsFinite(ez) || ex <= 0 || ez <= 0) continue;
                if (!double.IsFinite(a.Position.X) || !double.IsFinite(a.Position.Z)) continue;
                boxes.Add((a, a.Position.X, a.Position.Z, ex, ez));
            }

            const double eps = 1e-6; // footprints that only touch do not overlap
            for (var i = 0; i < boxes.Count; i++)
                for (var j = i + 1; j < boxes.Count; j++)
                {
                    var (a, ax, az, aex, aez) = boxes[i];
                    var (b, bx, bz, bex, bez) = boxes[j];
                    if (Math.Abs(ax - bx) < aex + bex - eps && Math.Abs(az - bz) < aez + bez - eps)
                        Warn(C.Overlap, $"Assets '{a.Id}' and '{b.Id}' overlap on the floor plan", a.Id);
                }
        }

        /// <summary>Axis-aligned half extents after rotating about Y. Quarter turns swap X/Z; other angles use the bounding box.</summary>
        private static (double Ex, double Ez) HalfExtents(double hx, double hz, double rotationY)
        {
            hx = Math.Abs(hx);
            hz = Math.Abs(hz);
            if (!double.IsFinite(rotationY)) return (hx, hz);
            var r = rotationY % 360;
            if (r < 0) r += 360;
            if (r is 0 or 180) return (hx, hz);
            if (r is 90 or 270) return (hz, hx);
            var rad = r * Math.PI / 180;
            var c = Math.Abs(Math.Cos(rad));
            var s = Math.Abs(Math.Sin(rad));
            return (c * hx + s * hz, s * hx + c * hz);
        }

        private void CheckSensors(List<AssetDef> assets, List<SensorDef> sensors)
        {
            var withSensors = new HashSet<string>(StringComparer.Ordinal);
            foreach (var s in sensors)
            {
                if (s.AssetId is not null) withSensors.Add(s.AssetId);
                if (s.Hi is { } hi && s.HiHi is { } hiHi && hiHi <= hi)
                    Warn(C.LimitOrder, $"Sensor '{s.Id}' has hiHi {Num(hiHi)} <= hi {Num(hi)}", s.AssetId);
            }
            foreach (var a in assets)
                if (a.Kind is AssetKind.Machine or AssetKind.Robot or AssetKind.Inspection && a.Id is not null && !withSensors.Contains(a.Id))
                    Warn(C.NoSensors, $"{Kind(a.Kind)} '{a.Id}' has no sensors", a.Id);
        }

        private void CheckMeshes(List<AssetDef> assets)
        {
            foreach (var a in assets)
                if (!string.IsNullOrEmpty(a.Mesh) && !a.Mesh.StartsWith("/api/meshes/", StringComparison.Ordinal))
                    Warn(C.MeshUrl, $"Asset '{a.Id}' mesh '{a.Mesh}' should be a /api/meshes/... URL", a.Id);
        }

        private static bool Present(string? s) => !string.IsNullOrWhiteSpace(s);

        private static string Kind(AssetKind k) => k switch
        {
            AssetKind.Source => "Source",
            AssetKind.Conveyor => "Conveyor",
            AssetKind.Machine => "Machine",
            AssetKind.Buffer => "Buffer",
            AssetKind.Robot => "Robot",
            AssetKind.Inspection => "Inspection",
            AssetKind.Sink => "Sink",
            _ => "Asset",
        };

        private static string Num(double v) => v.ToString("0.###", CultureInfo.InvariantCulture);
    }
}
