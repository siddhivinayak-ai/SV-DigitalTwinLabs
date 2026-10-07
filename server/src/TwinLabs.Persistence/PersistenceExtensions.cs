using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TwinLabs.Persistence;

// STUB (v0.2 contracts): replaced by feature/persistence.
public static class PersistenceExtensions
{
    /// <summary>Registers SQLite-backed IHistoryStore / IHostEventSink, IScenarioStore, ILayoutStore, IMeshStore. Config: Twin:Data:Path.</summary>
    public static IServiceCollection AddTwinPersistence(this IServiceCollection services, IConfiguration config) => services;

    /// <summary>Maps /api/scenarios, /api/layouts, /api/meshes, /api/history/events, /api/history/alarms.</summary>
    public static IEndpointRouteBuilder MapPersistenceEndpoints(this IEndpointRouteBuilder app) => app;
}
