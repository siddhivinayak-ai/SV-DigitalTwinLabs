using TwinLabs.Core.Contracts;

namespace TwinLabs.Core.Validation;

/// <summary>
/// STUB (v0.2 contracts): replaced by feature/plant-api. Structural validation of a plant model: graph rules,
/// references, parameter ranges per asset kind. Used by <c>POST /api/plant/validate</c> and <c>PUT /api/plant</c>.
/// </summary>
public static class PlantValidator
{
    public static ValidationResult Validate(PlantModel plant) => new(true, []);
}
