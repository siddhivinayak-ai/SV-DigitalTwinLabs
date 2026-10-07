using System.Globalization;
using Microsoft.Extensions.Logging;
using Opc.Ua;
using Opc.Ua.Client;
using TwinLabs.Core;
using TwinLabs.Core.Contracts;

namespace TwinLabs.Connect.OpcUa;

/// <summary>
/// OPC UA client tag source: one session, one subscription, one monitored item per unique binding address.
/// <para>
/// Lifecycle: <see cref="StartAsync"/> returns immediately and connects in the background, retrying with
/// exponential backoff (<see cref="OpcUaClientOptions.MinReconnectDelay"/> .. <see cref="OpcUaClientOptions.MaxReconnectDelay"/>).
/// Keep-alive loss is handled by the SDK's <see cref="SessionReconnectHandler"/> (reactivate, or recreate the session
/// and its subscription). If that gives up, the source falls back to a fresh connect.
/// </para>
/// <para>
/// Threading: <see cref="Updates"/> is raised on an OPC UA stack thread, one batch per publish notification,
/// sequentially for this source. <see cref="StatusChanged"/> is raised from the connect loop or stack threads,
/// serialised by an internal lock so transitions arrive in order. Handlers must be quick and must not block on
/// <see cref="StopAsync"/>.
/// </para>
/// </summary>
public sealed class OpcUaTagSource : ITagSource
{
    private readonly OpcUaClientContext _ctx;
    private readonly ILogger _log;
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private readonly object _sync = new();
    private readonly object _statusLock = new();

    // Status: the base record (without LastValueMs) plus the last value time, composed on read.
    private ConnectionStatus _status;
    private long _lastValueMs;

    // Lifecycle state, guarded by _lifecycle.
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private bool _disposed;

    // Run state, guarded by _sync.
    private long _generation;
    private ISession? _session;
    private SessionReconnectHandler? _reconnect;
    private TaskCompletionSource<string>? _fatal;
    private bool _reconnecting;
    private string[] _addresses = [];
    private string? _nodeIdProblems;
    private FastDataChangeNotificationEventHandler? _onDataChange;

    internal OpcUaTagSource(ConnectionDef definition, OpcUaClientContext ctx)
    {
        Definition = definition;
        _ctx = ctx;
        _log = ctx.LoggerFactory.CreateLogger<OpcUaTagSource>();
        _status = new ConnectionStatus(definition.Id, ConnectionKind.Opcua, definition.Endpoint, ConnectionState.Disabled, 0);
    }

    public ConnectionDef Definition { get; }

    public ConnectionStatus Status
    {
        get
        {
            var s = Volatile.Read(ref _status);
            var last = Interlocked.Read(ref _lastValueMs);
            return last > 0 ? s with { LastValueMs = last } : s;
        }
    }

    public event Action<ConnectionStatus>? StatusChanged;
    public event Action<IReadOnlyList<TagUpdate>>? Updates;

    /// <summary>Number of monitored items in the current subscription (unique addresses with a parseable node id).</summary>
    internal int MonitoredItemCount
    {
        get
        {
            lock (_sync)
                return (int)(_session?.Subscriptions.Sum(s => (long)s.MonitoredItemCount) ?? 0);
        }
    }

    /// <summary>
    /// Starts connecting in the background and returns immediately. Never throws for connection problems.
    /// Calling it again while running restarts the source with the new bindings.
    /// <paramref name="ct"/> only cancels this call; the source runs until <see cref="StopAsync"/>.
    /// </summary>
    public async Task StartAsync(IReadOnlyList<BindingDef> bindings, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        await _lifecycle.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_cts is not null) await StopCoreAsync(raiseDisabled: false).ConfigureAwait(false);

