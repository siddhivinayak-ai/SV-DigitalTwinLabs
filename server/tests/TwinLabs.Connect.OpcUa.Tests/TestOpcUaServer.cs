using Microsoft.Extensions.Logging.Abstractions;
using Opc.Ua;
using Opc.Ua.Configuration;
using Opc.Ua.Server;

namespace TwinLabs.Connect.OpcUa.Tests;

/// <summary>
/// Minimal in-process OPC UA server for tests: security None, anonymous, endpoint
/// <c>opc.tcp://localhost:{port}/twinlabs</c>, one namespace (index 2) of string node ids.
/// </summary>
public sealed class TestOpcUaServer : IAsyncDisposable
{
    public const string NamespaceUri = "urn:twinlabs:test";

    private readonly ApplicationInstance _app;
    private readonly TestServer _server;

    private TestOpcUaServer(ApplicationInstance app, TestServer server, int port)
    {
        _app = app;
        _server = server;
        Port = port;
    }

    public int Port { get; }
    public string Endpoint => $"opc.tcp://localhost:{Port}/twinlabs";

    /// <summary>Initial node values; keys are the string part of <c>ns=2;s=...</c>.</summary>
    public static Dictionary<string, object> DefaultNodes() => new()
    {
        ["LineA.CNC-01.Temp"] = 61.5,
        ["LineA.CNC-01.State"] = 2,
        ["LineA.CNC-01.Good"] = 0.0,
        ["LineA.SNK-01.Good"] = 0.0,
    };

