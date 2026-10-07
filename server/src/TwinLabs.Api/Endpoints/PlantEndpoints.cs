using System.Text.Json;
using TwinLabs.Api.Hosting;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Core.Validation;

namespace TwinLabs.Api.Endpoints;

/// <summary>
/// v0.3 plant API (docs/V0.3-PlantBuilder.md §4): <c>POST /api/plant/validate</c>, <c>PUT /api/plant</c>,
/// <c>GET /api/templates</c>, <c>GET /api/templates/{id}</c>.
/// The template catalog is taken from DI when a <see cref="TemplateCatalog"/> is registered (tests), otherwise one is
/// created on first use for <see cref="TemplateCatalog.ResolveDirectory"/> (watching for changes in development).
/// </summary>
public static class PlantEndpoints
{
    public static IEndpointRouteBuilder MapPlantEndpoints(this IEndpointRouteBuilder app)
    {
        var services = app.ServiceProvider;
        var fallback = new Lazy<TemplateCatalog>(() =>
        {
            var env = services.GetRequiredService<IHostEnvironment>();
            var dev = env.IsDevelopment();
            var log = services.GetRequiredService<ILoggerFactory>().CreateLogger<TemplateCatalog>();
            var catalog = new TemplateCatalog(TemplateCatalog.ResolveDirectory(env.ContentRootPath, dev), watch: dev, log);
            log.LogInformation("Plant templates: {Dir}", catalog.Directory);
            return catalog;
        });
        TemplateCatalog Catalog(HttpContext ctx) => ctx.RequestServices.GetService<TemplateCatalog>() ?? fallback.Value;

        var api = app.MapGroup("/api");

        api.MapPost("/plant/validate", (PlantModel? plant) => TypedResults.Ok(PlantValidator.Validate(plant)));

        api.MapPut("/plant", (PlantModel? plant, SimulationHost host) =>
        {
            if (plant is null) return ApiEndpoints.Problem(StatusCodes.Status400BadRequest, "Bad Request", "A PlantModel body is required");
            ValidationResult result;
            SnapshotData? snapshot;
            try
            {
                result = host.ReplacePlant(plant, out snapshot);
            }
            catch (Exception ex) when (TwinErrors.TryMap(ex, out var status, out var title))
            {
                return ApiEndpoints.Problem(status, title, ex.Message);
            }
            if (!result.Ok || snapshot is null) return Rejected(result);
            return (IResult)TypedResults.Ok(snapshot);
        });

        api.MapGet("/templates", (HttpContext ctx) => TypedResults.Ok(Catalog(ctx).List()));

        api.MapGet("/templates/{id}", (string id, HttpContext ctx) =>
            Catalog(ctx).Get(id) is { } plant
                ? (IResult)TypedResults.Ok(plant)
                : ApiEndpoints.Problem(StatusCodes.Status404NotFound, "Not Found", $"Unknown template '{id}'"));

        return app;
    }

    /// <summary>422 problem+json with the issues (serialized with <see cref="TwinJson"/>) in an <c>issues</c> extension.</summary>
    private static IResult Rejected(ValidationResult result)
    {
        var critical = result.Issues.Count(i => i.Severity == Severity.Critical);
        return TypedResults.Problem(
            statusCode: StatusCodes.Status422UnprocessableEntity,
            title: "Plant has critical issues",
            detail: $"The plant was not applied: {critical} critical issue(s). " +
                    string.Join("; ", result.Issues.Where(i => i.Severity == Severity.Critical).Take(3).Select(i => i.Message)),
            extensions: new Dictionary<string, object?>
            {
                ["issues"] = JsonSerializer.SerializeToElement(result.Issues, TwinJson.Options),
            });
    }
}