            var mine = bindings.Where(b => string.Equals(b.ConnectionId, Definition.Id, StringComparison.Ordinal)).ToList();
            long gen;
            lock (_sync)
            {
                gen = ++_generation;
                _addresses = mine.Select(b => b.Address).Where(a => !string.IsNullOrWhiteSpace(a))
                    .Distinct(StringComparer.Ordinal).ToArray();
                _nodeIdProblems = null;
                _onDataChange = (sub, n, _) => OnDataChange(gen, sub, n);
            }
            Interlocked.Exchange(ref _lastValueMs, 0);
            SetStatus(ConnectionState.Connecting, null, mine.Count);

            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            _loop = Task.Run(() => RunAsync(gen, token), CancellationToken.None);
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    /// <summary>Closes the session and stops retrying. Idempotent and thread-safe.</summary>
    public async Task StopAsync()
    {
        await _lifecycle.WaitAsync().ConfigureAwait(false);
        try
        {
            await StopCoreAsync(raiseDisabled: true).ConfigureAwait(false);
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _lifecycle.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed) return;
            await StopCoreAsync(raiseDisabled: true).ConfigureAwait(false);
            _disposed = true;
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    private async Task StopCoreAsync(bool raiseDisabled)
    {
        if (_cts is null) return;
        lock (_sync) _generation++;
        _cts.Cancel();
        try
        {
            if (_loop is not null) await _loop.ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "OPC UA {Id}: connect loop ended with an error", Definition.Id);
        }
        await TearDownSessionAsync().ConfigureAwait(false);
        _cts.Dispose();
        _cts = null;
        _loop = null;
        if (raiseDisabled) SetStatus(ConnectionState.Disabled, null, Volatile.Read(ref _status).BoundTags);
    }

    // ------------------------------------------------------------------ connect loop

