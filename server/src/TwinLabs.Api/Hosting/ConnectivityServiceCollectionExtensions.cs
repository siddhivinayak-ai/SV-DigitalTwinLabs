using TwinLabs.Connect.Mqtt;
using TwinLabs.Connect.OpcUa;
using TwinLabs.Core;
using TwinLabs.VirtualPlc;

namespace TwinLabs.Api.Hosting;

// Owned by feature/shadow-mode. Registers tag-source factories and outbound publishers.
public static class ConnectivityServiceCollectionExtensions
{
    public static IServiceCollection AddTwinConnectivity(this IServiceCollection services)
    {
        services.AddSingleton<ITagSourceFactory, OpcUaTagSourceFactory>();
        services.AddSingleton<ITagSourceFactory, MqttTagSourceFactory>();
        services.AddSingleton<ITwinPublisher, VirtualPlcServer>();
        services.AddSingleton<ITwinPublisher, MqttSimPublisher>();
        return services;
    }
}
