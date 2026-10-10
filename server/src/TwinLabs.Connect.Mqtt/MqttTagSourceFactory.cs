using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.Mqtt;

/// <summary>Creates one <see cref="MqttTagSource"/> per MQTT <see cref="ConnectionDef"/>.</summary>
public sealed class MqttTagSourceFactory : ITagSourceFactory
{
    public ConnectionKind Kind => ConnectionKind.Mqtt;

    public ITagSource Create(ConnectionDef definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        if (definition.Kind != ConnectionKind.Mqtt)
            throw new ArgumentException($"Connection '{definition.Id}' is {definition.Kind}, not mqtt", nameof(definition));
        return new MqttTagSource(definition);
    }
}
