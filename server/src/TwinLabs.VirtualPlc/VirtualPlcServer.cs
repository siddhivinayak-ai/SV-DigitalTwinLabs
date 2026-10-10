using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Opc.Ua;
using Opc.Ua.Configuration;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.VirtualPlc;

/// <summary>
/// Built-in OPC UA server (the "virtual PLC"). Endpoint <c>opc.tcp://localhost:{Port}/twinlabs</c>,
/// security None + anonymous (dev), address space <c>Objects/TwinLabs/&lt;LineId&gt;/&lt;AssetId&gt;/…</c>
/// with node ids <c>ns=2;s=&lt;LineId&gt;.&lt;AssetId&gt;.&lt;Name&gt;</c>.
/// <para><b>Standalone</b> (default): runs its own engine (seed = plant.Seed + SeedOffset) in real time × Speed,
/// emulating the physical line; host <see cref="Publish"/> calls are ignored.</para>
/// <para><b>Mirror</b> (<c>Standalone=false</c>): <see cref="Publish"/> writes the host's values (OPC UA gateway).</para>
/// Config: <c>Twin:VirtualPlc</c> (Enabled, Port, Standalone, Speed, SeedOffset); PKI under <c>Twin:Data:Path</c>/pki.
/// </summary>
public sealed class VirtualPlcServer : ITwinPublisher, IAsyncDisposable
{
    private readonly ISimulationEngineFactory _factory;
    private readonly ILogger _log;
    private readonly ILoggerFactory _loggerFactory;
    private readonly SemaphoreSlim _lifecycle = new(1, 1);

    private ApplicationInstance? _app;
    private volatile PlcServer? _server;
    private StandaloneLine? _line;

    public VirtualPlcServer(
        IConfiguration config,
        ISimulationEngineFactory factory,
        ILogger<VirtualPlcServer>? logger = null,
        ILoggerFactory? loggerFactory = null)
    {
        ArgumentNullException.ThrowIfNull(config);
        Options = VirtualPlcOptions.From(config);
        _factory = factory ?? throw new ArgumentNullException(nameof(factory));
        _log = (ILogger?)logger ?? NullLogger.Instance;
        _loggerFactory = loggerFactory ?? NullLoggerFactory.Instance;
    }

    public string Name => "virtual-plc";
    public bool Enabled => Options.Enabled;
    public VirtualPlcOptions Options { get; }
    public string EndpointUrl => Options.EndpointUrl;
    /// <summary>True while the OPC UA listener is up.</summary>
    public bool IsListening => _server is not null;
    /// <summary>LineId of the current address space (null when not running).</summary>
    public string? LineId => _server?.NodeManager?.LineId;

