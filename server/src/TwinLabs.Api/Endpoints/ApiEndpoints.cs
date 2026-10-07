using System.Reflection;
using System.Text;
using System.Text.Json;
using TwinLabs.Api.Hosting;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Api.Endpoints;

/// <summary>REST surface: every row of the contracts/README.md REST table, under <c>/api</c>.</summary>
public static class ApiEndpoints
{
    private static readonly string Version = ResolveVersion();

    public static IEndpointRouteBuilder MapTwinApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/health", () => TypedResults.Ok(new HealthData("ok", Version)));
        api.MapGet("/plant", (SimulationHost h) => TypedResults.Ok(h.GetPlant()));
        api.MapGet("/state", (SimulationHost h) => TypedResults.Ok(h.GetSnapshot()));
        api.MapGet("/kpi", (SimulationHost h) => Guard(h.GetKpi));
        api.MapGet("/history/{sensorId}", (string sensorId, double? seconds, SimulationHost h) =>
            Guard(() => h.GetHistory(sensorId, seconds ?? 600)));
        api.MapGet("/events", (int? limit, SimulationHost h) => Guard(() => h.GetEvents(limit ?? 200)));
        api.MapGet("/alarms", (SimulationHost h) => TypedResults.Ok(h.GetActiveAlarms()));

        var sim = api.MapGroup("/sim");
        sim.MapPost("/start", (SimulationHost h) => Guard(h.Start));
        sim.MapPost("/pause", (SimulationHost h) => Guard(h.Pause));
        sim.MapPost("/stop", (SimulationHost h) => Guard(h.Stop));
        sim.MapPost("/reset", (SimulationHost h) => Guard(h.Reset));
        sim.MapPost("/speed", (SpeedRequest req, SimulationHost h) => Guard(() => h.SetSpeed(req.Speed)));

        var assets = api.MapGroup("/assets/{id}");
        assets.MapPatch("/params", (string id, ParamsRequest req, SimulationHost h) => Guard(() => h.UpdateParams(id, req.Params)));
        // The body is optional (no body = repair time drawn from MTTR), so it is read by hand: an inferred
        // [FromBody] would make routing reject body-less requests that carry no Content-Type.
        assets.MapPost("/fault", async (string id, HttpRequest http, SimulationHost h) =>
        {
            FaultRequest? req = null;
            if (http.ContentLength is > 0 || http.Headers.TransferEncoding.Count > 0)
            {
                try
                {
                    req = await JsonSerializer.DeserializeAsync<FaultRequest>(http.Body, TwinJson.Options, http.HttpContext.RequestAborted);
                }
                catch (JsonException ex)
                {
                    return Problem(StatusCodes.Status400BadRequest, "Bad Request", $"Invalid FaultRequest body: {ex.Message}");
                }
            }
            return Guard(() => h.InjectFault(id, req?.DurationS));
        });
        assets.MapDelete("/fault", (string id, SimulationHost h) => Guard(() => h.ClearFault(id)));
        assets.MapPost("/maintenance", (string id, ToggleRequest req, SimulationHost h) => Guard(() => h.SetMaintenance(id, req.On)));
        assets.MapPost("/enable", (string id, ToggleRequest req, SimulationHost h) => Guard(() => h.SetEnabled(id, req.On)));

        api.MapPost("/alarms/{id}/ack", (string id, SimulationHost h) => Guard(() => h.AcknowledgeAlarm(id)));

        api.MapPost("/whatif", async (WhatIfRequest req, SimulationHost h, CancellationToken ct) =>
        {
            try
            {
                return (IResult)TypedResults.Ok(await h.RunWhatIfAsync(req, ct));
            }
            catch (Exception ex) when (TwinErrors.TryMap(ex, out var status, out var title))
            {
                return Problem(status, title, ex.Message);
            }
        });

        api.MapGet("/export/csv", (double? seconds, SimulationHost h) =>
        {
            try
            {
                var (fileName, table) = h.ExportHistory(seconds ?? 3600);
                return Results.File(Encoding.UTF8.GetBytes(table.ToCsv()), "text/csv; charset=utf-8", fileName);
            }
            catch (Exception ex) when (TwinErrors.TryMap(ex, out var status, out var title))
            {
                return Problem(status, title, ex.Message);
            }
        });

        return app;
    }

    /// <summary>Run a host call; map domain exceptions to RFC 7807 problem+json (404 / 400 / 409).</summary>
    private static IResult Guard<T>(Func<T> call)
    {
        try
        {
            return TypedResults.Ok(call());
        }
        catch (Exception ex) when (TwinErrors.TryMap(ex, out var status, out var title))
        {
            return Problem(status, title, ex.Message);
        }
    }

    internal static IResult Problem(int status, string title, string detail) =>
        TypedResults.Problem(detail: detail, statusCode: status, title: title);

    private static string ResolveVersion()
    {
        var asm = typeof(ApiEndpoints).Assembly;
        var info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrEmpty(info)) return info.Split('+')[0];
        return asm.GetName().Version?.ToString(3) ?? "0.0.0";
    }
}
