using TwinLabs.Core;
using TwinLabs.Core.Contracts;

// STUB (Phase 0): the real host lands on feature/api-server.
var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureHttpJsonOptions(o => TwinJson.Configure(o.SerializerOptions));
var app = builder.Build();

app.MapGet("/api/health", () => new HealthData("ok", "0.1.0"));

app.Run();

public partial class Program;
