using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence.Tests;

/// <summary>Minimal WebApplication on TestServer with only AddTwinPersistence + MapPersistenceEndpoints.</summary>
public sealed class PersistenceApp : IAsyncDisposable
{
    private readonly WebApplication _app;
    public HttpClient Client { get; }
    public IServiceProvider Services => _app.Services;

    private PersistenceApp(WebApplication app)
    {
        _app = app;
        Client = app.GetTestClient();
    }

    public static async Task<PersistenceApp> StartAsync(string dataPath, bool enabled = true)
    {
        var b = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production", ContentRootPath = dataPath });
        b.WebHost.UseTestServer();
        b.Configuration["Twin:Data:Enabled"] = enabled ? "true" : "false";
        b.Configuration["Twin:Data:Path"] = Path.Combine(dataPath, "data");
        b.Services.AddProblemDetails();
        b.Services.AddTwinPersistence(b.Configuration);
        var app = b.Build();
        app.MapPersistenceEndpoints();
        await app.StartAsync();
        return new PersistenceApp(app);
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}

public sealed class EndpointTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static StringContent JsonBody(object value) => new(TwinJson.Serialize(value), Encoding.UTF8, "application/json");

    private static async Task<T> Read<T>(HttpResponseMessage r) => TwinJson.Deserialize<T>(await r.Content.ReadAsStringAsync());

    private static async Task AssertProblem(HttpResponseMessage r, HttpStatusCode status)
    {
        Assert.Equal(status, r.StatusCode);
        Assert.Equal("application/problem+json", r.Content.Headers.ContentType?.MediaType);
        var body = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        Assert.Equal((int)status, (int)body["status"]!);
        Assert.False(string.IsNullOrEmpty((string?)body["detail"]));
    }

    public static TheoryData<bool> Backends => [true, false];

