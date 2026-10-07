import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwinClient, backoffDelay, defaultWsUrl, type WsLike } from './TwinClient';
import { TwinStore, type ConnectionState } from '../state/store';
import { Api } from './api';
import type { ClientMessage } from './contracts';

class FakeWs implements WsLike {
  static instances: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) { FakeWs.instances.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  // test helpers
  open() { this.readyState = 1; this.onopen?.({}); }
  fail() { this.readyState = 3; this.onerror?.({}); this.onclose?.({}); }
  receive(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  lastCommand(): ClientMessage { return JSON.parse(this.sent[this.sent.length - 1]) as ClientMessage; }
}

const latest = () => FakeWs.instances[FakeWs.instances.length - 1];

function setup() {
  const store = new TwinStore();
  const states: ConnectionState[] = [];
  store.on('connection', (c) => states.push(c));
  const client = new TwinClient(store, { url: 'ws://test/ws', wsFactory: (u) => new FakeWs(u) });
  return { store, client, states };
}

describe('TwinClient', () => {
  beforeEach(() => { FakeWs.instances = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('connects and reports connection states', () => {
    const { client, states } = setup();
    client.connect();
    expect(latest().url).toBe('ws://test/ws');
    expect(states).toEqual(['connecting']);
    latest().open();
    expect(states).toEqual(['connecting', 'connected']);
    expect(client.everConnected).toBe(true);
  });

  it('applies every server message to the store', () => {
    const { client, store } = setup();
    client.connect();
    latest().open();
    latest().receive({ type: 'event', t: 5, seq: 7, data: { id: 1, timeMs: 5, kind: 'info', severity: 'info', message: 'hello' } });
    expect(store.events).toHaveLength(1);
    expect(store.lastSeq).toBe(7);
  });

  it('resolves command() on the ack with the matching commandId', async () => {
    const { client } = setup();
    client.connect();
    latest().open();
    const p1 = client.command({ action: 'sim.start' });
    const id1 = latest().lastCommand().data.id;
    const p2 = client.command({ action: 'sim.speed', value: 5 });
    const msg2 = latest().lastCommand();
    expect(msg2.type).toBe('command');
    expect(msg2.data).toMatchObject({ action: 'sim.speed', value: 5 });
    expect(msg2.data.id).not.toBe(id1);

    // ack for the second arrives first; an unrelated ack is ignored
    latest().receive({ type: 'ack', t: 0, seq: 1, data: { commandId: 'someone-else', ok: true } });
    latest().receive({ type: 'ack', t: 0, seq: 2, data: { commandId: msg2.data.id, ok: false, error: 'bad speed' } });
    await expect(p2).resolves.toEqual({ commandId: msg2.data.id, ok: false, error: 'bad speed' });
    expect(client.pendingCount).toBe(1);
    latest().receive({ type: 'ack', t: 0, seq: 3, data: { commandId: id1, ok: true } });
    await expect(p1).resolves.toMatchObject({ ok: true });
    expect(client.pendingCount).toBe(0);
  });

  it('rejects command() after 5 s without an ack', async () => {
    const { client } = setup();
    client.connect();
    latest().open();
    const p = client.command({ action: 'sim.pause' });
    const assertion = expect(p).rejects.toThrow(/within 5 s/);
    vi.advanceTimersByTime(4999);
    expect(client.pendingCount).toBe(1);
    vi.advanceTimersByTime(1);
    await assertion;
    expect(client.pendingCount).toBe(0);
  });

  it('rejects command() immediately when not connected', async () => {
    const { client } = setup();
    await expect(client.command({ action: 'sim.start' })).rejects.toThrow(/Not connected/);
  });

  it('rejects pending commands when the socket drops', async () => {
    const { client } = setup();
    client.connect();
    latest().open();
    const p = client.command({ action: 'sim.reset' });
    latest().fail();
    await expect(p).rejects.toThrow(/Connection lost/);
  });

  it('reconnects with exponential backoff from 0.5 s capped at 10 s', () => {
    const { client, states } = setup();
    client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = FakeWs.instances.length;
      latest().fail();
      expect(states[states.length - 1]).toBe('disconnected');
      const t0 = Date.now();
      // advance until a new socket is created
      let waited = 0;
      while (FakeWs.instances.length === before && waited < 20_000) { vi.advanceTimersByTime(100); waited += 100; }
      delays.push(Date.now() - t0);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(states[states.length - 1]).toBe('connecting');
  });

  it('resets the backoff after a successful connection', () => {
    const { client } = setup();
    client.connect();
    latest().fail();
    vi.advanceTimersByTime(500);
    latest().fail();
    vi.advanceTimersByTime(1000);
    latest().open();
    const n = FakeWs.instances.length;
    latest().fail();
    vi.advanceTimersByTime(499);
    expect(FakeWs.instances.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances.length).toBe(n + 1);
  });

  it('stops reconnecting after disconnect()', () => {
    const { client, states } = setup();
    client.connect();
    latest().open();
    client.disconnect();
    expect(latest().closed).toBe(true);
    expect(states[states.length - 1]).toBe('disconnected');
    const n = FakeWs.instances.length;
    vi.advanceTimersByTime(30_000);
    expect(FakeWs.instances.length).toBe(n);
  });

  it('ignores malformed frames', () => {
    const { client, store } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.connect();
    latest().open();
    latest().onmessage?.({ data: '{not json' });
    expect(store.lastSeq).toBe(0);
    warn.mockRestore();
  });

  it('builds REST and export URLs', async () => {
    const calls: string[] = [];
    const api = new Api('/api', async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ sensorId: 'CNC-01.temp', unit: '°C', t: [], v: [] }), { headers: { 'content-type': 'application/json' } });
    });
    const client = new TwinClient(new TwinStore(), { url: 'ws://x/ws', wsFactory: (u) => new FakeWs(u), api });
    await client.history('CNC-01.temp', 600);
    expect(calls).toEqual(['/api/history/CNC-01.temp?seconds=600']);
    expect(client.exportCsvUrl(3600)).toBe('/api/export/csv?seconds=3600');
    expect(client.exportCsvUrl()).toBe('/api/export/csv?seconds=3600');
  });
});

describe('backoffDelay / defaultWsUrl', () => {
  it('doubles from 500 ms and caps at 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffDelay(n))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
  it('derives ws/wss from the page protocol', () => {
    expect(defaultWsUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
    expect(defaultWsUrl({ protocol: 'https:', host: 'twin.example' })).toBe('wss://twin.example/ws');
  });
});