    private async Task RunAsync(long gen, CancellationToken ct)
    {
        var delay = _ctx.Options.MinReconnectDelay;
        string? lastError = null;
        while (!ct.IsCancellationRequested)
        {
            SetStatus(ConnectionState.Connecting, lastError);
            TaskCompletionSource<string> fatal;
            try
            {
                var session = await ConnectAsync(gen, ct).ConfigureAwait(false);
                fatal = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                bool adopted;
                lock (_sync)
                {
                    adopted = gen == _generation && !ct.IsCancellationRequested;
                    if (adopted)
                    {
                        _session = session;
                        _fatal = fatal;
                        _reconnecting = false;
                        _reconnect = new SessionReconnectHandler(_ctx.Telemetry, true,
                            (int)_ctx.Options.MaxReconnectDelay.TotalMilliseconds);
                        session.KeepAlive += OnKeepAlive;
                    }
                }
                if (!adopted)
                {
                    await CloseQuietlyAsync(session).ConfigureAwait(false);
                    break;
                }

                delay = _ctx.Options.MinReconnectDelay;
                lastError = null;
                SetStatus(ConnectionState.Connected, _nodeIdProblems);
                _log.LogInformation("OPC UA {Id}: connected to {Endpoint}", Definition.Id, Definition.Endpoint);

                lastError = await fatal.Task.WaitAsync(ct).ConfigureAwait(false);
                _log.LogWarning("OPC UA {Id}: {Reason}; starting a fresh connect", Definition.Id, lastError);
                await TearDownSessionAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                lastError = Describe(ex);
                _log.LogWarning("OPC UA {Id}: connect to {Endpoint} failed: {Error}; retrying in {Delay}",
                    Definition.Id, Definition.Endpoint, lastError, delay);
                SetStatus(ConnectionState.Error, lastError);
                try
                {
                    await Task.Delay(Jitter(delay), ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                var next = delay * 2;
                delay = next > _ctx.Options.MaxReconnectDelay ? _ctx.Options.MaxReconnectDelay : next;
            }
        }
    }

    private async Task<ISession> ConnectAsync(long gen, CancellationToken ct)
    {
        var config = await _ctx.GetConfigurationAsync(ct).ConfigureAwait(false);
        var description = await CoreClientUtils.SelectEndpointAsync(config, Definition.Endpoint, false,
            _ctx.Options.OperationTimeoutMs, _ctx.Telemetry, ct).ConfigureAwait(false);
        var endpoint = new ConfiguredEndpoint(null, description, EndpointConfiguration.Create(config));
        var session = await new DefaultSessionFactory(_ctx.Telemetry).CreateAsync(config, endpoint, false, false,
            $"TwinLabs:{Definition.Id}", _ctx.Options.SessionTimeoutMs, new UserIdentity(new AnonymousIdentityToken()),
            null, ct).ConfigureAwait(false);
        try
        {
            session.KeepAliveInterval = _ctx.Options.KeepAliveIntervalMs;
            await SubscribeAsync(gen, session, ct).ConfigureAwait(false);
            return session;
        }
        catch
        {
            await CloseQuietlyAsync(session).ConfigureAwait(false);
            throw;
        }
    }

    private async Task SubscribeAsync(long gen, ISession session, CancellationToken ct)
    {
        string[] addresses;
        FastDataChangeNotificationEventHandler? callback;
        lock (_sync)
        {
            addresses = _addresses;
            callback = _onDataChange;
        }
        if (addresses.Length == 0 || callback is null) return;

        var interval = Definition.PublishingIntervalMs is > 0 and var p ? p : _ctx.Options.DefaultPublishingIntervalMs;
        var subscription = new Subscription(_ctx.Telemetry, new SubscriptionOptions
        {
            DisplayName = $"TwinLabs:{Definition.Id}",
            PublishingInterval = interval,
            KeepAliveCount = 10,
            LifetimeCount = 100,
            PublishingEnabled = true,
            TimestampsToReturn = TimestampsToReturn.Both,
            SequentialPublishing = true,
            MaxNotificationsPerPublish = 0,
        })
        {
            FastDataChangeCallback = callback,
        };

        var invalid = new List<string>();
        var items = new List<MonitoredItem>();
        foreach (var address in addresses)
        {
            if (!TryResolveNodeId(address, session.NamespaceUris, out var nodeId))
            {
                invalid.Add($"{address} (unparseable)");
                continue;
            }
            var item = new MonitoredItem(_ctx.Telemetry, new MonitoredItemOptions
            {
                StartNodeId = nodeId,
                AttributeId = Attributes.Value,
                DisplayName = address,
                SamplingInterval = interval,
                QueueSize = 1,
                DiscardOldest = true,
                MonitoringMode = MonitoringMode.Reporting,
            })
            {
                Handle = address,
            };
            items.Add(item);
        }

        if (items.Count > 0)
        {
            subscription.AddItems(items);
            session.AddSubscription(subscription);
            await subscription.CreateAsync(ct).ConfigureAwait(false);
            foreach (var item in items)
            {
                if (ServiceResult.IsBad(item.Status.Error))
                    invalid.Add($"{item.DisplayName} ({StatusCodes.GetBrowseName(item.Status.Error!.StatusCode.Code)})");
            }
        }

        string? problems = null;
        if (invalid.Count > 0)
        {
            problems = $"{invalid.Count} of {addresses.Length} node ids invalid: {string.Join(", ", invalid.Take(5))}"
                       + (invalid.Count > 5 ? ", …" : "");
            _log.LogWarning("OPC UA {Id}: {Count} of {Total} node ids invalid: {All}", Definition.Id, invalid.Count,
                addresses.Length, string.Join(", ", invalid));
        }
        lock (_sync)
        {
            if (gen == _generation) _nodeIdProblems = problems;
        }
    }

    internal static bool TryResolveNodeId(string address, NamespaceTable namespaces, out NodeId nodeId)
    {
        nodeId = NodeId.Null;
        var text = address.Trim();
        try
        {
            if (text.StartsWith("nsu=", StringComparison.Ordinal))
            {
                var expanded = ExpandedNodeId.Parse(text);
                nodeId = ExpandedNodeId.ToNodeId(expanded, namespaces);
            }
            else
            {
                nodeId = NodeId.Parse(text);
            }
        }
        catch (Exception)
        {
            nodeId = NodeId.Null;
        }
        return !NodeId.IsNull(nodeId);
    }

    // ------------------------------------------------------------------ stack callbacks

    private void OnDataChange(long gen, Subscription subscription, DataChangeNotification notification)
    {
        if (Interlocked.Read(ref _generation) != gen || notification.MonitoredItems is not { Count: > 0 } changes) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var batch = new List<TagUpdate>(changes.Count);
        foreach (var change in changes)
        {
            var dv = change.Value;
            if (dv is null || StatusCode.IsBad(dv.StatusCode)) continue;
            var item = subscription.FindItemByClientHandle(change.ClientHandle);
            var address = item?.Handle as string ?? item?.DisplayName;
            if (address is null || !TryConvert(dv.Value, out var value)) continue;
            batch.Add(new TagUpdate(Definition.Id, address, value, now));
        }
        if (batch.Count == 0) return;
        Interlocked.Exchange(ref _lastValueMs, now);
        try
        {
            Updates?.Invoke(batch);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "OPC UA {Id}: Updates handler threw", Definition.Id);
        }
    }

    private void OnKeepAlive(ISession session, KeepAliveEventArgs e)
    {
        if (e.Status is null || ServiceResult.IsGood(e.Status)) return;
        lock (_sync)
        {
            if (!ReferenceEquals(session, _session) || _reconnect is null || _reconnecting) return;
            _reconnecting = true;
            _reconnect.BeginReconnect(session, (int)_ctx.Options.MinReconnectDelay.TotalMilliseconds, OnReconnectComplete);
        }
        _log.LogWarning("OPC UA {Id}: keep-alive failed ({Status}); reconnecting", Definition.Id, e.Status);
        SetStatus(ConnectionState.Connecting, $"Connection lost ({e.Status.StatusCode}); reconnecting");
    }

    private void OnReconnectComplete(object? sender, EventArgs e)
    {
        ISession? old = null;
        lock (_sync)
        {
            if (!ReferenceEquals(sender, _reconnect) || _reconnect is null) return;
            var fresh = _reconnect.Session;
            if (fresh is null)
            {
                _fatal?.TrySetResult("Reconnect gave up");
                return;
            }
            if (!ReferenceEquals(fresh, _session))
            {
                old = _session;
                if (old is not null) old.KeepAlive -= OnKeepAlive;
                _session = fresh;
                fresh.KeepAlive -= OnKeepAlive;
                fresh.KeepAlive += OnKeepAlive;
                foreach (var sub in fresh.Subscriptions) sub.FastDataChangeCallback = _onDataChange;
            }
            _reconnecting = false;
        }
        if (old is not null) Utils.SilentDispose(old);
        _log.LogInformation("OPC UA {Id}: reconnected", Definition.Id);
        SetStatus(ConnectionState.Connected, _nodeIdProblems);
    }

    // ------------------------------------------------------------------ helpers

    private async Task TearDownSessionAsync()
    {
        ISession? session;
        ISession? handlerSession;
        SessionReconnectHandler? reconnect;
        lock (_sync)
        {
            session = _session;
            reconnect = _reconnect;
            handlerSession = reconnect?.Session;
            _session = null;
            _reconnect = null;
            _fatal = null;
            _reconnecting = false;
        }
        if (reconnect is not null)
        {
            try
            {
                reconnect.CancelReconnect();
            }
            catch (Exception ex)
            {
                _log.LogDebug(ex, "OPC UA {Id}: cancelling reconnect failed", Definition.Id);
            }
            Utils.SilentDispose(reconnect);
        }
        if (session is not null)
        {
            session.KeepAlive -= OnKeepAlive;
            await CloseQuietlyAsync(session).ConfigureAwait(false);
        }
        if (handlerSession is not null && !ReferenceEquals(handlerSession, session))
            await CloseQuietlyAsync(handlerSession).ConfigureAwait(false);
    }

    private async Task CloseQuietlyAsync(ISession session)
    {
        try
        {
            var timeout = Math.Min(_ctx.Options.OperationTimeoutMs, 2000);
            using var cts = new CancellationTokenSource(timeout + 1000);
            await session.CloseAsync(timeout, true, cts.Token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "OPC UA {Id}: closing the session failed", Definition.Id);
        }
        Utils.SilentDispose(session);
    }

    private void SetStatus(ConnectionState state, string? error, int? boundTags = null)
    {
        ConnectionStatus published;
        lock (_statusLock)
        {
            var current = Volatile.Read(ref _status);
            var next = current with { Status = state, Error = error, BoundTags = boundTags ?? current.BoundTags };
            if (next == current) return;
            Volatile.Write(ref _status, next);
            published = Status;
            try
            {
                StatusChanged?.Invoke(published);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "OPC UA {Id}: StatusChanged handler threw", Definition.Id);
            }
        }
    }

