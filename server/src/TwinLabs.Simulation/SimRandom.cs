namespace TwinLabs.Simulation;

/// <summary>
/// Distribution helpers over a seeded <see cref="Random"/>, plus a stateless hash-based
/// Gaussian used for sensor noise (so reading sensors never perturbs the simulation stream).
/// </summary>
internal static class SimRandom
{
    /// <summary>Standard normal draw (Box-Muller, one value per call).</summary>
    public static double StandardNormal(Random rng)
    {
        double u1 = 1.0 - rng.NextDouble(); // (0,1]
        double u2 = rng.NextDouble();
        return Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2.0 * Math.PI * u2);
    }

    /// <summary>Normal(mean, std) clamped to at least <paramref name="minFraction"/> × mean.</summary>
    public static double ClampedNormal(Random rng, double mean, double std, double minFraction = 0.2)
    {
        if (std <= 0) return mean;
        double v = mean + std * StandardNormal(rng);
        double min = minFraction * mean;
        return v < min ? min : v;
    }

    /// <summary>Exponential with the given mean.</summary>
    public static double Exponential(Random rng, double mean)
    {
        double u = rng.NextDouble(); // [0,1)
        return -mean * Math.Log(1.0 - u);
    }

    private static ulong SplitMix64(ulong x)
    {
        x += 0x9E3779B97F4A7C15UL;
        x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9UL;
        x = (x ^ (x >> 27)) * 0x94D049BB133111EBUL;
        return x ^ (x >> 31);
    }

    /// <summary>
    /// Deterministic standard normal as a pure function of (seed, stream, tick).
    /// Used for sensor noise: the value for a sensor at a tick is the same no matter
    /// when or how often it is read.
    /// </summary>
    public static double HashNormal(int seed, int stream, long tick)
    {
        ulong h = SplitMix64((ulong)(uint)seed * 0xD1B54A32D192ED03UL
                             ^ SplitMix64((ulong)stream + 0x632BE59BD9B4E019UL)
                             ^ SplitMix64((ulong)tick));
        ulong h2 = SplitMix64(h);
        double u1 = ((h >> 11) + 1) * (1.0 / 9007199254740992.0); // (0,1]
        double u2 = (h2 >> 11) * (1.0 / 9007199254740992.0);      // [0,1)
        return Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2.0 * Math.PI * u2);
    }
}
