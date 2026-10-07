using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt;

// STUB (v0.2 contracts): replaced by feature/mqtt-adapter.
public sealed class MqttTagSourceFactory : ITagSourceFactory
{
    public ConnectionKind Kind => ConnectionKind.Mqtt;
    public ITagSource Create(ConnectionDef definition) => throw new NotImplementedException("feature/mqtt-adapter");
}