    private static TimeSpan Jitter(TimeSpan delay) =>
        TimeSpan.FromMilliseconds(delay.TotalMilliseconds * (0.9 + Random.Shared.NextDouble() * 0.2));

    private static string Describe(Exception ex) => ex switch
    {
        ServiceResultException sre => $"{StatusCodes.GetBrowseName(sre.StatusCode)}: {sre.Message}",
        _ => ex.InnerException is { } inner ? $"{ex.Message} ({inner.Message})" : ex.Message,
    };

    /// <summary>Numbers, bool (0/1), enums and numeric strings become a finite double; everything else is skipped.</summary>
    internal static bool TryConvert(object? raw, out double value)
    {
        value = 0;
        switch (raw)
        {
            case null:
                return false;
            case Variant v:
                return TryConvert(v.Value, out value);
            case bool b:
                value = b ? 1 : 0;
                return true;
            case double d:
                value = d;
                break;
            case float f:
                value = f;
                break;
            case sbyte or byte or short or ushort or int or uint or long or ulong or decimal:
                value = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                break;
            case Enum e:
                value = Convert.ToDouble(e, CultureInfo.InvariantCulture);
                break;
            case string s:
                if (!double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out value)) return false;
                break;
            default:
                return false;
        }
        return double.IsFinite(value);
    }
}
