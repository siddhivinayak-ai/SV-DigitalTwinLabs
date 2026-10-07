using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using TwinLabs.Core;

namespace TwinLabs.Persistence.Tests;

public sealed class RegistrationTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static ServiceProvider Build(Dictionary<string, string?> settings)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        return new ServiceCollection().AddLogging().AddTwinPersistence(config).BuildServiceProvider();
    }

    [Fact]
    public async Task Enabled_registers_sqlite_stores_and_the_sink_is_the_history_store()
    {
        await using var sp = Build(new() { ["Twin:Data:Enabled"] = "true", ["Twin:Data:Path"] = Path.Combine(_dir.Path, "d") });
        Assert.IsType<SqliteHistoryStore>(sp.GetRequiredService<IHistoryStore>());
        Assert.Same(sp.GetRequiredService<IHistoryStore>(), Assert.Single(sp.GetServices<IHostEventSink>()));
        Assert.IsType<SqliteScenarioStore>(sp.GetRequiredService<IScenarioStore>());
        Assert.IsType<SqliteLayoutStore>(sp.GetRequiredService<ILayoutStore>());
        var mesh = Assert.IsType<FileMeshStore>(sp.GetRequiredService<IMeshStore>());
        Assert.Equal(Path.Combine(_dir.Path, "d", "meshes"), mesh.Directory);
        Assert.Equal(Path.Combine(_dir.Path, "d", "twinlabs.db"), sp.GetRequiredService<SqliteDatabase>().FilePath);
        Assert.Contains(sp.GetServices<IHostedService>(), s => s is HistoryWriterService);
        Assert.False(Directory.Exists(Path.Combine(_dir.Path, "d")), "nothing is created until the first write");
    }

    [Fact]
    public async Task Disabled_registers_in_memory_stores()
    {
        await using var sp = Build(new() { ["Twin:Data:Enabled"] = "false", ["Twin:Data:Path"] = Path.Combine(_dir.Path, "d") });
        Assert.IsType<InMemoryHistoryStore>(sp.GetRequiredService<IHistoryStore>());
        Assert.Same(sp.GetRequiredService<IHistoryStore>(), sp.GetRequiredService<IHostEventSink>());
        Assert.IsType<InMemoryScenarioStore>(sp.GetRequiredService<IScenarioStore>());
        Assert.IsType<InMemoryLayoutStore>(sp.GetRequiredService<ILayoutStore>());
        Assert.IsType<InMemoryMeshStore>(sp.GetRequiredService<IMeshStore>());
    }

    [Fact]
    public void Options_defaults_and_resolution()
    {
        var empty = new ConfigurationBuilder().Build();
        var o = TwinDataOptions.FromConfiguration(empty, _dir.Path, "Production");
        Assert.Equal(Path.Combine(_dir.Path, "data"), o.Path);
        Assert.Equal(Path.Combine(_dir.Path, "data", "twinlabs.db"), o.DatabaseFile);
        Assert.Equal(100_000, o.HistoryRetention);
        // Under a test runner (this process) an unset Enabled means in-memory, so host tests never write data/.
        Assert.False(o.Enabled);
        Assert.False(TwinDataOptions.FromConfiguration(empty, _dir.Path, "Testing").Enabled);

        var set = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Twin:Data:Enabled"] = "true", ["Twin:Data:Path"] = "store", ["Twin:Data:HistoryRetention"] = "500",
        }).Build();
        var o2 = TwinDataOptions.FromConfiguration(set, _dir.Path, "Testing");
        Assert.True(o2.Enabled);
        Assert.Equal(Path.Combine(_dir.Path, "store"), o2.Path);
        Assert.Equal(500, o2.HistoryRetention);
    }
}
