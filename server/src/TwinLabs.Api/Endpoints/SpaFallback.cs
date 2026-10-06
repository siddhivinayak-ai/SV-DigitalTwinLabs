namespace TwinLabs.Api.Endpoints;

public static class SpaFallback
{
    /// <summary>
    /// Unmatched non-file paths serve <c>wwwroot/index.html</c> (client-side routing). Unmatched <c>/api</c> and
    /// <c>/ws</c> paths get a problem+json 404 instead of the HTML shell.
    /// </summary>
    public static IEndpointRouteBuilder MapSpaFallback(this IEndpointRouteBuilder app)
    {
        app.MapFallback((HttpContext ctx, IWebHostEnvironment env) =>
        {
            var path = ctx.Request.Path;
            if (path.StartsWithSegments("/api") || path.StartsWithSegments("/ws"))
                return ApiEndpoints.Problem(StatusCodes.Status404NotFound, "Not Found", $"No endpoint for {ctx.Request.Method} {path}");

            var index = env.WebRootFileProvider.GetFileInfo("index.html");
            if (!index.Exists)
                return ApiEndpoints.Problem(StatusCodes.Status404NotFound, "Not Found",
                    "UI not built. Run `npm run build` in ui/ (outputs to wwwroot), or use the Vite dev server on :5173.");

            return Results.Stream(index.CreateReadStream(), "text/html; charset=utf-8");
        });
        return app;
    }
}
