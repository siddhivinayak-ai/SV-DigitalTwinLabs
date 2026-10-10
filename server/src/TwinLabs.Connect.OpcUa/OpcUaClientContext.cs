using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Opc.Ua;
using Opc.Ua.Configuration;

namespace TwinLabs.Connect.OpcUa;

/// <summary>Bridges an <see cref="ILoggerFactory"/> into the OPC UA stack's telemetry abstraction.</summary>
internal sealed class OpcUaTelemetry(ILoggerFactory loggerFactory) : TelemetryContextBase(loggerFactory);

/// <summary>
/// State shared by every source of one factory: options, telemetry and the client
/// <see cref="ApplicationConfiguration"/> (built once, including the auto-created application certificate).
/// </summary>
internal sealed class OpcUaClientContext
{
    private readonly SemaphoreSlim _configGate = new(1, 1);
    private ApplicationConfiguration? _config;

    public OpcUaClientContext(OpcUaClientOptions? options, ILoggerFactory? loggerFactory)
    {
        Options = options ?? new OpcUaClientOptions();
        LoggerFactory = loggerFactory ?? NullLoggerFactory.Instance;
        Telemetry = new OpcUaTelemetry(LoggerFactory);
    }

    public OpcUaClientOptions Options { get; }
    public ILoggerFactory LoggerFactory { get; }
    public ITelemetryContext Telemetry { get; }

    public string PkiRoot => Options.PkiRoot ?? Path.Combine(Path.GetTempPath(), "TwinLabs", "opcua-client-pki");

    public async Task<ApplicationConfiguration> GetConfigurationAsync(CancellationToken ct)
    {
        if (Volatile.Read(ref _config) is { } cached) return cached;
        await _configGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_config is not null) return _config;
            var config = await BuildAsync(ct).ConfigureAwait(false);
            Volatile.Write(ref _config, config);
            return config;
        }
        finally
        {
            _configGate.Release();
        }
    }

    private async Task<ApplicationConfiguration> BuildAsync(CancellationToken ct)
    {
        var pki = PkiRoot;
        const string appName = "TwinLabs OPC UA Client";
        var config = new ApplicationConfiguration(Telemetry)
        {
            ApplicationName = appName,
            ApplicationUri = $"urn:{Utils.GetHostName()}:TwinLabs:OpcUaClient",
            ProductUri = "urn:TwinLabs:OpcUaClient",
            ApplicationType = ApplicationType.Client,
            SecurityConfiguration = new SecurityConfiguration
            {
                ApplicationCertificate = new CertificateIdentifier
                {
                    StoreType = CertificateStoreType.Directory,
                    StorePath = Path.Combine(pki, "own"),
                    SubjectName = $"CN={appName}, O=TwinLabs",
                },
                TrustedIssuerCertificates = new CertificateTrustList
                {
                    StoreType = CertificateStoreType.Directory,
                    StorePath = Path.Combine(pki, "issuer"),
                },
                TrustedPeerCertificates = new CertificateTrustList
                {
                    StoreType = CertificateStoreType.Directory,
                    StorePath = Path.Combine(pki, "trusted"),
                },
                RejectedCertificateStore = new CertificateTrustList
                {
                    StoreType = CertificateStoreType.Directory,
                    StorePath = Path.Combine(pki, "rejected"),
                },
                // Dev setting: trust whatever server we are pointed at.
                AutoAcceptUntrustedCertificates = true,
                RejectSHA1SignedCertificates = false,
                AddAppCertToTrustedStore = false,
            },
            TransportConfigurations = [],
            TransportQuotas = new TransportQuotas { OperationTimeout = Options.OperationTimeoutMs },
            ClientConfiguration = new ClientConfiguration { DefaultSessionTimeout = (int)Options.SessionTimeoutMs },
        };

        await config.ValidateAsync(ApplicationType.Client, ct).ConfigureAwait(false);
        config.CertificateValidator.CertificateValidation += (_, e) => e.Accept = true;

        var app = new ApplicationInstance(config, Telemetry)
        {
            ApplicationName = appName,
            ApplicationType = ApplicationType.Client,
        };
        // Creates a self-signed application certificate in <pki>/own on first run.
        await app.CheckApplicationInstanceCertificatesAsync(false, null, ct).ConfigureAwait(false);
        return config;
    }
}