    public async Task StartAsync(PlantModel plant, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(plant);
        if (!Enabled) return;
        await _lifecycle.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await StopCoreAsync().ConfigureAwait(false); // plant change: rebuild from scratch
            await StartCoreAsync(plant, ct).ConfigureAwait(false);
        }
        finally { _lifecycle.Release(); }
    }

    private async Task StartCoreAsync(PlantModel plant, CancellationToken ct)
    {
        StandaloneLine? line = null;
        PlcServer? server = null;
        try
        {
            if (Options.Standalone)
            {
                var engine = _factory.Create(plant, unchecked(plant.Seed + Options.SeedOffset));
                line = new StandaloneLine(engine, Options.Speed, _log);
            }

            var telemetry = new PlcTelemetry(_loggerFactory);
            var config = await BuildConfigurationAsync(telemetry, ct).ConfigureAwait(false);
            var app = new ApplicationInstance(config, telemetry)
            {
                ApplicationName = config.ApplicationName,
                ApplicationType = ApplicationType.Server,
            };
            var certOk = await app.CheckApplicationInstanceCertificatesAsync(true, null, ct).ConfigureAwait(false);
            if (!certOk) throw new InvalidOperationException("Virtual PLC application certificate is invalid.");

            server = new PlcServer(plant, line);
            await app.StartAsync(server).ConfigureAwait(false);

            _app = app;
            _server = server;
            if (line is not null)
            {
                _line = line;
                line.Run(() => _server?.NodeManager);
            }
            _log.LogInformation("Virtual PLC listening on {Endpoint} ({Mode}, line {LineId}, {Assets} assets)",
                EndpointUrl, Options.Standalone ? "standalone" : "mirror", server.NodeManager?.LineId, plant.Assets.Count);
        }
        catch (Exception ex)
        {
            if (line is not null) await line.DisposeAsync().ConfigureAwait(false);
            try { server?.Dispose(); } catch { /* best effort */ }
            if (ex is not OperationCanceledException)
                _log.LogError(ex, "Virtual PLC failed to start on {Endpoint}", EndpointUrl);
            throw;
        }
    }

    private async Task<ApplicationConfiguration> BuildConfigurationAsync(ITelemetryContext telemetry, CancellationToken ct)
    {
        var pki = Options.PkiPath;
        var config = new ApplicationConfiguration(telemetry)
        {
            ApplicationName = "TwinLabs Virtual PLC",
            ApplicationUri = $"urn:{System.Net.Dns.GetHostName()}:TwinLabs:VirtualPlc",
            ProductUri = PlcNaming.NamespaceUri,
            ApplicationType = ApplicationType.Server,
            SecurityConfiguration = new SecurityConfiguration
            {
                ApplicationCertificate = new CertificateIdentifier
                {
                    StoreType = CertificateStoreType.Directory,
                    StorePath = Path.Combine(pki, "own"),
                    SubjectName = "CN=TwinLabs Virtual PLC, O=SV-DigitalTwinLabs",
                },
                TrustedIssuerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "issuer") },
                TrustedPeerCertificates = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "trusted") },
                RejectedCertificateStore = new CertificateTrustList { StoreType = CertificateStoreType.Directory, StorePath = Path.Combine(pki, "rejected") },
                AutoAcceptUntrustedCertificates = true, // dev only
                AddAppCertToTrustedStore = false,
            },
            TransportConfigurations = [],
            TransportQuotas = new TransportQuotas { OperationTimeout = 15000 },
            ServerConfiguration = new ServerConfiguration
            {
                BaseAddresses = [EndpointUrl],
                SecurityPolicies = [new ServerSecurityPolicy { SecurityMode = MessageSecurityMode.None, SecurityPolicyUri = SecurityPolicies.None }],
                UserTokenPolicies = [new UserTokenPolicy(UserTokenType.Anonymous)],
                DiagnosticsEnabled = false,
                MaxSessionCount = 100,
                MinPublishingInterval = 50,
            },
        };
        await config.ValidateAsync(ApplicationType.Server, ct).ConfigureAwait(false);
        config.CertificateValidator.CertificateValidation += (_, e) =>
        {
            if (e.Error.StatusCode == StatusCodes.BadCertificateUntrusted) e.Accept = true; // dev only
        };
        return config;
    }

    public void Publish(long simTimeMs, IReadOnlyList<AssetState> assets, IReadOnlyList<SensorValue> sensors)
    {
        if (!Enabled || Options.Standalone) return; // standalone = independent physical line
        _server?.NodeManager?.Write(simTimeMs, assets, sensors);
    }

    public async Task StopAsync()
    {
        await _lifecycle.WaitAsync().ConfigureAwait(false);
        try { await StopCoreAsync().ConfigureAwait(false); }
        finally { _lifecycle.Release(); }
    }

    private async Task StopCoreAsync()
    {
        var line = _line;
        var server = _server;
        var app = _app;
        _line = null;
        _server = null;
        _app = null;
        if (line is not null) await line.DisposeAsync().ConfigureAwait(false);
        if (server is null) return;
        try
        {
            if (app is not null) await app.StopAsync().ConfigureAwait(false);
            else await server.StopAsync().ConfigureAwait(false);
        }
        catch (Exception ex) { _log.LogWarning(ex, "Virtual PLC stop failed"); }
        finally { server.Dispose(); }
        _log.LogInformation("Virtual PLC stopped");
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
    }
}

/// <summary>Routes OPC UA stack logging to the host's logger factory.</summary>
internal sealed class PlcTelemetry(ILoggerFactory loggerFactory) : TelemetryContextBase(loggerFactory);
