namespace TwinLabs.Core.Validation;

/// <summary>Stable <see cref="Contracts.ValidationIssue.Code"/> strings (docs/V0.3-PlantBuilder.md §3).</summary>
public static class ValidationCodes
{
    // critical
    public const string EmptyPlant = "EMPTY_PLANT";
    public const string DuplicateId = "DUPLICATE_ID";
    public const string BadId = "BAD_ID";
    public const string NoSource = "NO_SOURCE";
    public const string NoSink = "NO_SINK";
    public const string UnknownDownstream = "UNKNOWN_DOWNSTREAM";
    public const string SelfLoop = "SELF_LOOP";
    public const string Cycle = "CYCLE";
    public const string SourceHasUpstream = "SOURCE_HAS_UPSTREAM";
    public const string SinkHasDownstream = "SINK_HAS_DOWNSTREAM";
    public const string DeadEnd = "DEAD_END";
    public const string Unreachable = "UNREACHABLE";
    public const string NoSinkReachable = "NO_SINK_REACHABLE";
    public const string MissingParam = "MISSING_PARAM";
    public const string BadParam = "BAD_PARAM";
    public const string UnknownRef = "UNKNOWN_REF";
    public const string ResourceKind = "RESOURCE_KIND";
    public const string BadResourceCount = "BAD_RESOURCE_COUNT";
    public const string BadShift = "BAD_SHIFT";

    /// <summary>Prefix of the binding codes. The suffixes mirror the messages of <c>TwinLabs.Connect.BindingResolver.Validate</c>.</summary>
    public const string BindingPrefix = "BINDING_";
    public const string BindingNoEndpoint = "BINDING_NO_ENDPOINT";
    public const string BindingBadTarget = "BINDING_BAD_TARGET";
    public const string BindingDuplicateTarget = "BINDING_DUPLICATE_TARGET";
    public const string BindingUnknownTarget = "BINDING_UNKNOWN_TARGET";
    public const string BindingUnknownConnection = "BINDING_UNKNOWN_CONNECTION";
    public const string BindingNoAddress = "BINDING_NO_ADDRESS";
    public const string BindingBadJsonPath = "BINDING_BAD_JSONPATH";
    public const string BindingBadStateMap = "BINDING_BAD_STATEMAP";

    // warning
    public const string Overlap = "OVERLAP";
    public const string LimitOrder = "LIMIT_ORDER";
    public const string NoSensors = "NO_SENSORS";
    public const string MeshUrl = "MESH_URL";

    /// <summary>Safety net only: the validator hit an unexpected internal error. Not part of the §3 table.</summary>
    public const string ValidatorError = "VALIDATOR_ERROR";
}
