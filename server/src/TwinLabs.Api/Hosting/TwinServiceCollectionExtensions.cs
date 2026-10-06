using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using TwinLabs.Analytics;
using TwinLabs.Api.Realtime;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Simulation;

namespace TwinLabs.Api.Hosting;

public static class TwinServiceCollectionExtensions
{
    /// <summary>
    /// Registers the plant, engine factory, analytics, the <see cref="SimulationHost"/> and its loop. The engine and
    /// analytics registrations are plain singletons, so tests can swap them with fakes via ConfigureServices.
    /// </summary>
    public static IServiceCollection AddTwinLabs(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<TwinOptions>().Bind(config.GetSection(TwinOptions.Section));
        services.TryAddSingleton(TimeProvider.System);

        services.AddSingleton<PlantModel>(sp =>
        {
            var o = sp.GetRequiredService<IOptions<TwinOptions>>().Value;
            var env = sp.GetRequiredService<IHostEnvironment>();
            var path = PlantLocator.Resolve(o.PlantPath, env.ContentRootPath);
            sp.GetRequiredService<ILoggerFactory>().CreateLogger("TwinLabs.Api").LogInformation("Plant model: {Path}", path);
            return TwinJson.LoadPlant(path);
        });

        services.AddSingleton<ISimulationEngineFactory, SimulationEngineFactory>();
        // KPI calculator and anomaly detector are stateful and owned by the SimulationHost (one per live engine).
        services.AddSingleton<IKpiCalculator, KpiCalculator>();
        services.AddSingleton<IAnomalyDetector>(sp => new AnomalyDetector(sp.GetRequiredService<PlantModel>()));
        services.AddSingleton<IWhatIfRunner>(sp => new WhatIfRunner(sp.GetRequiredService<ISimulationEngineFactory>()));

        services.AddSingleton<ClientRegistry>();
        services.AddSingleton<SimulationHost>();
        services.AddHostedService<SimulationLoop>();
        return services;
    }
}
