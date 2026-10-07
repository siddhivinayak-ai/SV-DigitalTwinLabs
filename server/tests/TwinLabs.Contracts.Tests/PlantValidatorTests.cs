using System.Diagnostics;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Core.Validation;

namespace TwinLabs.Contracts.Tests;

public class PlantValidatorTests
{
    // ------------------------------------------------------------------ builders

    private static Dictionary<string, double> ParamsFor(AssetKind kind) => kind switch
    {
        AssetKind.Source => new() { ["arrivalIntervalS"] = 20 },
        AssetKind.Conveyor => new() { ["lengthM"] = 4, ["speedMps"] = 0.5, ["capacity"] = 4 },
        AssetKind.Buffer => new() { ["capacity"] = 5 },
        AssetKind.Machine or AssetKind.Robot or AssetKind.Inspection => new() { ["cycleTimeS"] = 15, ["mtbfS"] = 3600, ["mttrS"] = 120 },
        _ => new(),
    };

    private static AssetDef A(string id, AssetKind kind, double x, params string[] downstream) =>
        new(id, id, kind, new Vec3(x, 0, 0), 0, new Vec3(1, 1, 1), downstream, ParamsFor(kind));

    private static SensorDef S(string assetId, string? id = null, double? hi = 70, double? hiHi = 80) =>
        new(id ?? assetId + ".temp", assetId, SensorKind.Temperature, "°C", 0.01, hi, hiHi);

