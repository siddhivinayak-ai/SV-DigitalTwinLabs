import { describe, expect, it } from 'vitest';
import plantV03 from '../../../contracts/examples/plant.v03.json';
import kpiV03 from '../../../contracts/examples/kpi.v03.json';
import type { KpiReport, PlantModel } from '../net/contracts';
import { lineKpiRows, pushSample, resourceKpiRows, STATE_BAR_ORDER, stateSegments } from './KpiPanel';

describe('KpiPanel state-fraction bar', () => {
  it('normalises fractions in bar order', () => {
    const s = stateSegments({ running: 0.5, starved: 0.25, blocked: 0.25, fault: 0, maintenance: 0, idle: 0, off: 0 });
    expect(s.map((x) => x.state)).toEqual(STATE_BAR_ORDER);
    expect(s.reduce((a, x) => a + x.frac, 0)).toBeCloseTo(1);
    expect(s[0]).toEqual({ state: 'running', frac: 0.5 });
  });

  it('rescales partial sums and drops invalid values', () => {
    const s = stateSegments({ running: 2, fault: 2, starved: Number.NaN, blocked: -1 });
    expect(s.find((x) => x.state === 'running')!.frac).toBeCloseTo(0.5);
    expect(s.find((x) => x.state === 'starved')!.frac).toBe(0);
    expect(s.find((x) => x.state === 'blocked')!.frac).toBe(0);
  });

  it('is all zero without data', () => {
    expect(stateSegments(undefined).every((x) => x.frac === 0)).toBe(true);
  });
});

describe('KpiPanel throughput history', () => {
  it('appends advancing samples, overwrites equal time, ignores going back, and caps', () => {
    const s = { t: [] as number[], v: [] as number[] };
    pushSample(s, 1, 10);
    pushSample(s, 2, 11);
    pushSample(s, 2, 12);
    pushSample(s, 1.5, 99);
    pushSample(s, Number.NaN, 1);
    expect(s).toEqual({ t: [1, 2], v: [10, 12] });
    for (let i = 3; i < 20; i++) pushSample(s, i, i, 5);
    expect(s.t).toEqual([15, 16, 17, 18, 19]);
  });
});

describe('KpiPanel v0.3 line and resource tables', () => {
  const plant = plantV03 as unknown as PlantModel;
  const kpi = (kpiV03 as unknown as { data: KpiReport }).data;

  it('maps KpiReport.lines to rows in plant line order with names', () => {
    const reversed: KpiReport = { ...kpi, lines: [...kpi.lines!].reverse() };
    const rows = lineKpiRows(plant, reversed);
    expect(rows.map((r) => [r.lineId, r.name])).toEqual([['line-a', 'Line A'], ['line-b', 'Line B']]);
    expect(rows[0]).toMatchObject({ oee: 0.7, availability: 0.95, performance: 0.8, quality: 0.92, throughputPerHour: 60.1, wip: 8, bottleneckAssetId: 'CNC-01' });
  });

  it('appends lines unknown to the plant and falls back to the id', () => {
    const k: KpiReport = { ...kpi, lines: [{ lineId: 'zz', kpi: { ...kpi.line, bottleneckAssetId: undefined } }, ...kpi.lines!] };
    const rows = lineKpiRows(plant, k);
    expect(rows.map((r) => r.name)).toEqual(['Line A', 'Line B', 'zz']);
    expect('bottleneckAssetId' in rows[2]).toBe(false);
  });

  it('is empty for plants/reports without lines or resources', () => {
    expect(lineKpiRows(plant, { ...kpi, lines: undefined })).toEqual([]);
    expect(lineKpiRows(null, null)).toEqual([]);
    expect(resourceKpiRows(plant, { ...kpi, resources: undefined })).toEqual([]);
  });

  it('maps resources with kind, name and clamped utilisation', () => {
    expect(resourceKpiRows(plant, kpi)).toEqual([{ resourceId: 'op-pool', name: 'Operators', kind: 'operator', count: 2, utilization: 0.81, waitSeconds: 412.5 }]);
    const odd = resourceKpiRows({ resources: [] }, { ...kpi, resources: [{ resourceId: 'x', count: 0, utilization: 1.4, waitSeconds: Number.NaN }] });
    expect(odd).toEqual([{ resourceId: 'x', name: 'x', kind: 'operator', count: 0, utilization: 1, waitSeconds: 0 }]);
  });
});
