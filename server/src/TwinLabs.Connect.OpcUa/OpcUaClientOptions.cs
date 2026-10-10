namespace TwinLabs.Connect.OpcUa;

/// <summary>Tuning knobs for <see cref="OpcUaTagSource"/>. The defaults suit a LAN PLC; tests shorten them.</summary>
public sealed class OpcUaClientOptions
{
    /// <summary>Root of the client PKI (own/trusted/issuer/rejected). Default: <c>%TEMP%/TwinLabs/opcua-client-pki</c>.
    /// The client application certificate is created here on first use.</summary>
    public string? PkiRoot { get; set; }

    /// <summary>First retry delay after a failed connect (doubles per failure up to <see cref="MaxReconnectDelay"/>).</summary>
    public TimeSpan MinReconnectDelay { get; set; } = TimeSpan.FromSeconds(1);

    public TimeSpan MaxReconnectDelay { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Session keep-alive read interval; a failed keep-alive starts the reconnect handler.</summary>
    public int KeepAliveIntervalMs { get; set; } = 5000;

    /// <summary>Timeout of single OPC UA service calls (and of endpoint discovery).</summary>
    public int OperationTimeoutMs { get; set; } = 10000;

    public uint SessionTimeoutMs { get; set; } = 60000;

    /// <summary>Default publishing interval when <c>ConnectionDef.PublishingIntervalMs</c> is null.</summary>
    public int DefaultPublishingIntervalMs { get; set; } = 250;
}
