namespace TwinLabs.Api.Hosting;

/// <summary>Another what-if run is already in progress (HTTP 409).</summary>
public sealed class WhatIfBusyException() : InvalidOperationException("A what-if run is already in progress.");

/// <summary>The request conflicts with the current twin state, e.g. shadow mode without bindings or a speed change in shadow (HTTP 409).</summary>
public sealed class TwinConflictException(string message) : InvalidOperationException(message);

/// <summary>Maps domain exceptions to HTTP status codes. Shared by REST (problem+json) and WS (ack error).</summary>
public static class TwinErrors
{
    public static bool TryMap(Exception ex, out int status, out string title)
    {
        (status, title) = ex switch
        {
            KeyNotFoundException => (StatusCodes.Status404NotFound, "Not Found"),
            ArgumentException => (StatusCodes.Status400BadRequest, "Bad Request"),
            WhatIfBusyException => (StatusCodes.Status409Conflict, "Conflict"),
            TwinConflictException => (StatusCodes.Status409Conflict, "Conflict"),
            _ => (0, ""),
        };
        return status != 0;
    }

    public static KeyNotFoundException UnknownAsset(string id) => new($"Unknown asset '{id}'");
    public static KeyNotFoundException UnknownSensor(string id) => new($"Unknown sensor '{id}'");
    public static KeyNotFoundException UnknownAlarm(string id) => new($"Unknown or inactive alarm '{id}'");
    public static KeyNotFoundException UnknownConnection(string id) => new($"Unknown connection '{id}'");
}
