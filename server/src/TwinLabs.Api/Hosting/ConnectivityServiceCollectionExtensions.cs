using TwinLabs.Connect.Mqtt;
using TwinLabs.Connect.OpcUa;
using TwinLabs.Core;
using TwinLabs.VirtualPlc;

namespace TwinLabs.Api.Hosting;

// Owned by feature/shadow-mode. Registers tag-source factories, outbound publishers and the host-side connectivity.
public static class ConnectivityServiceCollectionExtensions
{
    public static IServiceCollection AddTwinConnectivity(this IServiceCollection services)
    {
        services.AddSingleton<ITagSourceFactory, OpcUaTagSourceFactory>();
        services.AddSingleton<ITagSourceFactory, MqttTagSourceFactory>();
        services.AddSingleton<ITwinPublisher, VirtualPlcServer>();
        services.AddSingleton<ITwinPublisher, MqttSimPublisher>();

        // Host side (feature/shadow-mode): tag sources -> host, host -> publishers, host -> event sinks.
        services.AddSingleton<ConnectionManager>();
        services.AddSingleton<PublisherPump>();
        services.AddSingleton<EventSinkForwarder>();
        services.AddHostedService<ConnectivityService>();
        return services;
    }
}
