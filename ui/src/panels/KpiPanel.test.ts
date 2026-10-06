import { describe, expect, it } from 'vitest';
import { pushSample, STATE_BAR_ORDER, stateSegments } from './KpiPanel';

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