    /// <summary>SRC -> M -> SNK with one sensor on M. Clean.</summary>
    private static PlantModel Basic() => new("p", "Basic", 1, 1,
        [A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5, "SNK"), A("SNK", AssetKind.Sink, 10)],
        [S("M")]);

    private static PlantModel With(params AssetDef[] assets) => Basic() with
    {
        Assets = assets,
        Sensors = [.. assets.Where(a => a.Kind is AssetKind.Machine or AssetKind.Robot or AssetKind.Inspection).Select(a => S(a.Id))],
    };

    private static List<string> Codes(ValidationResult r) => [.. r.Issues.Select(i => i.Code).Distinct()];

    private static void AssertOnly(ValidationResult r, string code, string? assetId = null)
    {
        Assert.True(r.Issues.Count > 0, $"expected {code}, got no issues");
        Assert.All(r.Issues, i => Assert.Equal(code, i.Code));
        if (assetId is not null) Assert.Contains(r.Issues, i => i.AssetId == assetId);
        var critical = r.Issues[0].Severity == Severity.Critical;
        Assert.Equal(!critical, r.Ok);
        Assert.All(r.Issues, i => Assert.False(string.IsNullOrWhiteSpace(i.Message)));
    }

    private static string ContractsDir
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "contracts")))
                dir = dir.Parent;
            return Path.Combine(dir?.FullName ?? throw new DirectoryNotFoundException("contracts/"), "contracts");
        }
    }

    // ------------------------------------------------------------------ clean

    [Fact]
    public void Basic_plant_is_clean() => Assert.Empty(PlantValidator.Validate(Basic()).Issues);

    [Theory]
    [InlineData("plant/sample_line.json")]
    [InlineData("plant/sample_line.connected.json")]
    [InlineData("examples/plant.v03.json")]
    public void Sample_plants_have_no_critical_issues(string file)
    {
        var r = PlantValidator.Validate(TwinJson.LoadPlant(Path.Combine(ContractsDir, file)));
        Assert.True(r.Ok, string.Join("; ", r.Issues.Select(i => $"{i.Code}: {i.Message}")));
        Assert.DoesNotContain(r.Issues, i => i.Code == ValidationCodes.Overlap);
    }

    [Fact]
    public void Sample_lines_are_completely_clean()
    {
        foreach (var f in new[] { "sample_line.json", "sample_line.connected.json" })
            Assert.Empty(PlantValidator.Validate(TwinJson.LoadPlant(Path.Combine(ContractsDir, "plant", f))).Issues);
    }

    [Fact]
    public void Plant_v03_example_only_warns_about_the_unsensored_cnc()
    {
        var r = PlantValidator.Validate(TwinJson.LoadPlant(Path.Combine(ContractsDir, "examples", "plant.v03.json")));
        Assert.True(r.Ok);
        AssertOnly(r, ValidationCodes.NoSensors, "CNC-A");
    }

    [Fact]
    public void Every_template_in_contracts_has_no_critical_issues()
    {
        var dir = Path.Combine(ContractsDir, "plant", "templates");
        if (!Directory.Exists(dir)) return;
        foreach (var f in Directory.GetFiles(dir, "*.json").Where(f => !f.EndsWith(".meta.json", StringComparison.OrdinalIgnoreCase)))
        {
            var r = PlantValidator.Validate(TwinJson.LoadPlant(f));
            Assert.True(r.Ok, $"{Path.GetFileName(f)}: " + string.Join("; ", r.Issues.Select(i => $"{i.Code}: {i.Message}")));
            Assert.DoesNotContain(r.Issues, i => i.Code == ValidationCodes.Overlap);
        }
    }

    // ------------------------------------------------------------------ one test per code

    [Fact]
    public void EMPTY_PLANT() => AssertOnly(PlantValidator.Validate(Basic() with { Assets = [], Sensors = [] }), "EMPTY_PLANT");

    [Fact]
    public void DUPLICATE_ID_asset()
    {
        var p = With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5, "SNK"),
            A("M", AssetKind.Machine, 5, "SNK") with { Position = new Vec3(5, 0, 5) }, A("SNK", AssetKind.Sink, 10));
        p = p with { Sensors = [S("M")] };
        AssertOnly(PlantValidator.Validate(p), "DUPLICATE_ID", "M");
    }

    [Fact]
    public void DUPLICATE_ID_sensor() =>
        AssertOnly(PlantValidator.Validate(Basic() with { Sensors = [S("M"), S("M")] }), "DUPLICATE_ID", "M");

    [Fact]
    public void DUPLICATE_ID_line_resource_shift_connection()
    {
        Assert.Equal(["DUPLICATE_ID"], Codes(PlantValidator.Validate(Basic() with { Lines = [new("L", "a"), new("L", "b")] })));
        Assert.Equal(["DUPLICATE_ID"], Codes(PlantValidator.Validate(Basic() with
        { Resources = [new("R", "a", ResourceKind.Operator, 1), new("R", "b", ResourceKind.Agv, 1)] })));
        Assert.Equal(["DUPLICATE_ID"], Codes(PlantValidator.Validate(Basic() with
        { Calendar = new CalendarDef(6, [new("D", "a", 6, 14), new("D", "b", 14, 22)]) })));
        Assert.Equal(["DUPLICATE_ID"], Codes(PlantValidator.Validate(Basic() with
        { Connections = [new("C", ConnectionKind.Mqtt, "mqtt://h:1883"), new("C", ConnectionKind.Opcua, "opc.tcp://h:4840")] })));
    }

    [Theory]
    [InlineData("SNK 1")]
    [InlineData("SNK/1")]
    [InlineData("SNK#")]
    [InlineData("")]
    public void BAD_ID(string id)
    {
        var p = With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5, id), A(id, AssetKind.Sink, 10));
        AssertOnly(PlantValidator.Validate(p), "BAD_ID");
    }

    [Fact]
    public void BAD_ID_on_sensor_line_resource_shift() =>
        AssertOnly(PlantValidator.Validate(Basic() with
        {
            Sensors = [S("M", "M temp")],
            Lines = [new("line a", "A")],
            Resources = [new("r!", "R", ResourceKind.Tool, 1)],
            Calendar = new CalendarDef(6, [new("d ay", "Day", 6, 14)]),
        }), "BAD_ID");

    [Fact]
    public void NO_SOURCE() =>
        AssertOnly(PlantValidator.Validate(With(A("M", AssetKind.Machine, 5, "SNK"), A("SNK", AssetKind.Sink, 10))), "NO_SOURCE");

    [Fact]
    public void NO_SINK()
    {
        var r = PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5)));
        Assert.Contains(r.Issues, i => i.Code == "NO_SINK");
        // Without a sink the flow must end somewhere: the dead end is the only other issue.
        Assert.All(r.Issues, i => Assert.Contains(i.Code, new[] { "NO_SINK", "DEAD_END" }));
        Assert.False(r.Ok);
    }

    [Fact]
    public void UNKNOWN_DOWNSTREAM() =>
        AssertOnly(PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5, "SNK", "GHOST"),
            A("SNK", AssetKind.Sink, 10))), "UNKNOWN_DOWNSTREAM", "M");

    [Fact]
    public void SELF_LOOP() =>
        AssertOnly(PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5, "M", "SNK"),
            A("SNK", AssetKind.Sink, 10))), "SELF_LOOP", "M");

    [Fact]
    public void CYCLE()
    {
        var r = PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "A"), A("A", AssetKind.Machine, 3, "B"),
            A("B", AssetKind.Machine, 6, "C"), A("C", AssetKind.Machine, 9, "A", "SNK"), A("SNK", AssetKind.Sink, 12)));
        AssertOnly(r, "CYCLE", "A");
        var issue = Assert.Single(r.Issues);
        Assert.Contains("A, B, C", issue.Message); // names the members
    }

    [Fact]
    public void SOURCE_HAS_UPSTREAM() =>
        AssertOnly(PlantValidator.Validate(With(A("SRC1", AssetKind.Source, 0, "SRC2"), A("SRC2", AssetKind.Source, 3, "M"),
            A("M", AssetKind.Machine, 6, "SNK"), A("SNK", AssetKind.Sink, 10))), "SOURCE_HAS_UPSTREAM", "SRC2");

    [Fact]
    public void SINK_HAS_DOWNSTREAM() =>
        AssertOnly(PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5, "SNK1"),
            A("SNK1", AssetKind.Sink, 10, "SNK2"), A("SNK2", AssetKind.Sink, 14))), "SINK_HAS_DOWNSTREAM", "SNK1");

    [Fact]
    public void DEAD_END() =>
        AssertOnly(PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M", "M2"), A("M", AssetKind.Machine, 5),
            A("M2", AssetKind.Machine, 5, "SNK") with { Position = new Vec3(5, 0, 3) }, A("SNK", AssetKind.Sink, 10))), "DEAD_END", "M");

    [Fact]
    public void UNREACHABLE() =>
        AssertOnly(PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 5, "SNK"),
            A("X", AssetKind.Machine, 5, "SNK") with { Position = new Vec3(5, 0, 3) }, A("SNK", AssetKind.Sink, 10))), "UNREACHABLE", "X");

    [Fact]
    public void NO_SINK_REACHABLE()
    {
        // M2 -> M3 (dead end): M3 is the DEAD_END, M2 upstream of it has no path to a sink.
        var r = PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M", "M2"), A("M", AssetKind.Machine, 5, "SNK"),
            A("M2", AssetKind.Machine, 5, "M3") with { Position = new Vec3(5, 0, 3) },
            A("M3", AssetKind.Machine, 8, []) with { Position = new Vec3(8, 0, 3) }, A("SNK", AssetKind.Sink, 10)));
        var nsr = Assert.Single(r.Issues, i => i.Code == "NO_SINK_REACHABLE");
        Assert.Equal("M2", nsr.AssetId);
        Assert.Equal(Severity.Critical, nsr.Severity);
        Assert.Equal(["NO_SINK_REACHABLE", "DEAD_END"], Codes(r).Order().Reverse().ToList());
    }

    [Fact]
    public void NO_SINK_REACHABLE_in_a_closed_loop()
    {
        var r = PlantValidator.Validate(With(A("SRC", AssetKind.Source, 0, "M", "A"), A("M", AssetKind.Machine, 5, "SNK"),
            A("A", AssetKind.Machine, 5, "B") with { Position = new Vec3(5, 0, 3) },
            A("B", AssetKind.Machine, 8, "A") with { Position = new Vec3(8, 0, 3) }, A("SNK", AssetKind.Sink, 10)));
        Assert.Equal(["A", "B"], r.Issues.Where(i => i.Code == "NO_SINK_REACHABLE").Select(i => i.AssetId).Order());
        Assert.Contains(r.Issues, i => i.Code == "CYCLE");
    }

    [Theory]
    [InlineData(AssetKind.Source, "arrivalIntervalS")]
    [InlineData(AssetKind.Conveyor, "lengthM")]
    [InlineData(AssetKind.Conveyor, "speedMps")]
    [InlineData(AssetKind.Conveyor, "capacity")]
    [InlineData(AssetKind.Buffer, "capacity")]
    [InlineData(AssetKind.Machine, "cycleTimeS")]
    [InlineData(AssetKind.Robot, "cycleTimeS")]
    [InlineData(AssetKind.Inspection, "cycleTimeS")]
    public void MISSING_PARAM(AssetKind kind, string key)
    {
        var x = kind == AssetKind.Source ? A("SRC", kind, 0, "M") : A("X", kind, 5, "SNK");
        x = x with { Params = x.Params.Where(kv => kv.Key != key).ToDictionary() };
        var p = kind == AssetKind.Source
            ? With(x, A("M", AssetKind.Machine, 5, "SNK"), A("SNK", AssetKind.Sink, 10))
            : With(A("SRC", AssetKind.Source, 0, "X"), x, A("SNK", AssetKind.Sink, 10));
        var r = PlantValidator.Validate(p);
        AssertOnly(r, "MISSING_PARAM", x.Id);
        Assert.Contains(key, r.Issues[0].Message);
    }

    [Theory]
    [InlineData("scrapRate", 1.0)]
    [InlineData("scrapRate", -0.1)]
    [InlineData("rejectRate", 1.5)]
    [InlineData("cycleTimeS", 0)]
    [InlineData("mtbfS", -5)]
    [InlineData("cycleTimeStdS", -1)]
    [InlineData("ratedKw", -1)]
    [InlineData("capacity", 2.5)]
    [InlineData("capacity", 0)]
    [InlineData("warmupS", 0)]
    [InlineData("yieldRate", 2)]
    [InlineData("tempRiseC", double.NaN)]
    public void BAD_PARAM(string key, double value)
    {
        var p = Basic();
        p = p with { Assets = [.. p.Assets.Select(a => a.Id != "M" ? a : a with { Params = new Dictionary<string, double>(a.Params) { [key] = value } })] };
        AssertOnly(PlantValidator.Validate(p), "BAD_PARAM", "M");
    }

    [Fact]
    public void Free_form_params_are_accepted()
    {
        var p = Basic();
        p = p with { Assets = [.. p.Assets.Select(a => a.Id != "M" ? a : a with { Params = new Dictionary<string, double>(a.Params) { ["ambientC"] = -10, ["cycleTimeStdS"] = 0 } })] };
        Assert.Empty(PlantValidator.Validate(p).Issues);
    }

    [Fact]
    public void UNKNOWN_REF_sensor_asset() =>
        AssertOnly(PlantValidator.Validate(Basic() with { Sensors = [S("M"), S("GHOST")] }), "UNKNOWN_REF");

    [Theory]
    [InlineData("line")]
    [InlineData("resource")]
    [InlineData("shift")]
    public void UNKNOWN_REF_asset_fields(string field)
    {
        var p = Basic();
        p = p with
        {
            Assets = [.. p.Assets.Select(a => a.Id != "M" ? a : field switch
            {
                "line" => a with { LineId = "nope" },
                "resource" => a with { ResourceId = "nope" },
                _ => a with { ShiftId = "nope" },
            })],
        };
        var r = PlantValidator.Validate(p);
        AssertOnly(r, "UNKNOWN_REF", "M");
        Assert.Contains(field, r.Issues[0].Message);
    }

    [Theory]
    [InlineData(AssetKind.Source)]
    [InlineData(AssetKind.Conveyor)]
    [InlineData(AssetKind.Buffer)]
    [InlineData(AssetKind.Sink)]
    public void RESOURCE_KIND(AssetKind kind)
    {
        var x = kind switch
        {
            AssetKind.Source => A("SRC", kind, 0, "M"),
            AssetKind.Sink => A("SNK", kind, 10),
            _ => A("X", kind, 2.5, "M"),
        };
        x = x with { ResourceId = "ops" };
        var assets = new List<AssetDef> { kind == AssetKind.Source ? x : A("SRC", AssetKind.Source, 0, kind == AssetKind.Sink ? "M" : "X") };
        if (kind is AssetKind.Conveyor or AssetKind.Buffer) assets.Add(x);
        assets.Add(A("M", AssetKind.Machine, 5, "SNK"));
        assets.Add(kind == AssetKind.Sink ? x : A("SNK", AssetKind.Sink, 10));
        var p = With([.. assets]) with { Resources = [new("ops", "Operators", ResourceKind.Operator, 2)] };
        AssertOnly(PlantValidator.Validate(p), "RESOURCE_KIND", x.Id);
    }

    [Fact]
    public void Resource_on_machine_robot_inspection_is_fine()
    {
        var p = With(A("SRC", AssetKind.Source, 0, "M"), A("M", AssetKind.Machine, 3, "R") with { ResourceId = "ops" },
            A("R", AssetKind.Robot, 6, "Q") with { ResourceId = "ops" }, A("Q", AssetKind.Inspection, 9, "SNK") with { ResourceId = "ops" },
            A("SNK", AssetKind.Sink, 12)) with { Resources = [new("ops", "Operators", ResourceKind.Operator, 1)] };
        Assert.Empty(PlantValidator.Validate(p).Issues);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-3)]
    public void BAD_RESOURCE_COUNT(int count) =>
        AssertOnly(PlantValidator.Validate(Basic() with { Resources = [new("ops", "Operators", ResourceKind.Operator, count)] }), "BAD_RESOURCE_COUNT");

    [Theory]
    [InlineData(6, 6)]
    [InlineData(-1, 6)]
    [InlineData(22, 25)]
    [InlineData(double.NaN, 6)]
    public void BAD_SHIFT(double start, double end) =>
        AssertOnly(PlantValidator.Validate(Basic() with { Calendar = new CalendarDef(6, [new("d", "Day", start, end)]) }), "BAD_SHIFT");

    [Fact]
    public void Wrapping_shift_is_fine() =>
        Assert.Empty(PlantValidator.Validate(Basic() with { Calendar = new CalendarDef(0, [new("n", "Night", 22, 6), new("full", "All day", 0, 24)]) }).Issues);

    [Fact]
    public void BAD_SHIFT_calendar_start() =>
        AssertOnly(PlantValidator.Validate(Basic() with { Calendar = new CalendarDef(30, []) }), "BAD_SHIFT");

    public static TheoryData<string, BindingDef[], ConnectionDef[]> BadBindings => new()
    {
        { "BINDING_NO_ENDPOINT", [], [new("mq", ConnectionKind.Mqtt, " ")] },
        { "BINDING_BAD_TARGET", [new("motor:M", "mq", "a/b")], [Mqtt] },
        { "BINDING_BAD_TARGET", [new("asset:M.color", "mq", "a/b")], [Mqtt] },
        { "BINDING_DUPLICATE_TARGET", [new("asset:M.state", "mq", "a/b"), new("asset:M.state", "mq", "a/c")], [Mqtt] },
        { "BINDING_UNKNOWN_TARGET", [new("sensor:GHOST.temp", "mq", "a/b")], [Mqtt] },
        { "BINDING_UNKNOWN_TARGET", [new("asset:GHOST.good", "mq", "a/b")], [Mqtt] },
        { "BINDING_UNKNOWN_CONNECTION", [new("asset:M.good", "nope", "a/b")], [Mqtt] },
        { "BINDING_NO_ADDRESS", [new("asset:M.good", "mq", "")], [Mqtt] },
        { "BINDING_BAD_JSONPATH", [new("sensor:M.temp", "mq", "a/b", JsonPath: "temp")], [Mqtt] },
        { "BINDING_BAD_JSONPATH", [new("sensor:M.temp", "ua", "ns=2;s=T", JsonPath: "$.temp")], [new("ua", ConnectionKind.Opcua, "opc.tcp://h:4840")] },
        { "BINDING_BAD_STATEMAP", [new("asset:M.good", "mq", "a/b", StateMap: new Dictionary<string, AssetStateKind> { ["1"] = AssetStateKind.Running })], [Mqtt] },
    };

    private static readonly ConnectionDef Mqtt = new("mq", ConnectionKind.Mqtt, "mqtt://localhost:1883");

    [Theory]
    [MemberData(nameof(BadBindings))]
    public void BINDING_codes(string code, BindingDef[] bindings, ConnectionDef[] connections)
    {
        var r = PlantValidator.Validate(Basic() with { Bindings = bindings, Connections = connections });
        AssertOnly(r, code);
        Assert.StartsWith(ValidationCodes.BindingPrefix, r.Issues[0].Code);
    }

    [Fact]
    public void Good_bindings_are_clean()
    {
        var p = Basic() with
        {
            Connections = [Mqtt],
            Bindings =
            [
                new("sensor:M.temp", "mq", "line/m/temp", JsonPath: "$.data.value", Scale: 0.1),
                new("asset:M.state", "mq", "line/m/state", StateMap: new Dictionary<string, AssetStateKind> { ["1"] = AssetStateKind.Running }),
            ],
        };
        Assert.Empty(PlantValidator.Validate(p).Issues);
    }

    [Fact]
    public void OVERLAP()
    {
        var p = Basic();
        p = p with { Assets = [.. p.Assets.Select(a => a.Id == "M" ? a with { Position = new Vec3(0.5, 0, 0.5) } : a)] };
        var r = PlantValidator.Validate(p);
        AssertOnly(r, "OVERLAP");
        Assert.True(r.Ok);
        Assert.Equal(Severity.Warning, r.Issues[0].Severity);
        Assert.Contains("SRC", r.Issues[0].Message);
        Assert.Contains("M", r.Issues[0].Message);
    }

    [Fact]
    public void Touching_footprints_do_not_overlap()
    {
        var p = Basic();
        p = p with { Assets = [.. p.Assets.Select(a => a.Id == "M" ? a with { Position = new Vec3(1, 0, 0) } : a)] };
        Assert.Empty(PlantValidator.Validate(p).Issues);
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(180, false)]
    [InlineData(90, true)]
    [InlineData(270, true)]
    [InlineData(-90, true)]
    [InlineData(450, true)]
    [InlineData(45, true)]
    public void OVERLAP_respects_rotation(double rotationY, bool overlaps)
    {
        // A long 4 x 0.5 machine at the origin; a 1 x 1 box 1.5 m away on Z. Only a turned machine reaches it.
        var longOne = A("M", AssetKind.Machine, 0, "SNK") with { Size = new Vec3(4, 1, 0.5), RotationY = rotationY };
        var p = With(A("SRC", AssetKind.Source, -10, "M"), longOne,
            A("SNK", AssetKind.Sink, 0) with { Position = new Vec3(0, 0, 1.5) });
        var r = PlantValidator.Validate(p);
        Assert.Equal(overlaps, r.Issues.Any(i => i.Code == "OVERLAP"));
        Assert.True(r.Ok);
    }

    [Fact]
    public void LIMIT_ORDER() =>
        AssertOnly(PlantValidator.Validate(Basic() with { Sensors = [S("M", hi: 80, hiHi: 70)] }), "LIMIT_ORDER", "M");

    [Fact]
    public void LIMIT_ORDER_equal_limits() =>
        AssertOnly(PlantValidator.Validate(Basic() with { Sensors = [S("M", hi: 80, hiHi: 80)] }), "LIMIT_ORDER", "M");

    [Theory]
    [InlineData(AssetKind.Machine)]
    [InlineData(AssetKind.Robot)]
    [InlineData(AssetKind.Inspection)]
    public void NO_SENSORS(AssetKind kind)
    {
        var p = Basic() with { Sensors = [] };
        p = p with { Assets = [.. p.Assets.Select(a => a.Id == "M" ? a with { Kind = kind } : a)] };
        var r = PlantValidator.Validate(p);
        AssertOnly(r, "NO_SENSORS", "M");
        Assert.True(r.Ok);
    }

    [Theory]
    [InlineData("https://cdn.example.com/cnc.glb")]
    [InlineData("meshes/cnc.glb")]
    public void MESH_URL(string mesh)
    {
        var p = Basic();
        p = p with { Assets = [.. p.Assets.Select(a => a.Id == "M" ? a with { Mesh = mesh } : a)] };
        var r = PlantValidator.Validate(p);
        AssertOnly(r, "MESH_URL", "M");
        Assert.True(r.Ok);
    }

    [Fact]
    public void Critical_issues_come_before_warnings()
    {
        var p = Basic() with { Sensors = [S("M", hi: 80, hiHi: 70)] };
        p = p with { Assets = [.. p.Assets.Select(a => a.Id == "M" ? a with { Params = new Dictionary<string, double>() } : a)] };
        var r = PlantValidator.Validate(p);
        Assert.Equal(["MISSING_PARAM", "LIMIT_ORDER"], r.Issues.Select(i => i.Code));
        Assert.False(r.Ok);
    }

    // ------------------------------------------------------------------ performance

    private static PlantModel Chain(int n)
    {
        var assets = new List<AssetDef>(n);
        var sensors = new List<SensorDef>();
        for (var i = 0; i < n; i++)
        {
            var kind = i == 0 ? AssetKind.Source : i == n - 1 ? AssetKind.Sink : (i % 3) switch
            {
                0 => AssetKind.Buffer,
                1 => AssetKind.Machine,
                _ => AssetKind.Conveyor,
            };
            var id = $"A-{i:000}";
            assets.Add(new AssetDef(id, id, kind, new Vec3(i * 2.0, 0, (i % 2) * 0.1), i % 4 * 90, new Vec3(1.2, 1, 1.2),
                i == n - 1 ? [] : [$"A-{i + 1:000}"], ParamsFor(kind), LineId: "L1"));
            if (kind == AssetKind.Machine)
            {
                sensors.Add(new SensorDef(id + ".temp", id, SensorKind.Temperature, "°C", 0.01, 70, 80));
                sensors.Add(new SensorDef(id + ".vib", id, SensorKind.Vibration, "mm/s", 0.05, 4.5, 7.1));
            }
        }
        return new PlantModel("big", "Big", 1, 7, assets, sensors, Lines: [new("L1", "Line 1")]);
    }

    [Fact]
    public void Validates_200_assets_in_under_5_ms()
    {
        var p = Chain(200);
        var first = PlantValidator.Validate(p);
        Assert.Empty(first.Issues);

        var times = new List<double>();
        for (var i = 0; i < 25; i++)
        {
            var sw = Stopwatch.StartNew();
            PlantValidator.Validate(p);
            times.Add(sw.Elapsed.TotalMilliseconds);
        }
        times.Sort();
        Assert.True(times[times.Count / 2] < 5, $"median {times[times.Count / 2]:0.###} ms");
    }

    [Fact]
    public void Long_chains_do_not_overflow_the_stack()
    {
        var p = Chain(5_000);
        // Close a giant loop to exercise the iterative SCC.
        var assets = p.Assets.ToList();
        assets[^2] = assets[^2] with { Downstream = [assets[^1].Id, assets[1].Id] };
        var r = PlantValidator.Validate(p with { Assets = assets });
        Assert.Contains(r.Issues, i => i.Code == "CYCLE");
    }

    // ------------------------------------------------------------------ never throws

    public static TheoryData<string> WeirdNames => new() { "null plant", "null lists", "null entries", "null fields", "nan geometry", "bad enums" };

    [Theory]
    [MemberData(nameof(WeirdNames))]
    public void Never_throws_on_weird_input(string name)
    {
        PlantModel? p = name switch
        {
            "null plant" => null,
            "null lists" => new PlantModel(null!, null!, 0, 0, null!, null!, null, null, null, null, new CalendarDef(0, null!)),
            "null entries" => Basic() with
            {
                Assets = [null!, .. Basic().Assets, null!],
                Sensors = [null!],
                Lines = [null!],
                Resources = [null!],
                Connections = [null!],
                Bindings = [null!],
                Calendar = new CalendarDef(0, [null!]),
            },
            "null fields" => Basic() with
            {
                Assets = [new AssetDef(null!, null!, AssetKind.Machine, null!, 0, null!, [null!, "SNK"], null!, "", " ", null, ""),
                    .. Basic().Assets],
                Sensors = [new SensorDef(null!, null!, SensorKind.Power, null!, double.NaN, double.NaN, double.NegativeInfinity)],
                Bindings = [new BindingDef(null!, null!, null!, "$.", null, null, null)],
                Connections = [new ConnectionDef(null!, ConnectionKind.Mqtt, null!)],
                Resources = [new ResourceDef(null!, null!, ResourceKind.Agv, int.MinValue)],
            },
            "nan geometry" => Basic() with
            {
                Assets = [.. Basic().Assets.Select(a => a with
                {
                    Position = new Vec3(double.NaN, 0, double.PositiveInfinity),
                    Size = new Vec3(-1, double.NaN, 1e308),
                    RotationY = double.NaN,
                    Params = new Dictionary<string, double> { [""] = double.NaN, ["capacity"] = double.MaxValue },
                })],
            },
            _ => Basic() with { Assets = [.. Basic().Assets.Select(a => a with { Kind = (AssetKind)99 })], Resources = [new("r", "r", (ResourceKind)42, 1)] },
        };

        var r = PlantValidator.Validate(p!);
        Assert.NotNull(r);
        Assert.DoesNotContain(r.Issues, i => i.Code == ValidationCodes.ValidatorError);
        if (name is not ("nan geometry" or "null entries")) Assert.False(r.Ok);
        if (name == "null entries") Assert.True(r.Ok); // null list entries are skipped
    }

    [Fact]
    public void Null_plant_is_empty() => AssertOnly(PlantValidator.Validate(null), "EMPTY_PLANT");
}
