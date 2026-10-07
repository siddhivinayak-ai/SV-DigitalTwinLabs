import { afterEach, describe, expect, it, vi } from 'vitest';
import { TwinStore } from '../state/store';
import { MockSource } from './MockSource';
import { connectedTwinApi, DemoConnectedTwinApi } from '../connections/api';

afterEach(() => vi.useRealTimers());

describe('MockSource v0.2 demo', () => {
  it('emulates an OPC UA connection: connecting, then connected with fresh values', () => {
    vi.useFakeTimers();
    const store = new TwinStore();
    const src = new MockSource(store);
    const seen: string[] = [];
    store.on('connectionStatus', (c) => seen.push(c.status));
    src.connect();
    expect(store.connections.get('plc1')).toMatchObject({ kind: 'opcua', status: 'connecting', boundTags: 98 });
    vi.advanceTimersByTime(2000);
    const c = store.connections.get('plc1')!;
    expect(c.status).toBe('connected');
    expect(seen[0]).toBe('connected');
    const t0 = c.lastValueMs!;
    vi.advanceTimersByTime(2000);
    expect(store.connections.get('plc1')!.lastValueMs!).toBeGreaterThan(t0);
    expect(store.events.some((e) => e.message.startsWith('Connection plc1 connected'))).toBe(true);
    src.disconnect();
  });

  it('switches twin mode and raises deviation alarms in shadow', async () => {
    vi.useFakeTimers();
    const store = new TwinStore();
    const src = new MockSource(store);
    src.connect();
    vi.advanceTimersByTime(2000);
    expect(store.sim.mode).toBe('simulate');
    const ack = await src.command({ action: 'twin.mode', value: 1 });
    expect(ack.ok).toBe(true);
    expect(store.sim.mode).toBe('shadow');
    let raised = 0;
    store.on('alarm', (a) => { if (a.source === 'deviation' && a.active) raised++; });
    vi.advanceTimersByTime(10 * 60_000);
    expect(raised).toBeGreaterThan(0);
    const hist = src.demoHistoryAlarms(500);
    expect(hist.some((a) => a.source === 'deviation' && /^ALM-.+-deviation$/.test(a.id))).toBe(true);
    await src.command({ action: 'twin.mode', value: 0 });
    expect(store.sim.mode).toBe('simulate');
    expect([...store.alarms.values()].some((a) => a.source === 'deviation')).toBe(false);
    src.disconnect();
  });

  it('never raises deviation alarms in simulate mode', () => {
    vi.useFakeTimers();
    const store = new TwinStore();
    const src = new MockSource(store);
    let dev = 0;
    store.on('alarm', (a) => { if (a.source === 'deviation') dev++; });
    src.connect();
    vi.advanceTimersByTime(5 * 60_000);
    expect(dev).toBe(0);
    src.disconnect();
  });

  it('keeps scenarios and paged history in memory', async () => {
    vi.useFakeTimers();
    const store = new TwinStore();
    const src = new MockSource(store);
    src.connect();
    vi.advanceTimersByTime(3000);
    expect(src.demoScenarios()).toHaveLength(1);
    const s = src.demoSaveScenario({ name: ' Test ', request: { durationS: 3600, overrides: [{ assetId: 'CNC-01', params: { cycleTimeS: 15 } }] } });
    expect(s.name).toBe('Test');
    expect(src.demoScenarios().find((x) => x.id === s.id)).toMatchObject({ overrides: 1, durationS: 3600 });
    expect(src.demoScenario(s.id).request.overrides[0].assetId).toBe('CNC-01');
    src.demoDeleteScenario(s.id);
    expect(() => src.demoScenario(s.id)).toThrow(/404/);
    expect(() => src.demoSaveScenario({ name: '', request: { durationS: 1, overrides: [] } })).toThrow(/400/);

    const page1 = src.demoHistoryEvents(2);
    expect(page1).toHaveLength(2);
    expect(page1[0].id).toBeGreaterThan(page1[1].id);
    const page2 = src.demoHistoryEvents(2, page1[1].id);
    expect(page2.every((e) => e.id < page1[1].id)).toBe(true);
    src.disconnect();
  });

  it('is served through connectedTwinApi in demo mode', async () => {
    const store = new TwinStore();
    const src = new MockSource(store);
    const api = connectedTwinApi(src);
    expect(api).toBeInstanceOf(DemoConnectedTwinApi);
    expect(connectedTwinApi(src)).toBe(api);
    expect((await api.connections())[0].id).toBe('plc1');
    expect((await api.setMode('shadow')).mode).toBe('shadow');
  });
});
