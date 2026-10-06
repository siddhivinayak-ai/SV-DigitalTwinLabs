import { describe, expect, it } from 'vitest';
import {
  alignSeries, fmtSimTime, fmtValue, layoutSubplots, lowerBound, sliceWindow, windowIndices, windowRange,
  windowSeconds, yRangeWithLimits,
} from './series';

const series = (n: number, dt = 0.2) => ({ t: Array.from({ length: n }, (_, i) => i * dt), v: Array.from({ length: n }, (_, i) => i) });

describe('history window slicing', () => {
  it('binary-searches the window start', () => {
    const t = [0, 1, 2, 3, 4, 5];
    expect(lowerBound(t, 2.5)).toBe(3);
    expect(lowerBound(t, -1)).toBe(0);
    expect(lowerBound(t, 99)).toBe(6);
  });

  it('keeps one sample before the window so the trace reaches the left edge', () => {
    const s = series(1000); // 0 .. 199.8 s
    const now = 199.8;
    const w = sliceWindow(s, now, 60);
    expect(w.t[0]).toBeLessThan(now - 60);
    expect(w.t[1]).toBeGreaterThanOrEqual(now - 60);
    expect(w.t[w.t.length - 1]).toBe(now);
    expect(w.v.length).toBe(w.t.length);
  });

  it('returns everything for All and for windows longer than the history', () => {
    const s = series(50);
    expect(windowIndices(s.t, 9.8, Infinity)).toEqual([0, 50]);
    expect(windowIndices(s.t, 9.8, 1800)).toEqual([0, 50]);
    expect(windowIndices([], 10, 60)).toEqual([0, 0]);
  });

  it('does not mutate the source arrays', () => {
    const s = series(20);
    const w = sliceWindow(s, 3.8, 1);
    w.t.push(-1);
    expect(s.t.length).toBe(20);
  });

  it('computes the visible x-range', () => {
    expect(windowRange([0, 1], 100, 60)).toEqual([40, 100]);
    expect(windowRange([10, 11], 30, 300)).toEqual([10, 30]); // history shorter than the window
    expect(windowRange([], 0, 60)).toEqual([0, 1]);
    expect(windowRange([5, 6], 100, Infinity)).toEqual([5, 100]);
    expect(windowRange([], 0, Infinity)).toEqual([0, 1]);
    expect(windowSeconds('5m')).toBe(300);
    expect(windowSeconds('all')).toBe(Infinity);
  });
});

describe('series alignment', () => {
  it('shares x when timestamps match', () => {
    const a = { t: [0, 1, 2], v: [1, 2, 3] }, b = { t: [0, 1, 2], v: [4, 5, 6] };
    expect(alignSeries([a, b])).toEqual([[0, 1, 2], [1, 2, 3], [4, 5, 6]]);
  });

  it('merges ragged series with null gaps', () => {
    const a = { t: [0, 1, 2], v: [1, 2, 3] }, b = { t: [1, 2, 3], v: [5, 6, 7] };
    expect(alignSeries([a, b])).toEqual([[0, 1, 2, 3], [1, 2, 3, null], [null, 5, 6, 7]]);
  });
});

describe('y ranging with limits', () => {
  it('pads the data range and includes nearby limits', () => {
    const [lo, hi] = yRangeWithLimits(24, 62, [70, 80]);
    expect(hi).toBeGreaterThan(80);
    expect(lo).toBeLessThan(24);
  });

  it('ignores far-away limits so idle traces are not squashed', () => {
    const [, hi] = yRangeWithLimits(0.1, 1.2, [4.5, 7.1]);
    expect(hi).toBeLessThan(2);
  });

  it('handles flat and empty data', () => {
    const [lo, hi] = yRangeWithLimits(5, 5);
    expect(hi).toBeGreaterThan(lo);
    expect(yRangeWithLimits(null, null)[1]).toBeGreaterThan(0);
    expect(yRangeWithLimits(0, 3)[0]).toBe(0);
  });
});

describe('formatting', () => {
  it('formats sim time and values', () => {
    expect(fmtSimTime(0)).toBe('0:00');
    expect(fmtSimTime(75)).toBe('1:15');
    expect(fmtSimTime(3725)).toBe('1:02:05');
    expect(fmtValue(62.346, '°C')).toBe('62.35 °C');
    expect(fmtValue(null)).toBe('—');
    expect(fmtValue(1.23456)).toBe('1.235');
  });
});

describe('subplot layout', () => {
  const s = (id: string, kind: string, unit: string) => ({ id, kind, unit });
  it('one unit → one axes', () => {
    const l = layoutSubplots([s('a.temp', 'temperature', '°C'), s('b.temp', 'temperature', '°C')]);
    expect(l).toHaveLength(1);
    expect(l[0].left.sensors).toHaveLength(2);
    expect(l[0].left.label).toBe('Temperature [°C]');
  });

  it('temperature on top, vibration and power below (yyaxis)', () => {
    const l = layoutSubplots([s('x.power', 'power', 'kW'), s('x.vib', 'vibration', 'mm/s'), s('x.temp', 'temperature', '°C')]);
    expect(l).toHaveLength(2);
    expect(l[0].left.unit).toBe('°C');
    expect(l[1].left.unit).toBe('mm/s');
    expect(l[1].right?.unit).toBe('kW');
  });

  it('caps at two subplots and four axes', () => {
    const l = layoutSubplots([
      s('t', 'temperature', '°C'), s('v', 'vibration', 'mm/s'), s('p', 'power', 'kW'), s('c', 'current', 'A'), s('l', 'level', 'pcs'),
    ]);
    expect(l).toHaveLength(2);
    expect(l[0].right?.unit).toBe('A, pcs');
    expect(layoutSubplots([])).toEqual([]);
  });
});
