namespace TwinLabs.VirtualPlc.Tests;

public class PlcNamingTests
{
    [Theory]
    [InlineData("line-a", "LineA")]
    [InlineData("line-a-connected", "LineA")]
    [InlineData("my_plant-2", "MyPlant2")]
    [InlineData("LineB", "LineB")]
    public void LineId_follows_contract(string plantId, string expected) => Assert.Equal(expected, PlcNaming.LineId(plantId));

    [Theory]
    [InlineData("temp", "Temp")]
    [InlineData("vib", "Vib")]
    [InlineData("rejects", "Rejects")]
    [InlineData("good", "Good")]
    [InlineData("pressure", "Pressure")]
    public void SensorName_maps_suffix(string suffix, string expected) => Assert.Equal(expected, PlcNaming.SensorName(suffix));

    [Fact]
    public void NodeIdText_matches_contract() =>
        Assert.Equal("ns=2;s=LineA.CNC-01.Temp", PlcNaming.NodeIdText("LineA", "CNC-01", "Temp"));
}
