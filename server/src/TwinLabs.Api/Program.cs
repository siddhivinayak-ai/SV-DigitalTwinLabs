using TwinLabs.Api.Endpoints;
using TwinLabs.Api.Hosting;
using TwinLabs.Api.Realtime;
using TwinLabs.Core;

const string DevCors = "dev";

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o => TwinJson.Configure(o.SerializerOptions));
builder.Services.AddProblemDetails();
builder.Services.AddCors(o => o.AddPolicy(DevCors, p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
builder.Services.AddTwinLabs(builder.Configuration);

var app = builder.Build();

// Anything not handled at the endpoint becomes problem+json; malformed bodies stay 400 (not 500).
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    StatusCodeSelector = ex => ex switch
    {
        BadHttpRequestException b => b.StatusCode,
        _ when TwinErrors.TryMap(ex, out var status, out _) => status,
        _ => StatusCodes.Status500InternalServerError,
    },
});
app.UseStatusCodePages();
if (app.Environment.IsDevelopment()) app.UseCors(DevCors);
app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(15),
    KeepAliveTimeout = TimeSpan.FromSeconds(30),
});
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapTwinApi();
app.MapTwinHub("/ws");
app.MapSpaFallback();

app.Run();

public partial class Program;
