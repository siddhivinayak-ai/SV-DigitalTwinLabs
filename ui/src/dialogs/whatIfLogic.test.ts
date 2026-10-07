import { describe, expect, it } from 'vitest';
import { buildOverrides, classifyDelta, formatDelta, formatDeltaPct, formatMetric } from './whatIfLogic';

describe('buildOverrides', () => {
  it('merges rows per asset; last value wins; skips incomplete rows', () => {
    expect(buildOverrides([
      { assetId: 'ASSY-01', param: 'cycleTimeS', value: 22 },
      { assetId: 'CNC-01', param: 'mttrS', value: 300 },
      { assetId: 'ASSY-01', param: 'scrapRate', value: 0.005 },
      { assetId: 'ASSY-01', param: 'cycleTimeS', value: 20 },
      { assetId: '', param: 'x', value: 1 },
      { assetId: 'CNC-02', param: 'mtbfS', value: Number.NaN },
    ])).toEqual([
      { assetId: 'ASSY-01', params: { cycleTimeS: 20, scrapRate: 0.005 } },
      { assetId: 'CNC-01', params: { mttrS: 300 } },
    ]);
  });
});

describe('classifyDelta', () => {
  it('higher is better for OEE and throughput', () => {
    expect(classifyDelta({ metric: 'oee', delta: 0.067, deltaPct: 9.8 })).toBe('better');
    expect(classifyDelta({ metric: 'throughputPerHour', delta: -3, deltaPct: -2 })).toBe('worse');
  });
  it('lower is better for scrap and WIP', () => {
    expect(classifyDelta({ metric: 'scrap', delta: 4, deltaPct: 10.8 })).toBe('worse');
    expect(classifyDelta({ metric: 'wip', delta: -5, deltaPct: -20 })).toBe('better');
  });
  it('treats tiny changes as unchanged', () => {
    expect(classifyDelta({ metric: 'oee', delta: 0, deltaPct: 0 })).toBe('same');
    expect(classifyDelta({ metric: 'oee', delta: 0.00001, deltaPct: 0.001 })).toBe('same');
  });
});

describe('formatting', () => {
  it('formats metrics in display units', () => {
    expect(formatMetric('oee', 0.684)).toBe('68.4');
    expect(formatMetric('throughputPerHour', 128.64)).toBe('128.6');
    expect(formatMetric('good', 1029.4)).toBe('1029');
  });
  it('formats signed deltas', () => {
    expect(formatDelta('oee', 0.067)).toBe('+6.7 pt');
    expect(formatDelta('scrap', -4)).toBe('−4');
    expect(formatDelta('good', 0)).toBe('±0');
    expect(formatDeltaPct(14.384)).toBe('+14.4 %');
    expect(formatDeltaPct(-2)).toBe('−2.0 %');
  });
});
