using Opc.Ua;
using Opc.Ua.Server;
using TwinLabs.Core.Contracts;

namespace TwinLabs.VirtualPlc;

/// <summary>Line commands exposed as OPC UA Methods (standalone mode only).</summary>
internal interface IPlcCommands
{
    ServiceResult Start();
    ServiceResult Pause();
    ServiceResult SetSpeed(double speed);
    ServiceResult InjectFault(string assetId, double durationS);
    ServiceResult ClearFault(string assetId);
}

/// <summary>
/// Address space <c>Objects/TwinLabs/&lt;LineId&gt;/&lt;AssetId&gt;/{State, Good, Scrap, Wip, Load, Wear, sensors…}</c>.
/// Values are updated in place (<see cref="Write"/>) followed by <c>ClearChangeMasks</c>.
/// </summary>
internal sealed class PlcNodeManager : CustomNodeManager2
{
    private sealed class AssetVars
    {
        public required BaseDataVariableState State, Good, Scrap, Wip, Load, Wear;
    }

    private readonly PlantModel _plant;
    private readonly IPlcCommands? _commands;
    private readonly Dictionary<string, AssetVars> _assets = new(StringComparer.Ordinal);
    private readonly Dictionary<string, BaseDataVariableState> _sensors = new(StringComparer.Ordinal);
    private BaseDataVariableState? _simTime, _running, _speed;

    public string LineId { get; }

    public PlcNodeManager(IServerInternal server, ApplicationConfiguration configuration, PlantModel plant, IPlcCommands? commands)
        : base(server, configuration, PlcNaming.NamespaceUri)
    {
        _plant = plant;
        _commands = commands;
        LineId = PlcNaming.LineId(plant.Id);
    }

    public override void CreateAddressSpace(IDictionary<NodeId, IList<IReference>> externalReferences)
    {
        lock (Lock)
        {
            if (!externalReferences.TryGetValue(ObjectIds.ObjectsFolder, out var refs))
                externalReferences[ObjectIds.ObjectsFolder] = refs = new List<IReference>();

            var root = new FolderState(null)
            {
                SymbolicName = PlcNaming.RootName,
                ReferenceTypeId = ReferenceTypeIds.Organizes,
                TypeDefinitionId = ObjectTypeIds.FolderType,
                NodeId = new NodeId(PlcNaming.RootName, NamespaceIndex),
                BrowseName = new QualifiedName(PlcNaming.RootName, NamespaceIndex),
                DisplayName = new LocalizedText(PlcNaming.RootName),
                EventNotifier = EventNotifiers.None,
            };
            root.AddReference(ReferenceTypeIds.Organizes, true, ObjectIds.ObjectsFolder);
            refs.Add(new NodeStateReference(ReferenceTypeIds.Organizes, false, root.NodeId));

            var line = Obj(root, LineId, LineId, ReferenceTypeIds.Organizes);
            line.Description = new LocalizedText(_plant.Name);
            _simTime = Var(line, $"{LineId}.SimTimeMs", "SimTimeMs", DataTypeIds.Int64, 0L);
            if (_commands is not null)
            {
                _running = Var(line, $"{LineId}.Running", "Running", DataTypeIds.Boolean, false);
                _speed = Var(line, $"{LineId}.Speed", "Speed", DataTypeIds.Double, 0.0);
                AddMethods(line);
            }

            foreach (var a in _plant.Assets)
            {
                var obj = Obj(line, $"{LineId}.{a.Id}", a.Id, ReferenceTypeIds.Organizes);
                obj.Description = new LocalizedText(a.Name);
                string Id(string n) => PlcNaming.VariableId(LineId, a.Id, n);
                _assets[a.Id] = new AssetVars
                {
                    State = Var(obj, Id("State"), "State", DataTypeIds.Int32, 0),
                    Good = Var(obj, Id("Good"), "Good", DataTypeIds.Double, 0.0),
                    Scrap = Var(obj, Id("Scrap"), "Scrap", DataTypeIds.Double, 0.0),
                    Wip = Var(obj, Id("Wip"), "Wip", DataTypeIds.Double, 0.0),
                    Load = Var(obj, Id("Load"), "Load", DataTypeIds.Double, 0.0),
                    Wear = Var(obj, Id("Wear"), "Wear", DataTypeIds.Double, 0.0),
                };
                foreach (var s in _plant.Sensors.Where(s => s.AssetId == a.Id))
                {
                    var name = PlcNaming.SensorName(PlcNaming.SensorSuffix(s.Id, a.Id));
                    // Several bindings may share one address (the sink's Good is both a sensor and an asset counter).
                    var existing = obj.FindChild(SystemContext, new QualifiedName(name, NamespaceIndex)) as BaseDataVariableState;
                    var v = existing ?? Var(obj, Id(name), name, DataTypeIds.Double, 0.0);
                    if (existing is null && !string.IsNullOrEmpty(s.Unit))
                        v.Description = new LocalizedText(s.Unit);
                    _sensors[s.Id] = v;
                }
            }

            AddPredefinedNode(SystemContext, root);
        }
    }

