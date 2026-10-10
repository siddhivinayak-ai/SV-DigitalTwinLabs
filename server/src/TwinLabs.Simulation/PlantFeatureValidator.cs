using TwinLabs.Core.Contracts;

namespace TwinLabs.Simulation;

/// <summary>
/// Engine-side checks of the v0.3 plant fields (lines, resources, calendar). Throws <see cref="ArgumentException"/>.
/// Mirrors the critical <c>UNKNOWN_REF</c>, <c>RESOURCE_KIND</c>, <c>BAD_RESOURCE_COUNT</c> and <c>BAD_SHIFT</c>
/// rules of <c>PlantValidator</c> so an engine can never be built from a plant it cannot run.
/// </summary>
internal static class PlantFeatureValidator
{
    public static void Validate(PlantModel plant)
    {
        var lines = plant.Lines is null ? null : UniqueIds(plant.Lines.Select(l => l.Id), "line");
        var resources = UniqueIds((plant.Resources ?? []).Select(r => r.Id), "resource");
        foreach (var r in plant.Resources ?? [])
            if (r.Count < 1)
                throw new ArgumentException($"Resource '{r.Id}': count must be >= 1 (got {r.Count}).");

        var shifts = new HashSet<string>(StringComparer.Ordinal);
        if (plant.Calendar is { } cal)
        {
            if (!InHours(cal.StartHourOfDay))
                throw new ArgumentException($"Calendar: startHourOfDay must be in 0..24 (got {cal.StartHourOfDay}).");
            shifts = UniqueIds((cal.Shifts ?? []).Select(s => s.Id), "shift");
            foreach (var s in cal.Shifts ?? [])
            {
                if (!InHours(s.StartHour) || !InHours(s.EndHour))
                    throw new ArgumentException($"Shift '{s.Id}': hours must be in 0..24 (got {s.StartHour}..{s.EndHour}).");
                if (s.StartHour == s.EndHour)
                    throw new ArgumentException($"Shift '{s.Id}': start and end hour must differ (both {s.StartHour}).");
            }
        }

        foreach (var a in plant.Assets)
        {
            if (a.LineId is { } line && lines is not null && !lines.Contains(line))
                throw new ArgumentException($"{a.Id}: unknown line '{line}'.");

            if (a.ResourceId is { } res)
            {
                if (!resources.Contains(res))
                    throw new ArgumentException($"{a.Id}: unknown resource '{res}'.");
                if (a.Kind is not (AssetKind.Machine or AssetKind.Robot or AssetKind.Inspection))
                    throw new ArgumentException($"{a.Id}: a {a.Kind} cannot use a resource (only machine, robot, inspection).");
            }

            if (a.ShiftId is { } shift && !shifts.Contains(shift))
                throw new ArgumentException($"{a.Id}: unknown shift '{shift}'.");
        }
    }

    private static bool InHours(double h) => double.IsFinite(h) && h >= 0 && h <= 24;

    private static HashSet<string> UniqueIds(IEnumerable<string> ids, string what)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in ids)
        {
            if (string.IsNullOrWhiteSpace(id)) throw new ArgumentException($"Empty {what} id.");
            if (!set.Add(id)) throw new ArgumentException($"Duplicate {what} id '{id}'.");
        }
        return set;
    }
}
