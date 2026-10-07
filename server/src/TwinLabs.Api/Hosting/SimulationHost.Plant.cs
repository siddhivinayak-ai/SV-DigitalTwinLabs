using TwinLabs.Analytics;
using TwinLabs.Api.Realtime;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;
using TwinLabs.Core.Validation;

namespace TwinLabs.Api.Hosting;

// v0.3 (feature/plant-api): live plant replacement for PUT /api/plant (and layouts).
public sealed partial class SimulationHost
{
    /// <summary>Set in the constructor; used to build the engine for a replacement plant.</summary>
    private readonly ISimulationEngineFactory _factory;

    /// <summary>Validate and, when there are no critical issues, swap the live plant. See the overload.</summary>
    public ValidationResult ReplacePlant(PlantModel plant) => ReplacePlant(plant, out _);

    /// <summary>
    /// Validates <paramref name="plant"/>; on critical issues returns the result and changes nothing. Otherwise
    /// rebuilds the engine (seed = <see cref="PlantModel.Seed"/>), KPI calculator, anomaly detector, history and event
    /// log for the new plant, resets to t=0 and keeps the run state and speed. Afterwards, outside the lock, every WS
    /// client gets a fresh <c>snapshot</c> and <see cref="PlantChanged"/> is raised.
    /// </summary>
    /// <param name="snapshot">The snapshot that was broadcast, or null when the plant was rejected.</param>
    /// <exception cref="ArgumentException">The engine factory rejected a plant the validator accepted (nothing changed).</exception>
    public ValidationResult ReplacePlant(PlantModel plant, out SnapshotData? snapshot)
    {
        snapshot = null;
        var result = PlantValidator.Validate(plant);
        if (!result.Ok) return result;

        var clean = Normalize(plant);
        // Build everything before taking the lock, so a factory failure leaves the live twin untouched.
        var engine = _factory.Create(ClonePlant(clean), clean.Seed);
        var history = new SensorHistory(clean.Sensors, _history.Capacity);

        long simTimeMs;
        lock (_gate)
        {
            _engine = engine;
            _kpi = NewKpiCalculator(_kpi);
            _detector = NewDetector(_detector, clean);
            _history = history;
            _originalPlant = ClonePlant(clean);
            _assetIds = [.. clean.Assets.Select(a => a.Id)];
            _seed = clean.Seed;
            ResetLocked($"Plant replaced: {clean.Name} ({clean.Assets.Count} assets)");
            snapshot = SnapshotLocked();
            simTimeMs = _engine.SimTimeMs;
        }

        _log.LogInformation("Plant replaced: {Name} ({Count} assets)", clean.Name, clean.Assets.Count);
        if (_clients.Count > 0) _clients.Broadcast(Frame.Create(MessageTypes.Snapshot, simTimeMs, snapshot));
        try
        {
            RaisePlantChanged(ClonePlant(clean));
        }
        catch (Exception ex)
        {
            // A listener failing must not undo or fail an applied plant.
            _log.LogError(ex, "PlantChanged listener failed");
        }
        return result;
    }

    /// <summary>The real calculator is rebuilt; any other implementation (tests, decorators) is reset and reused.</summary>
    private static IKpiCalculator NewKpiCalculator(IKpiCalculator current)
    {
        if (current is KpiCalculator) return new KpiCalculator();
        current.Reset();
        return current;
    }

    /// <summary>The real detector is rebuilt for the new plant (its limits come from the plant's sensors); any other
    /// implementation is reset and reused.</summary>
    private static IAnomalyDetector NewDetector(IAnomalyDetector current, PlantModel plant)
    {
        if (current is AnomalyDetector) return new AnomalyDetector(ClonePlant(plant));
        current.Reset();
        return current;
    }

    /// <summary>Drops null list entries and fills null collections so the engine and <see cref="ClonePlant"/> never see nulls.</summary>
    private static PlantModel Normalize(PlantModel p) => p with
    {
        Name = p.Name ?? p.Id,
        Assets = [.. (p.Assets ?? []).Where(a => a is not null).Select(a => a with
        {
            Downstream = [.. (a.Downstream ?? []).Where(d => d is not null)],
            Params = a.Params ?? new Dictionary<string, double>(),
            LineId = string.IsNullOrWhiteSpace(a.LineId) ? null : a.LineId,
            ResourceId = string.IsNullOrWhiteSpace(a.ResourceId) ? null : a.ResourceId,
            ShiftId = string.IsNullOrWhiteSpace(a.ShiftId) ? null : a.ShiftId,
            Mesh = string.IsNullOrWhiteSpace(a.Mesh) ? null : a.Mesh,
        })],
        Sensors = [.. (p.Sensors ?? []).Where(s => s is not null)],
        Connections = p.Connections is null ? null : [.. p.Connections.Where(c => c is not null)],
        Bindings = p.Bindings is null ? null : [.. p.Bindings.Where(b => b is not null)],
        Lines = p.Lines is null ? null : [.. p.Lines.Where(l => l is not null)],
        Resources = p.Resources is null ? null : [.. p.Resources.Where(r => r is not null)],
        Calendar = p.Calendar is null ? null : p.Calendar with { Shifts = [.. (p.Calendar.Shifts ?? []).Where(s => s is not null)] },
    };
}