    [Theory, MemberData(nameof(Backends))]
    public async Task Scenario_crud(bool sqlite)
    {
        await using var app = await PersistenceApp.StartAsync(_dir.Path, sqlite);
        var c = app.Client;
        var example = Examples.Load<Scenario>("scenario.json");

        var created = await c.PostAsync("/api/scenarios", JsonBody(new SaveScenarioRequest(example.Name, example.Request)));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var sc = await Read<Scenario>(created);
        Assert.Equal($"/api/scenarios/{sc.Id}", created.Headers.Location?.OriginalString);
        Assert.True(Examples.SameJson(Examples.Node("scenario.json")["request"], Examples.ToNode(sc.Request)));

        var list = await Read<ScenarioSummary[]>(await c.GetAsync("/api/scenarios"));
        Assert.Equal(sc.Id, Assert.Single(list).Id);
        var got = await c.GetAsync($"/api/scenarios/{sc.Id}");
        Assert.Equal(HttpStatusCode.OK, got.StatusCode);
        Assert.Equal(sc.Name, (await Read<Scenario>(got)).Name);

        Assert.Equal(HttpStatusCode.NoContent, (await c.DeleteAsync($"/api/scenarios/{sc.Id}")).StatusCode);
        await AssertProblem(await c.DeleteAsync($"/api/scenarios/{sc.Id}"), HttpStatusCode.NotFound);
        await AssertProblem(await c.GetAsync($"/api/scenarios/{sc.Id}"), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Scenario_invalid_input_is_400_problem()
    {
        await using var app = await PersistenceApp.StartAsync(_dir.Path);
        var c = app.Client;
        await AssertProblem(await c.PostAsync("/api/scenarios", JsonBody(new SaveScenarioRequest("", new WhatIfRequest(60, [])))), HttpStatusCode.BadRequest);
        await AssertProblem(await c.PostAsync("/api/scenarios", new StringContent("{not json", Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest);
        await AssertProblem(await c.PostAsync("/api/scenarios", new StringContent("{\"name\":\"x\"}", Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest);
        await AssertProblem(await c.PostAsync("/api/scenarios", new StringContent("", Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest);
    }

    [Theory, MemberData(nameof(Backends))]
    public async Task Layout_crud(bool sqlite)
    {
        await using var app = await PersistenceApp.StartAsync(_dir.Path, sqlite);
        var c = app.Client;
        var example = Examples.Load<Layout>("layout.json");

        var created = await c.PostAsync("/api/layouts", JsonBody(new SaveLayoutRequest(example.Name, example.Plant)));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var l = await Read<Layout>(created);
        Assert.Equal($"/api/layouts/{l.Id}", created.Headers.Location?.OriginalString);
        Assert.True(Examples.SameJson(Examples.Node("layout.json")["plant"], Examples.ToNode(l.Plant)));

        Assert.Equal(2, Assert.Single(await Read<LayoutSummary[]>(await c.GetAsync("/api/layouts"))).AssetCount);

        var put = await c.PutAsync($"/api/layouts/{l.Id}", JsonBody(new SaveLayoutRequest("Renamed", example.Plant)));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        Assert.Equal("Renamed", (await Read<Layout>(put)).Name);
        Assert.Equal("Renamed", (await Read<Layout>(await c.GetAsync($"/api/layouts/{l.Id}"))).Name);

        await AssertProblem(await c.PutAsync("/api/layouts/abcdef01", JsonBody(new SaveLayoutRequest("x", example.Plant))), HttpStatusCode.NotFound);
        await AssertProblem(await c.PutAsync($"/api/layouts/{l.Id}", JsonBody(new SaveLayoutRequest(" ", example.Plant))), HttpStatusCode.BadRequest);
        await AssertProblem(await c.PostAsync("/api/layouts", new StringContent("{\"name\":\"x\"}", Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest);

        Assert.Equal(HttpStatusCode.NoContent, (await c.DeleteAsync($"/api/layouts/{l.Id}")).StatusCode);
        await AssertProblem(await c.GetAsync($"/api/layouts/{l.Id}"), HttpStatusCode.NotFound);
        await AssertProblem(await c.DeleteAsync($"/api/layouts/{l.Id}"), HttpStatusCode.NotFound);
    }

    [Theory, MemberData(nameof(Backends))]
    public async Task Mesh_upload_list_file_delete(bool sqlite)
    {
        await using var app = await PersistenceApp.StartAsync(_dir.Path, sqlite);
        var c = app.Client;
        var bytes = Samples.Glb(4096);
        var body = new ByteArrayContent(bytes);
        body.Headers.ContentType = new MediaTypeHeaderValue("model/gltf-binary");

        var created = await c.PostAsync("/api/meshes?name=cnc-mill.glb", body);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var m = await Read<MeshInfo>(created);
        Assert.Equal($"/api/meshes/{m.Id}", created.Headers.Location?.OriginalString);
        Assert.Equal($"/api/meshes/{m.Id}/file", m.Url);
        Assert.Equal(new MeshInfo(m.Id, "cnc-mill.glb", m.Url, 4096), m);
        Assert.Equal(m, Assert.Single(await Read<MeshInfo[]>(await c.GetAsync("/api/meshes"))));

        var file = await c.GetAsync(m.Url);
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
        Assert.Equal("model/gltf-binary", file.Content.Headers.ContentType?.MediaType);
        Assert.Equal(bytes, await file.Content.ReadAsByteArrayAsync());

        Assert.Equal(HttpStatusCode.NoContent, (await c.DeleteAsync($"/api/meshes/{m.Id}")).StatusCode);
        await AssertProblem(await c.GetAsync(m.Url), HttpStatusCode.NotFound);
        await AssertProblem(await c.DeleteAsync($"/api/meshes/{m.Id}"), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Mesh_rejections()
    {
        await using var app = await PersistenceApp.StartAsync(_dir.Path);
        var c = app.Client;
        await AssertProblem(await c.PostAsync("/api/meshes?name=x.png", new ByteArrayContent("PNG!...."u8.ToArray())), HttpStatusCode.BadRequest);
        await AssertProblem(await c.PostAsync("/api/meshes", new ByteArrayContent(Samples.Glb(16))), HttpStatusCode.BadRequest); // no name

        // Declared too large: refused before reading.
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/meshes?name=big.glb") { Content = new StreamContent(new GeneratedStream(TwinDataOptions.MaxMeshBytes + 1)) };
        req.Content.Headers.ContentLength = TwinDataOptions.MaxMeshBytes + 1;
        await AssertProblem(await c.SendAsync(req), HttpStatusCode.RequestEntityTooLarge);

        // Chunked (no Content-Length): enforced while streaming.
        var chunked = new StreamContent(new GeneratedStream(TwinDataOptions.MaxMeshBytes + 1));
        await AssertProblem(await c.PostAsync("/api/meshes?name=big.glb", chunked), HttpStatusCode.RequestEntityTooLarge);

        Assert.Empty(await Read<MeshInfo[]>(await c.GetAsync("/api/meshes")));
    }

    [Fact]
    public async Task History_endpoints_page_newest_first_and_validate_limit()
    {
        await using var app = await PersistenceApp.StartAsync(_dir.Path);
        var c = app.Client;
        var sink = app.Services.GetRequiredService<IHostEventSink>();
        for (var i = 1; i <= 30; i++) sink.OnEvent(Samples.Event(i));
        sink.OnAlarm(Samples.Alarm());
        sink.OnAlarm(Samples.Alarm(active: false, clearedAt: 2000));
        await ((SqliteHistoryStore)app.Services.GetRequiredService<IHistoryStore>()).FlushAsync();

        var first = await Read<EventRecord[]>(await c.GetAsync("/api/history/events?limit=10"));
        Assert.Equal(10, first.Length);
        Assert.Equal("event 30", first[0].Message);
        var next = await Read<EventRecord[]>(await c.GetAsync($"/api/history/events?limit=10&beforeId={first[^1].Id}"));
        Assert.Equal("event 20", next[0].Message);
        Assert.Equal(30, (await Read<EventRecord[]>(await c.GetAsync("/api/history/events"))).Length);

        var alarms = await Read<Alarm[]>(await c.GetAsync("/api/history/alarms?limit=200"));
        Assert.Equal(2, alarms.Length);
        Assert.False(alarms[0].Active);

        await AssertProblem(await c.GetAsync("/api/history/events?limit=0"), HttpStatusCode.BadRequest);
        await AssertProblem(await c.GetAsync("/api/history/alarms?limit=-1"), HttpStatusCode.BadRequest);
        await AssertProblem(await c.GetAsync("/api/history/events?limit=abc"), HttpStatusCode.BadRequest);
        await AssertProblem(await c.GetAsync("/api/history/events?beforeId=x"), HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Json_bodies_use_camelCase_twinjson()
    {
        await using var app = await PersistenceApp.StartAsync(_dir.Path);
        var created = await app.Client.PostAsync("/api/scenarios", JsonBody(new SaveScenarioRequest("n", new WhatIfRequest(60, []))));
        var node = JsonNode.Parse(await created.Content.ReadAsStringAsync())!;
        Assert.NotNull(node["createdAtUtc"]);
        Assert.Null(node["result"]); // WhenWritingNull
        Assert.Equal("application/json", created.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Stopping_the_host_flushes_queued_history()
    {
        var app = await PersistenceApp.StartAsync(_dir.Path);
        app.Services.GetRequiredService<IHostEventSink>().OnEvent(Samples.Event(1));
        await app.DisposeAsync(); // hosted service StopAsync drains the queue

        var db = new SqliteDatabase(Path.Combine(_dir.Path, "data", "twinlabs.db"));
        await using var store = new SqliteHistoryStore(db);
        Assert.Single(store.Events(10));
    }
}
