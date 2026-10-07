using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TwinLabs.Core;

namespace TwinLabs.Persistence;

public static class PersistenceExtensions
{
    /// <summary>
    /// Registers singleton <see cref="IHistoryStore"/> (also as <see cref="IHostEventSink"/>), <see cref="IScenarioStore"/>,
    /// <see cref="ILayoutStore"/> and <see cref="IMeshStore"/>: SQLite + files under <c>Twin:Data:Path</c>, or in-memory
    /// when <c>Twin:Data:Enabled</c> is false (see <see cref="TwinDataOptions"/> for the defaults). Nothing touches disk
    /// until the first write.
    /// </summary>
    public static IServiceCollection AddTwinPersistence(this IServiceCollection services, IConfiguration config)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton(sp =>
        {
            var env = sp.GetService<IHostEnvironment>();
            return TwinDataOptions.FromConfiguration(config, env?.ContentRootPath, env?.EnvironmentName);
        });
        services.TryAddSingleton(sp => new SqliteDatabase(sp.GetRequiredService<TwinDataOptions>().DatabaseFile));

        services.TryAddSingleton<IHistoryStore>(sp =>
        {
            var o = sp.GetRequiredService<TwinDataOptions>();
            return o.Enabled
                ? new SqliteHistoryStore(sp.GetRequiredService<SqliteDatabase>(), o.HistoryRetention,
                    SqliteHistoryStore.DefaultCapacity, sp.GetRequiredService<TimeProvider>(),
                    sp.GetService<ILogger<SqliteHistoryStore>>())
                : new InMemoryHistoryStore(o.HistoryRetention);
        });
        services.AddSingleton<IHostEventSink>(sp => sp.GetRequiredService<IHistoryStore>());
        services.TryAddSingleton<IScenarioStore>(sp => sp.GetRequiredService<TwinDataOptions>().Enabled
            ? new SqliteScenarioStore(sp.GetRequiredService<SqliteDatabase>(), sp.GetRequiredService<TimeProvider>())
            : new InMemoryScenarioStore(sp.GetRequiredService<TimeProvider>()));
        services.TryAddSingleton<ILayoutStore>(sp => sp.GetRequiredService<TwinDataOptions>().Enabled
            ? new SqliteLayoutStore(sp.GetRequiredService<SqliteDatabase>(), sp.GetRequiredService<TimeProvider>())
            : new InMemoryLayoutStore(sp.GetRequiredService<TimeProvider>()));
        services.TryAddSingleton<IMeshStore>(sp =>
        {
            var o = sp.GetRequiredService<TwinDataOptions>();
            return o.Enabled
                ? new FileMeshStore(sp.GetRequiredService<SqliteDatabase>(), o.MeshDirectory, TwinDataOptions.MaxMeshBytes,
                    sp.GetRequiredService<TimeProvider>())
                : new InMemoryMeshStore();
        });
        services.AddHostedService<HistoryWriterService>();
        return services;
    }

    /// <summary>Maps /api/scenarios, /api/layouts, /api/meshes, /api/history/events, /api/history/alarms.</summary>
    public static IEndpointRouteBuilder MapPersistenceEndpoints(this IEndpointRouteBuilder app)
    {
        PersistenceEndpoints.Map(app);
        return app;
    }
}

/// <summary>Lifecycle of the SQLite history writer: flushes everything queued when the host stops.</summary>
internal sealed class HistoryWriterService(IHistoryStore store) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask; // the writer starts with the store

    public Task StopAsync(CancellationToken cancellationToken) =>
        store is SqliteHistoryStore sqlite ? sqlite.StopAsync(cancellationToken) : Task.CompletedTask;
}