    public static async Task<TestOpcUaServer> StartAsync(int port, IDictionary<string, object>? nodes = null)
    {
        var telemetry = new TestTelemetry();
        var pki = Path.Combine(Path.GetTempPath(), "TwinLabs", "opcua-test-server-pki");
        const string appName = "TwinLabs Test Server";
        var config = new ApplicationConfiguration(telemetry)
        {
            ApplicationName = appName,
            ApplicationUri = $"urn:{Utils.GetHostName()}:TwinLabs:TestServer",
            ProductUri = "urn:TwinLabs:TestServer",
            ApplicationType = ApplicationType.Server,
            SecurityConfiguration = new SecurityConfiguration
            {
                ApplicationCertificate = new CertificateIdentifier
                {
                    StoreType = CertificateStoreType.Directory,
                    StorePath = Path.Combine(pki, "own"),
                    SubjectName = $"CN={appName}, O=TwinLabs",
                },
                TrustedIssuerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "issuer") },
                TrustedPeerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "trusted") },
                RejectedCertificateStore = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "rejected") },
                AutoAcceptUntrustedCertificates = true,
                AddAppCertToTrustedStore = false,
            },
            TransportConfigurations = [],
            TransportQuotas = new TransportQuotas { OperationTimeout = 5000 },
            ServerConfiguration = new ServerConfiguration
            {
                BaseAddresses = [$"opc.tcp://localhost:{port}/twinlabs"],
                SecurityPolicies =
                [
                    new ServerSecurityPolicy { SecurityMode = MessageSecurityMode.None, SecurityPolicyUri = SecurityPolicies.None },
                ],
                UserTokenPolicies = [new UserTokenPolicy(UserTokenType.Anonymous)],
                MinPublishingInterval = 50,
                PublishingResolution = 25,
                MinSubscriptionLifetime = 1000,
                MaxSessionCount = 20,
                DiagnosticsEnabled = false,
                ShutdownDelay = 0,
                MaxRegistrationInterval = 0,
            },
        };
        await config.ValidateAsync(ApplicationType.Server);
        config.CertificateValidator.CertificateValidation += (_, e) => e.Accept = true;

        var app = new ApplicationInstance(config, telemetry) { ApplicationName = appName, ApplicationType = ApplicationType.Server };
        await app.CheckApplicationInstanceCertificatesAsync(false, null);

        var server = new TestServer(nodes ?? DefaultNodes());
        await app.StartAsync(server);
        return new TestOpcUaServer(app, server, port);
    }

    /// <summary>Restores <see cref="DefaultNodes"/> values with Good status (for tests sharing one server).</summary>
    public void Reset()
    {
        foreach (var (name, value) in DefaultNodes()) SetValue(name, value);
    }

    /// <summary>Changes a node value (and its timestamps); subscribed clients get a data change.</summary>
    public void SetValue(string name, object value) => _server.Nodes.SetValue(name, value);

    /// <summary>Sets a Bad status on a node (value is kept).</summary>
    public void SetBad(string name) => _server.Nodes.SetStatus(name, StatusCodes.BadSensorFailure);

    public async ValueTask DisposeAsync()
    {
        try
        {
            await _app.StopAsync();
        }
        catch
        {
            // best effort in tests
        }
        _server.Dispose();
    }

    private sealed class TestTelemetry() : TelemetryContextBase(NullLoggerFactory.Instance);

    private sealed class TestServer(IDictionary<string, object> nodes) : StandardServer
    {
        public TestNodeManager Nodes { get; private set; } = null!;

        protected override MasterNodeManager CreateMasterNodeManager(IServerInternal server, ApplicationConfiguration configuration)
        {
            Nodes = new TestNodeManager(server, configuration, nodes);
            return new MasterNodeManager(server, configuration, null, Nodes);
        }
    }

    public sealed class TestNodeManager : CustomNodeManager2
    {
        private readonly IDictionary<string, object> _initial;
        private readonly Dictionary<string, BaseDataVariableState> _vars = new(StringComparer.Ordinal);

        internal TestNodeManager(IServerInternal server, ApplicationConfiguration configuration, IDictionary<string, object> initial)
            : base(server, configuration, NamespaceUri)
        {
            _initial = initial;
        }

        public override void CreateAddressSpace(IDictionary<NodeId, IList<IReference>> externalReferences)
        {
            lock (Lock)
            {
                if (!externalReferences.TryGetValue(ObjectIds.ObjectsFolder, out var refs))
                    externalReferences[ObjectIds.ObjectsFolder] = refs = new List<IReference>();

                var folder = new FolderState(null)
                {
                    SymbolicName = "LineA",
                    NodeId = new NodeId("LineA", NamespaceIndex),
                    BrowseName = new QualifiedName("LineA", NamespaceIndex),
                    DisplayName = "LineA",
                    TypeDefinitionId = ObjectTypeIds.FolderType,
                    EventNotifier = EventNotifiers.None,
                };
                folder.AddReference(ReferenceTypeIds.Organizes, true, ObjectIds.ObjectsFolder);
                refs.Add(new NodeStateReference(ReferenceTypeIds.Organizes, false, folder.NodeId));

                foreach (var (name, value) in _initial)
                {
                    var v = new BaseDataVariableState(folder)
                    {
                        SymbolicName = name,
                        NodeId = new NodeId(name, NamespaceIndex),
                        BrowseName = new QualifiedName(name, NamespaceIndex),
                        DisplayName = name,
                        TypeDefinitionId = VariableTypeIds.BaseDataVariableType,
                        ReferenceTypeId = ReferenceTypeIds.Organizes,
                        DataType = DataTypeFor(value),
                        ValueRank = ValueRanks.Scalar,
                        AccessLevel = AccessLevels.CurrentReadOrWrite,
                        UserAccessLevel = AccessLevels.CurrentReadOrWrite,
                        Historizing = false,
                        Value = value,
                        StatusCode = StatusCodes.Good,
                        Timestamp = DateTime.UtcNow,
                    };
                    folder.AddChild(v);
                    _vars[name] = v;
                }
                AddPredefinedNode(SystemContext, folder);
            }
        }

        public void SetValue(string name, object value)
        {
            lock (Lock)
            {
                var v = _vars[name];
                v.Value = value;
                v.StatusCode = StatusCodes.Good;
                v.Timestamp = DateTime.UtcNow;
                v.ClearChangeMasks(SystemContext, false);
            }
        }

        public void SetStatus(string name, StatusCode status)
        {
            lock (Lock)
            {
                var v = _vars[name];
                v.StatusCode = status;
                v.Timestamp = DateTime.UtcNow;
                v.ClearChangeMasks(SystemContext, false);
            }
        }

        private static NodeId DataTypeFor(object value) => value switch
        {
            double => DataTypeIds.Double,
            int => DataTypeIds.Int32,
            bool => DataTypeIds.Boolean,
            string => DataTypeIds.String,
            float => DataTypeIds.Float,
            _ => DataTypeIds.BaseDataType,
        };
    }
}
