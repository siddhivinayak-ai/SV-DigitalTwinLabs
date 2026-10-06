import { describe, expect, it, vi } from 'vitest';
import { TwinStore } from '../state/store';
import { MockSource } from './MockSource';

describe('MockSource', () => {
  it('flows parts to the sink and emits kpi', async () => {
    vi.useFakeTimers();
    const store = new TwinStore();
    const src = new MockSource(store);
    let kpis = 0;
    store.on('kpi', () => kpis++);
    src.connect();
    await src.command({ action: 'sim.speed', value: 100 });
    vi.advanceTimersByTime(60_000); // 60 s wall at x100 = 100 sim minutes
    src.disconnect();
    vi.useRealTimers();
    expect(store.plant?.assets).toHaveLength(11);
    expect(store.assets.get('SNK-01')!.good).toBeGreaterThan(50);
    expect(kpis).toBeGreaterThan(50);
    expect(store.getHistory('CNC-01.temp').t.length).toBeGreaterThan(100);
  });
});
