using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.OpcUa;

// STUB (v0.2 contracts): replaced by feature/opcua-adapter.
public sealed class OpcUaTagSourceFactory : ITagSourceFactory
{
    public ConnectionKind Kind => ConnectionKind.Opcua;
    public ITagSource Create(ConnectionDef definition) => throw new NotImplementedException("feature/opcua-adapter");
}
