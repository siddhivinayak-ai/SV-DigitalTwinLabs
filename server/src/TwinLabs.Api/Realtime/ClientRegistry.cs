using System.Collections.Concurrent;

namespace TwinLabs.Api.Realtime;

/// <summary>The set of connected WebSocket clients. Broadcasting only enqueues, so it never blocks the caller.</summary>
public sealed class ClientRegistry
{
    private readonly ConcurrentDictionary<ClientOutbox, byte> _clients = new();

    public int Count => _clients.Count;

    public void Add(ClientOutbox client) => _clients.TryAdd(client, 0);

    public void Remove(ClientOutbox client) => _clients.TryRemove(client, out _);

    public void Broadcast(Frame frame)
    {
        foreach (var client in _clients.Keys)
            if (!client.Enqueue(frame)) Remove(client);
    }
}
