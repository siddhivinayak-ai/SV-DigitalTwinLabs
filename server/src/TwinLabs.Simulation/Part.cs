namespace TwinLabs.Simulation;

/// <summary>A work piece moving through the line.</summary>
internal sealed class Part
{
    public Part(long id) => Id = id;

    public long Id { get; }

    /// <summary>Distance travelled along a conveyor, in metres. Only meaningful on conveyors.</summary>
    public double PosM;
}
