namespace TwinLabs.Api.Hosting;

/// <summary>
/// Starts and stops the v0.2 connectivity around the <see cref="SimulationHost"/>: attaches the connection manager,
/// publisher pump and event-sink forwarder to the host, starts publishers and tag sources for the live plant, and
/// restarts publishers on <see cref="SimulationHost.PlantChanged"/> (the manager subscribes itself).
/// Tag sources start in the background so a slow endpoint never delays server startup.
/// </summary>
public sealed class ConnectivityService(
    SimulationHost host,
    ConnectionManager connections,
    PublisherPump publishers,
    EventSinkForwarder sinks,
    ILogger<ConnectivityService> log) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        host.AttachConnectivity(connections, publishers, sinks);
        sinks.Start();
        var plant = host.GetPlant();
        await publishers.StartAsync(plant, cancellationToken);
        host.PlantChanged += publishers.OnPlantChanged;
        _ = connections.StartAsync(plant);
        log.LogInformation("Twin mode {Mode}: {Connections} connection(s), {Publishers} publisher(s), {Sinks} event sink(s)",
            host.Mode, plant.Connections?.Count ?? 0, publishers.Count, sinks.SinkCount);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        host.PlantChanged -= publishers.OnPlantChanged;
        try
        {
            await connections.StopAsync();
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Stopping connections failed");
        }
        host.AttachConnectivity(connections, null, sinks);
        await publishers.StopAsync();
        await sinks.StopAsync();
    }
}
