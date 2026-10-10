using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using TwinLabs.Api.Hosting;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Core.Validation;

namespace TwinLabs.Api.Tests;

/// <summary>A temp folder of templates, deleted on dispose.</summary>
public sealed class TemplateFolder : IDisposable
{
    public string Dir { get; } = Path.Combine(Path.GetTempPath(), "twinlabs-templates-" + Guid.NewGuid().ToString("N"));

    public TemplateFolder()
    {
        Directory.CreateDirectory(Dir);
        Write("cell", PlantApiTests.SmallPlant("cell"));
        File.WriteAllText(Path.Combine(Dir, "cell.meta.json"), """{"description":"A tiny machining cell.","tags":["machining","starter"]}""");
        Write("alpha", PlantApiTests.SmallPlant("alpha") with { Name = "Alpha line" }); // no meta file
        File.WriteAllText(Path.Combine(Dir, "broken.json"), "{ not json");
        File.WriteAllText(Path.Combine(Dir, "orphan.meta.json"), """{"description":"meta without a template"}""");
        File.WriteAllText(Path.Combine(Dir, "readme.txt"), "ignored");
    }

    public void Write(string id, PlantModel plant) => File.WriteAllText(Path.Combine(Dir, id + ".json"), TwinJson.Serialize(plant));

    public void Dispose()
    {
        try { Directory.Delete(Dir, true); } catch { /* best effort */ }
    }
}

public class TemplateCatalogTests
{
    private static WebApplicationFactory<Program> WithCatalog(TwinApiFactory f, TemplateCatalog catalog) =>
        f.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton(catalog)));

    [Fact]
    public void Lists_templates_sorted_with_meta_and_asset_count()
    {
        using var folder = new TemplateFolder();
        var list = new TemplateCatalog(folder.Dir).List();

        Assert.Equal(["alpha", "cell"], list.Select(t => t.Id));
        var cell = list[1];
        Assert.Equal("Small cell", cell.Name);
        Assert.Equal("A tiny machining cell.", cell.Description);
        Assert.Equal(["machining", "starter"], cell.Tags);
        Assert.Equal(3, cell.AssetCount);

        var alpha = list[0];
        Assert.Equal("Alpha line", alpha.Name);
        Assert.Equal("", alpha.Description);
        Assert.Empty(alpha.Tags);
    }

    [Fact]
    public void Get_returns_a_copy_or_null()
    {
        using var folder = new TemplateFolder();
        var catalog = new TemplateCatalog(folder.Dir);
        var a = catalog.Get("cell")!;
        Assert.Equal("cell", a.Id);
        ((Dictionary<string, double>)a.Assets[1].Params)["cycleTimeS"] = 999;
        Assert.Equal(25, catalog.Get("cell")!.Assets[1].Params["cycleTimeS"]);
        Assert.Null(catalog.Get("nope"));
        Assert.Null(catalog.Get("broken"));
        Assert.Null(catalog.Get("cell.meta"));
        Assert.Null(catalog.Get("orphan.meta"));
    }

    [Fact]
    public void Missing_folder_is_an_empty_catalog() =>
        Assert.Empty(new TemplateCatalog(Path.Combine(Path.GetTempPath(), "nope-" + Guid.NewGuid())).List());

    [Fact]
    public void Watching_catalog_rereads_changed_files()
    {
        using var folder = new TemplateFolder();
        var catalog = new TemplateCatalog(folder.Dir, watch: true);
        Assert.Equal(2, catalog.List().Count);

        folder.Write("zeta", PlantApiTests.SmallPlant("zeta"));
        Assert.Equal(["alpha", "cell", "zeta"], catalog.List().Select(t => t.Id));

        var bigger = PlantApiTests.SmallPlant("alpha");
        bigger = bigger with { Name = "Alpha v2" };
        folder.Write("alpha", bigger);
        File.SetLastWriteTimeUtc(Path.Combine(folder.Dir, "alpha.json"), DateTime.UtcNow.AddMinutes(1));
        Assert.Equal("Alpha v2", catalog.List()[0].Name);

        File.Delete(Path.Combine(folder.Dir, "zeta.json"));
        Assert.Equal(2, catalog.List().Count);
    }

    [Fact]
    public void Non_watching_catalog_caches()
    {
        using var folder = new TemplateFolder();
        var catalog = new TemplateCatalog(folder.Dir);
        Assert.Equal(2, catalog.List().Count);
        folder.Write("zeta", PlantApiTests.SmallPlant("zeta"));
        Assert.Equal(2, catalog.List().Count);
    }

    [Fact]
    public void Development_resolves_the_repo_folder()
    {
        var dir = TemplateCatalog.ResolveDirectory(AppContext.BaseDirectory, isDevelopment: true);
        Assert.EndsWith(Path.Combine("contracts", "plant", "templates"), dir);
        Assert.Equal(Path.Combine(AppContext.BaseDirectory, "plant", "templates"),
            TemplateCatalog.ResolveDirectory(AppContext.BaseDirectory, isDevelopment: false));
    }

    [Fact]
    public async Task Get_templates_lists_template_info()
    {
        using var folder = new TemplateFolder();
        await using var f = new TwinApiFactory();
        using var app = WithCatalog(f, new TemplateCatalog(folder.Dir));
        var res = await app.CreateClient().GetAsync("/api/templates");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync())!.AsArray();
        Assert.Equal(2, json.Count);
        var cell = json.First(t => (string?)t!["id"] == "cell")!;
        ContractShape.AssertSameFields(ContractShape.Example("template.info.json"), cell, "template");
        Assert.Equal(3, (int)cell["assetCount"]!);
        Assert.Equal("machining", (string?)cell["tags"]![0]);
    }

    [Fact]
    public async Task Get_template_by_id_returns_a_plant_that_can_be_applied()
    {
        using var folder = new TemplateFolder();
        await using var f = new TwinApiFactory();
        using var app = WithCatalog(f, new TemplateCatalog(folder.Dir));
        var c = app.CreateClient();

        var res = await c.GetAsync("/api/templates/cell");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var plant = TwinJson.Deserialize<PlantModel>(await res.Content.ReadAsStringAsync());
        Assert.Equal("cell", plant.Id);
        Assert.True(PlantValidator.Validate(plant).Ok);

        var put = await c.PutAsync("/api/plant", new StringContent(TwinJson.Serialize(plant), System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
    }

    [Theory]
    [InlineData("nope")]
    [InlineData("broken")]
    [InlineData("cell.meta")]
    public async Task Unknown_template_is_problem_404(string id)
    {
        using var folder = new TemplateFolder();
        await using var f = new TwinApiFactory();
        using var app = WithCatalog(f, new TemplateCatalog(folder.Dir));
        var res = await app.CreateClient().GetAsync($"/api/templates/{id}");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Default_catalog_serves_the_repo_templates()
    {
        await using var f = new TwinApiFactory();
        var res = await f.CreateClient().GetAsync("/api/templates");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var list = TwinJson.Deserialize<List<TemplateInfo>>(await res.Content.ReadAsStringAsync());
        // The templates arrive from another branch; whatever is there must be fetchable.
        foreach (var t in list)
        {
            var one = await f.CreateClient().GetAsync($"/api/templates/{t.Id}");
            Assert.Equal(HttpStatusCode.OK, one.StatusCode);
        }
    }
}
