using TwinLabs.Connect;
using TwinLabs.Core.Contracts;
using TwinLabs.Core.Validation;

namespace TwinLabs.Api.Tests;

/// <summary>
/// PlantValidator (Core) re-expresses BindingResolver.Validate (Connect), which Core cannot reference. Every
/// BindingResolver message must surface as a BINDING_* issue with the same text (duplicate connection ids are the
/// one exception: they are DUPLICATE_ID).
/// </summary>
public class PlantBindingParityTests
{
    private static readonly ConnectionDef Mqtt = new("mq", ConnectionKind.Mqtt, "mqtt://localhost:1883");
    private static readonly ConnectionDef Ua = new("ua", ConnectionKind.Opcua, "opc.tcp://localhost:4840");

    public static TheoryData<string> Cases => new() { "clean", "no-endpoint", "bad-target", "dup-target", "unknown-target", "unknown-conn", "no-address", "jsonpath", "statemap", "everything", "dup-connection" };

    private static PlantModel Make(string name)
    {
        var p = PlantApiTests.SmallPlant();
        BindingDef[] good = [new("sensor:S-CNC.temp", "mq", "cell/temp", JsonPath: "$.v"), new("asset:S-CNC.state", "ua", "ns=2;s=State")];
        return name switch
        {
            "clean" => p with { Connections = [Mqtt, Ua], Bindings = good },
            "no-endpoint" => p with { Connections = [Mqtt with { Endpoint = "" }], Bindings = [good[0]] },
            "bad-target" => p with { Connections = [Mqtt], Bindings = [new("asset:S-CNC", "mq", "x"), new("plc:1", "mq", "y")] },
            "dup-target" => p with { Connections = [Mqtt], Bindings = [good[0], good[0] with { Address = "z" }] },
            "unknown-target" => p with { Connections = [Mqtt], Bindings = [new("sensor:NOPE", "mq", "x"), new("asset:NOPE.good", "mq", "y")] },
            "unknown-conn" => p with { Connections = [Mqtt], Bindings = [new("asset:S-CNC.good", "nope", "x")] },
            "no-address" => p with { Connections = [Mqtt], Bindings = [new("asset:S-CNC.good", "mq", " ")] },
            "jsonpath" => p with { Connections = [Mqtt, Ua], Bindings = [new("asset:S-CNC.good", "ua", "x", JsonPath: "$.a"), new("asset:S-CNC.wip", "mq", "y", JsonPath: "$a")] },
            "statemap" => p with { Connections = [Mqtt], Bindings = [new("asset:S-CNC.load", "mq", "x", StateMap: new Dictionary<string, AssetStateKind>())] },
            "everything" => p with
            {
                Connections = [Mqtt with { Endpoint = " " }],
                Bindings = [new("sensor:GHOST", "nope", "", JsonPath: "bad", StateMap: new Dictionary<string, AssetStateKind>()), new("sensor:GHOST", "nope", "")],
            },
            _ => p with { Connections = [Mqtt, Mqtt], Bindings = [good[0]] },
        };
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Binding_issues_match_BindingResolver_messages(string name)
    {
        var plant = Make(name);
        var resolver = BindingResolver.Validate(plant).Where(m => !m.StartsWith("Duplicate connection id", StringComparison.Ordinal)).ToList();
        var issues = PlantValidator.Validate(plant).Issues;
        var binding = issues.Where(i => i.Code.StartsWith(ValidationCodes.BindingPrefix, StringComparison.Ordinal)).ToList();

        Assert.Equal(resolver.Order(), binding.Select(i => i.Message).Order());
        Assert.All(binding, i => Assert.Equal(Severity.Critical, i.Severity));
        if (name == "dup-connection") Assert.Contains(issues, i => i.Code == ValidationCodes.DuplicateId);
        if (name == "clean") Assert.Empty(issues);
    }
}
