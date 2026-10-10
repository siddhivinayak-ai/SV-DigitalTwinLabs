using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Opc.Ua;
using Opc.Ua.Client;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Simulation;

[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace TwinLabs.VirtualPlc.Tests;

internal sealed class TestTelemetry() : TelemetryContextBase(NullLoggerFactory.Instance);

/// <summary>Records the seed the server asks for and builds real engines.</summary>
internal sealed class RecordingFactory : ISimulationEngineFactory
{
    private readonly SimulationEngineFactory _inner = new();
    public int? LastSeed { get; private set; }
    public ISimulationEngine Create(PlantModel plant, int seed)
    {
        LastSeed = seed;
        return _inner.Create(plant, seed);
    }
}

internal static class PlcHarness
{
    /// <summary>One data folder for the whole run, so the server certificate is created only once.</summary>
    public static readonly string DataPath = Path.Combine(Path.GetTempPath(), "twinlabs-vplc-tests");

    public static PlantModel SamplePlant() => TwinJson.LoadPlant(Path.Combine(RepoRoot(), "contracts", "plant", "sample_line.connected.json"));

    public static string RepoRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (Directory.Exists(Path.Combine(d.FullName, "contracts", "plant"))) return d.FullName;
        throw new DirectoryNotFoundException("repo root with contracts/plant not found");
    }

    public static VirtualPlcServer Create(int port, bool enabled = true, bool standalone = true, double speed = 1, ISimulationEngineFactory? factory = null)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Twin:VirtualPlc:Enabled"] = enabled.ToString(),
            ["Twin:VirtualPlc:Port"] = port.ToString(),
            ["Twin:VirtualPlc:Standalone"] = standalone.ToString(),
            ["Twin:VirtualPlc:Speed"] = speed.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Twin:Data:Path"] = DataPath,
        }).Build();
        return new VirtualPlcServer(config, factory ?? new RecordingFactory(), NullLogger<VirtualPlcServer>.Instance);
    }

    public static async Task<ISession> ConnectAsync(string endpointUrl, CancellationToken ct = default)
    {
        var telemetry = new TestTelemetry();
        var pki = Path.Combine(DataPath, "client-pki");
        var config = new ApplicationConfiguration(telemetry)
        {
            ApplicationName = "TwinLabs VirtualPlc Tests",
            ApplicationUri = "urn:localhost:TwinLabs:VirtualPlcTests",
            ApplicationType = ApplicationType.Client,
            SecurityConfiguration = new SecurityConfiguration
            {
                ApplicationCertificate = new CertificateIdentifier { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "own"), SubjectName = "CN=TwinLabs VirtualPlc Tests" },
                TrustedIssuerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "issuer") },
                TrustedPeerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "trusted") },
                RejectedCertificateStore = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "rejected") },
                AutoAcceptUntrustedCertificates = true,
            },
            TransportConfigurations = [],
            TransportQuotas = new TransportQuotas { OperationTimeout = 10000 },
            ClientConfiguration = new ClientConfiguration { DefaultSessionTimeout = 30000 },
        };
        await config.ValidateAsync(ApplicationType.Client, ct);
        var endpoint = await CoreClientUtils.SelectEndpointAsync(config, endpointUrl, false, telemetry, ct);
        var configured = new ConfiguredEndpoint(null, endpoint, EndpointConfiguration.Create(config));
        return await new DefaultSessionFactory(telemetry).CreateAsync(
            config, configured, false, "vplc-test", 30000, new UserIdentity(new AnonymousIdentityToken()), null, ct);
    }

    public static async Task<DataValue> ReadAsync(this ISession s, string nodeId) =>
        await s.ReadValueAsync(NodeId.Parse(nodeId), CancellationToken.None);

    public static async Task<StatusCode> CallAsync(this ISession s, string objectId, string methodId, params object[] args)
    {
        var req = new CallMethodRequest { ObjectId = NodeId.Parse(objectId), MethodId = NodeId.Parse(methodId) };
        foreach (var a in args) req.InputArguments.Add(new Variant(a));
        var resp = await s.CallAsync(null, [req], CancellationToken.None);
        return resp.Results[0].StatusCode;
    }

    public static async Task<List<string>> BrowseNamesAsync(this ISession s, NodeId node)
    {
        var refs = await s.FetchReferencesAsync(node, CancellationToken.None);
        return refs.Where(r => r.IsForward && r.ReferenceTypeId != ReferenceTypeIds.HasTypeDefinition).Select(r => r.BrowseName.Name).ToList();
    }

    /// <summary>Poll until <paramref name="check"/> holds or the timeout elapses.</summary>
    public static async Task<bool> EventuallyAsync(Func<Task<bool>> check, TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        do
        {
            if (await check()) return true;
            await Task.Delay(100);
        } while (DateTime.UtcNow < until);
        return await check();
    }
}
