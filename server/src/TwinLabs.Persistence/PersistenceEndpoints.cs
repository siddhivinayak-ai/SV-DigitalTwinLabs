using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.WebUtilities;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence;

/// <summary>
/// REST for scenarios, layouts, meshes and history. Bodies use <see cref="TwinJson.Options"/>; every error is
/// problem+json (400 invalid input, 404 missing, 413 mesh too large).
/// </summary>
internal static class PersistenceEndpoints
{
    public const int DefaultLimit = 200;
    public const int MaxLimit = 5000;

    public static void Map(IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api").AddEndpointFilter(ProblemFilter);

        // ---- scenarios ----
        api.MapGet("/scenarios", (IScenarioStore s) => Json(s.List()));
        api.MapPost("/scenarios", async (HttpContext ctx, IScenarioStore s) =>
        {
            var sc = s.Save(await ReadBody<SaveScenarioRequest>(ctx));
            return Created(ctx, $"/api/scenarios/{sc.Id}", sc);
        });
        api.MapGet("/scenarios/{id}", (string id, IScenarioStore s) =>
            s.Get(id) is { } sc ? Json(sc) : NotFound("scenario", id));
        api.MapDelete("/scenarios/{id}", (string id, IScenarioStore s) =>
            s.Delete(id) ? Results.NoContent() : NotFound("scenario", id));

        // ---- layouts ----
        api.MapGet("/layouts", (ILayoutStore s) => Json(s.List()));
        api.MapPost("/layouts", async (HttpContext ctx, ILayoutStore s) =>
        {
            var l = s.Save(await ReadBody<SaveLayoutRequest>(ctx));
            return Created(ctx, $"/api/layouts/{l.Id}", l);
        });
        api.MapGet("/layouts/{id}", (string id, ILayoutStore s) =>
            s.Get(id) is { } l ? Json(l) : NotFound("layout", id));
        api.MapPut("/layouts/{id}", async (string id, HttpContext ctx, ILayoutStore s) =>
            s.Update(id, await ReadBody<SaveLayoutRequest>(ctx)) is { } l ? Json(l) : NotFound("layout", id));
        api.MapDelete("/layouts/{id}", (string id, ILayoutStore s) =>
            s.Delete(id) ? Results.NoContent() : NotFound("layout", id));

        // ---- meshes ----
        api.MapGet("/meshes", (IMeshStore s) => Json(s.List()));
        api.MapPost("/meshes", async (HttpContext ctx, IMeshStore s) =>
        {
            if (ctx.Request.ContentLength > TwinDataOptions.MaxMeshBytes) throw new MeshTooLargeException(TwinDataOptions.MaxMeshBytes);
            var m = await s.SaveAsync(ctx.Request.Query["name"].ToString(), ctx.Request.Body, ctx.RequestAborted);
            return Created(ctx, $"/api/meshes/{m.Id}", m);
        }).WithMetadata(new MeshSizeLimit());
        api.MapGet("/meshes/{id}/file", (string id, IMeshStore s) =>
            s.Open(id) is { } f ? Results.Stream(f.Stream, f.ContentType) : NotFound("mesh", id));
        api.MapDelete("/meshes/{id}", (string id, IMeshStore s) =>
            s.Delete(id) ? Results.NoContent() : NotFound("mesh", id));

        // ---- history ----
        api.MapGet("/history/events", (HttpContext ctx, IHistoryStore s) =>
            Json(s.Events(Limit(ctx), OptionalLong(ctx, "beforeId"))));
        api.MapGet("/history/alarms", (HttpContext ctx, IHistoryStore s) => Json(s.Alarms(Limit(ctx))));
    }

    private sealed class MeshSizeLimit : IRequestSizeLimitMetadata
    {
        public long? MaxRequestBodySize => TwinDataOptions.MaxMeshBytes;
    }

    private static async ValueTask<object?> ProblemFilter(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        try
        {
            return await next(ctx);
        }
        catch (MeshTooLargeException ex)
        {
            return Problem(StatusCodes.Status413PayloadTooLarge, ex.Message);
        }
        catch (BadHttpRequestException ex)
        {
            // Kestrel enforcing the request size limit, or a malformed request
            return Problem(ex.StatusCode, ex.StatusCode == StatusCodes.Status413PayloadTooLarge
                ? new MeshTooLargeException(TwinDataOptions.MaxMeshBytes).Message
                : ex.Message);
        }
        catch (ArgumentException ex)
        {
            return Problem(StatusCodes.Status400BadRequest, ex is ArgumentOutOfRangeException { ParamName: "limit" }
                ? "limit must be at least 1."
                : ex.Message);
        }
        catch (KeyNotFoundException ex)
        {
            return Problem(StatusCodes.Status404NotFound, ex.Message);
        }
    }

    private static async Task<T> ReadBody<T>(HttpContext ctx) where T : class
    {
        try
        {
            return await JsonSerializer.DeserializeAsync<T>(ctx.Request.Body, TwinJson.Options, ctx.RequestAborted)
                   ?? throw new ArgumentException("Body is required.");
        }
        catch (JsonException ex)
        {
            throw new ArgumentException($"Invalid JSON body: {ex.Message}");
        }
    }

    private static int Limit(HttpContext ctx)
    {
        var raw = ctx.Request.Query["limit"].ToString();
        if (string.IsNullOrEmpty(raw)) return DefaultLimit;
        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var limit))
            throw new ArgumentException("limit must be an integer.");
        if (limit < 1) throw new ArgumentException("limit must be at least 1.");
        return Math.Min(limit, MaxLimit);
    }

    private static long? OptionalLong(HttpContext ctx, string key)
    {
        var raw = ctx.Request.Query[key].ToString();
        if (string.IsNullOrEmpty(raw)) return null;
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v)
            ? v
            : throw new ArgumentException($"{key} must be an integer.");
    }

    private static IResult Json<T>(T value, int status = StatusCodes.Status200OK) =>
        Results.Json(value, TwinJson.Options, statusCode: status);

    private static IResult Created<T>(HttpContext ctx, string location, T value)
    {
        ctx.Response.Headers.Location = location;
        return Json(value, StatusCodes.Status201Created);
    }

    private static IResult NotFound(string what, string id) =>
        Problem(StatusCodes.Status404NotFound, $"Unknown {what} '{id}'");

    private static IResult Problem(int status, string detail) =>
        Results.Problem(detail: detail, statusCode: status, title: ReasonPhrases.GetReasonPhrase(status));
}
