using System.Globalization;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Persistence.Tests;

public sealed class ScenarioLayoutStoreTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly ManualTime _time = new(new DateTimeOffset(2026, 10, 7, 9, 30, 0, TimeSpan.Zero));

    public void Dispose() => _dir.Dispose();

    public static TheoryData<string> Kinds => ["sqlite", "memory"];

    private IScenarioStore Scenarios(string kind) =>
        kind == "sqlite" ? new SqliteScenarioStore(_dir.NewDatabase(), _time) : new InMemoryScenarioStore(_time);

    private ILayoutStore Layouts(string kind) =>
        kind == "sqlite" ? new SqliteLayoutStore(_dir.NewDatabase(), _time) : new InMemoryLayoutStore(_time);

    private static void AssertId(string id) => Assert.Matches("^[0-9a-f]{8}$", id);

    private static void AssertIsoUtc(string s) =>
        Assert.True(DateTime.TryParseExact(s, "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture, DateTimeStyles.None, out _), s);

    [Theory, MemberData(nameof(Kinds))]
    public void Scenario_round_trips_the_contract_example(string kind)
    {
        var store = Scenarios(kind);
        var example = Examples.Load<Scenario>("scenario.json");
        var result = Examples.Load<WhatIfResult>("whatif.result.json");

        var saved = store.Save(new SaveScenarioRequest(example.Name, example.Request, result));
        AssertId(saved.Id);
        Assert.Equal("2026-10-07T09:30:00Z", saved.CreatedAtUtc);

        var got = store.Get(saved.Id)!;
        var expected = Examples.Node("scenario.json");
        expected["id"] = saved.Id;
        var actual = Examples.ToNode(got with { Result = null });
        Assert.True(Examples.SameJson(expected, actual), actual.ToJsonString());
        Assert.True(Examples.SameJson(Examples.Node("whatif.result.json"), Examples.ToNode(got.Result)));

        var summary = Assert.Single(store.List());
        Assert.Equal(new ScenarioSummary(saved.Id, example.Name, saved.CreatedAtUtc, 28800, 1), summary);

        Assert.True(store.Delete(saved.Id));
        Assert.False(store.Delete(saved.Id));
        Assert.Null(store.Get(saved.Id));
        Assert.Empty(store.List());
    }

    [Theory, MemberData(nameof(Kinds))]
    public void Scenarios_list_newest_first(string kind)
    {
        var store = Scenarios(kind);
        var req = new WhatIfRequest(60, []);
        var a = store.Save(new SaveScenarioRequest("a", req));
        _time.Advance(TimeSpan.FromMinutes(1));
        var b = store.Save(new SaveScenarioRequest("b", req));
        var c = store.Save(new SaveScenarioRequest("c", req)); // same second as b
        Assert.Equal([c.Id, b.Id, a.Id], store.List().Select(s => s.Id));
        AssertIsoUtc(a.CreatedAtUtc);
    }

    [Theory, MemberData(nameof(Kinds))]
    public void Scenario_validation(string kind)
    {
        var store = Scenarios(kind);
        Assert.Throws<ArgumentException>(() => store.Save(new SaveScenarioRequest("  ", new WhatIfRequest(60, []))));
        Assert.Throws<ArgumentException>(() => store.Save(new SaveScenarioRequest("x", null!)));
        Assert.Throws<ArgumentException>(() => store.Save(new SaveScenarioRequest("x", new WhatIfRequest(0, []))));
        var s = store.Save(new SaveScenarioRequest("  trimmed  ", new WhatIfRequest(60, null!)));
        Assert.Equal("trimmed", s.Name);
        Assert.Empty(store.Get(s.Id)!.Request.Overrides);
        Assert.Null(store.Get("nope"));
        Assert.Null(store.Get("../../etc"));
    }

    [Fact]
    public void Sqlite_scenarios_survive_a_new_store_instance()
    {
        var db = _dir.NewDatabase();
        var saved = new SqliteScenarioStore(db).Save(new SaveScenarioRequest("keep", new WhatIfRequest(60, [])));
        var reopened = new SqliteScenarioStore(new SqliteDatabase(db.FilePath));
        Assert.Equal("keep", reopened.Get(saved.Id)!.Name);
    }

    [Theory, MemberData(nameof(Kinds))]
    public void Layout_round_trips_the_contract_example_and_derives_asset_count(string kind)
    {
        var store = Layouts(kind);
        var example = Examples.Load<Layout>("layout.json");

        var saved = store.Save(new SaveLayoutRequest(example.Name, example.Plant));
        AssertId(saved.Id);
        var expected = Examples.Node("layout.json");
        expected["id"] = saved.Id;
        expected["updatedAtUtc"] = saved.UpdatedAtUtc;
        Assert.True(Examples.SameJson(expected, Examples.ToNode(store.Get(saved.Id))));
        Assert.Equal(new LayoutSummary(saved.Id, "Cell 1 draft", "2026-10-07T09:30:00Z", 2), Assert.Single(store.List()));

        _time.Advance(TimeSpan.FromMinutes(30));
        var smaller = example.Plant with { Assets = [example.Plant.Assets[0]] };
        var updated = store.Update(saved.Id, new SaveLayoutRequest("Renamed", smaller))!;
        Assert.Equal("2026-10-07T10:00:00Z", updated.UpdatedAtUtc);
        Assert.Equal(new LayoutSummary(saved.Id, "Renamed", "2026-10-07T10:00:00Z", 1), Assert.Single(store.List()));
        Assert.Single(store.Get(saved.Id)!.Plant.Assets);

        Assert.Null(store.Update("ffffffff", new SaveLayoutRequest("x", smaller)));
        Assert.Throws<ArgumentException>(() => store.Update(saved.Id, new SaveLayoutRequest("", smaller)));
        Assert.Throws<ArgumentException>(() => store.Save(new SaveLayoutRequest("x", null!)));

        Assert.True(store.Delete(saved.Id));
        Assert.False(store.Delete(saved.Id));
        Assert.Null(store.Get(saved.Id));
    }

    [Fact]
    public void Sqlite_reads_on_an_empty_folder_do_not_create_the_database()
    {
        var db = _dir.NewDatabase();
        Assert.Empty(new SqliteScenarioStore(db).List());
        Assert.Empty(new SqliteLayoutStore(db).List());
        Assert.False(new SqliteLayoutStore(db).Delete("abcdef12"));
        Assert.False(File.Exists(db.FilePath));
    }

    [Fact]
    public void Json_columns_use_twinjson()
    {
        var db = _dir.NewDatabase();
        var example = Examples.Load<Layout>("layout.json");
        var saved = new SqliteLayoutStore(db).Save(new SaveLayoutRequest("x", example.Plant));
        using var c = db.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT plant_json FROM layouts WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", saved.Id);
        Assert.Equal(TwinJson.Serialize(example.Plant), cmd.ExecuteScalar() as string);
    }
}
