using Microsoft.Extensions.Logging;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.OpcUa;

/// <summary>Creates <see cref="OpcUaTagSource"/>s. Sources from one factory share the client configuration and certificate.</summary>
public sealed class OpcUaTagSourceFactory : ITagSourceFactory
{
    private readonly OpcUaClientContext _context;

    public OpcUaTagSourceFactory() : this(null, null) { }

    public OpcUaTagSourceFactory(ILoggerFactory? loggerFactory) : this(null, loggerFactory) { }

    public OpcUaTagSourceFactory(OpcUaClientOptions? options, ILoggerFactory? loggerFactory = null) =>
        _context = new OpcUaClientContext(options, loggerFactory);

    public ConnectionKind Kind => ConnectionKind.Opcua;

    public ITagSource Create(ConnectionDef definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        if (definition.Kind != ConnectionKind.Opcua)
            throw new ArgumentException($"Connection '{definition.Id}' is {definition.Kind}, not opcua", nameof(definition));
        return new OpcUaTagSource(definition, _context);
    }
}
