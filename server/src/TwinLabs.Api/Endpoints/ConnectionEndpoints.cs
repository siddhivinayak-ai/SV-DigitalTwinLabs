using TwinLabs.Api.Hosting;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Endpoints;

/// <summary>v0.2: GET /api/connections, POST /api/connections/{id}/reconnect, POST /api/twin/mode.</summary>
public static class ConnectionEndpoints
{
    public static IEndpointRouteBuilder MapConnectionEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/connections", (ConnectionManager m) => TypedResults.Ok(m.Statuses));

        api.MapPost("/connections/{id}/reconnect", async (string id, ConnectionManager m) =>
        {
            try
            {
                return (IResult)TypedResults.Ok(await m.ReconnectAsync(id));
            }
            catch (Exception ex) when (TwinErrors.TryMap(ex, out var status, out var title))
            {
                return ApiEndpoints.Problem(status, title, ex.Message);
            }
        });

        api.MapPost("/twin/mode", (TwinModeRequest req, SimulationHost h) =>
        {
            try
            {
                return (IResult)TypedResults.Ok(h.SetMode(req.Mode));
            }
            catch (Exception ex) when (TwinErrors.TryMap(ex, out var status, out var title))
            {
                return ApiEndpoints.Problem(status, title, ex.Message);
            }
        });

        return app;
    }
}