    private void AddMethods(NodeState line)
    {
        var c = _commands!;
        Method(line, "Start", [], _ => c.Start());
        Method(line, "Pause", [], _ => c.Pause());
        Method(line, "SetSpeed", [Arg("speed", DataTypeIds.Double, "Sim speed multiplier (> 0)")],
            a => a[0] is double d ? c.SetSpeed(d) : new ServiceResult(StatusCodes.BadTypeMismatch));
        Method(line, "InjectFault",
            [Arg("assetId", DataTypeIds.String, "Asset id, e.g. CNC-01"), Arg("durationS", DataTypeIds.Double, "Repair time in sim seconds; 0 = draw from MTTR")],
            a => a[0] is string id && a[1] is double d ? c.InjectFault(id, d) : new ServiceResult(StatusCodes.BadTypeMismatch));
        Method(line, "ClearFault", [Arg("assetId", DataTypeIds.String, "Asset id")],
            a => a[0] is string id ? c.ClearFault(id) : new ServiceResult(StatusCodes.BadTypeMismatch));
    }

    private static Argument Arg(string name, NodeId type, string description) =>
        new() { Name = name, DataType = type, ValueRank = ValueRanks.Scalar, Description = new LocalizedText(description) };

    private void Method(NodeState parent, string name, Argument[] inputs, Func<IList<object>, ServiceResult> handler)
    {
        var id = $"{LineId}.{name}";
        var m = new MethodState(parent)
        {
            SymbolicName = name,
            ReferenceTypeId = ReferenceTypeIds.HasComponent,
            NodeId = new NodeId(id, NamespaceIndex),
            BrowseName = new QualifiedName(name, NamespaceIndex),
            DisplayName = new LocalizedText(name),
            Executable = true,
            UserExecutable = true,
        };
        if (inputs.Length > 0)
        {
            m.InputArguments = new PropertyState<Argument[]>(m)
            {
                NodeId = new NodeId(id + ".InputArguments", NamespaceIndex),
                BrowseName = BrowseNames.InputArguments,
                DisplayName = new LocalizedText(BrowseNames.InputArguments),
                TypeDefinitionId = VariableTypeIds.PropertyType,
                ReferenceTypeId = ReferenceTypeIds.HasProperty,
                DataType = DataTypeIds.Argument,
                ValueRank = ValueRanks.OneDimension,
                Value = inputs,
            };
        }
        m.OnCallMethod = (_, _, input, _) =>
        {
            if (input.Count != inputs.Length) return new ServiceResult(StatusCodes.BadArgumentsMissing);
            try { return handler(input); }
            catch (Exception ex) { return new ServiceResult(StatusCodes.BadInternalError, new LocalizedText(ex.Message)); }
        };
        parent.AddChild(m);
    }

    private BaseObjectState Obj(NodeState parent, string id, string name, NodeId referenceType)
    {
        var o = new BaseObjectState(parent)
        {
            SymbolicName = name,
            ReferenceTypeId = referenceType,
            TypeDefinitionId = ObjectTypeIds.BaseObjectType,
            NodeId = new NodeId(id, NamespaceIndex),
            BrowseName = new QualifiedName(name, NamespaceIndex),
            DisplayName = new LocalizedText(name),
        };
        parent.AddChild(o);
        return o;
    }

    private BaseDataVariableState Var(NodeState parent, string id, string name, NodeId dataType, object initial)
    {
        var v = new BaseDataVariableState(parent)
        {
            SymbolicName = name,
            ReferenceTypeId = ReferenceTypeIds.HasComponent,
            TypeDefinitionId = VariableTypeIds.BaseDataVariableType,
            NodeId = new NodeId(id, NamespaceIndex),
            BrowseName = new QualifiedName(name, NamespaceIndex),
            DisplayName = new LocalizedText(name),
            DataType = dataType,
            ValueRank = ValueRanks.Scalar,
            AccessLevel = AccessLevels.CurrentRead,
            UserAccessLevel = AccessLevels.CurrentRead,
            Historizing = false,
            Value = initial,
            StatusCode = StatusCodes.Good,
            Timestamp = DateTime.UtcNow,
        };
        parent.AddChild(v);
        return v;
    }

    /// <summary>Update values in place and notify subscribers. Unknown ids are ignored. Thread-safe.</summary>
    public void Write(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors, bool? running = null, double? speed = null)
    {
        var now = DateTime.UtcNow;
        lock (Lock)
        {
            if (_simTime is not null) Set(_simTime, simTimeMs, now);
            if (running is { } r && _running is not null) Set(_running, r, now);
            if (speed is { } sp && _speed is not null) Set(_speed, sp, now);
            foreach (var a in assets)
            {
                if (!_assets.TryGetValue(a.Id, out var v)) continue;
                Set(v.State, (int)a.State, now);
                Set(v.Good, (double)a.Good, now);
                Set(v.Scrap, (double)a.Scrap, now);
                Set(v.Wip, (double)a.Wip, now);
                Set(v.Load, a.Load, now);
                Set(v.Wear, a.Wear, now);
            }
            foreach (var s in sensors)
                if (_sensors.TryGetValue(s.Id, out var v)) Set(v, s.V, now);
        }
    }

    private void Set(BaseDataVariableState v, object value, DateTime now)
    {
        v.Value = value;
        v.Timestamp = now;
        v.ClearChangeMasks(SystemContext, false);
    }
}
