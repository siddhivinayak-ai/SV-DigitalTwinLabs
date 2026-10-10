using Opc.Ua;
using Opc.Ua.Server;
using TwinLabs.Core.Contracts;

namespace TwinLabs.VirtualPlc;

/// <summary>The OPC UA server: the standard server plus one <see cref="PlcNodeManager"/> for the plant.</summary>
internal sealed class PlcServer(PlantModel plant, IPlcCommands? commands) : StandardServer
{
    public PlcNodeManager? NodeManager { get; private set; }

    protected override MasterNodeManager CreateMasterNodeManager(IServerInternal server, ApplicationConfiguration configuration)
    {
        NodeManager = new PlcNodeManager(server, configuration, plant, commands);
        return new MasterNodeManager(server, configuration, null, new INodeManager[] { NodeManager });
    }

    protected override ServerProperties LoadServerProperties() => new()
    {
        ManufacturerName = "SV-DigitalTwinLabs",
        ProductName = "TwinLabs Virtual PLC",
        ProductUri = PlcNaming.NamespaceUri,
        SoftwareVersion = typeof(PlcServer).Assembly.GetName().Version?.ToString() ?? "0.0.0",
        BuildNumber = "0",
        BuildDate = DateTime.UtcNow,
    };
}
