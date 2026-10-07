import { describe, expect, it } from 'vitest';
import {
  formatDuration, formatNum, formatPct, formatSimClock, formatSimTime, formatSpeed, limitLevel, paramLabel, severityRank,
} from './format';

describe('formatSimClock', () => {
  it('formats HH:MM:SS.s', () => {
    expect(formatSimClock(0)).toBe('00:00:00.0');
    expect(formatSimClock(761_300)).toBe('00:12:41.3');
    expect(formatSimClock(3_600_000 + 59_999)).toBe('01:00:59.9');
    expect(formatSimClock(100 * 3600_000 + 1_000)).toBe('100:00:01.0');
  });
  it('truncates (does not round up) tenths', () => {
    expect(formatSimClock(59_999)).toBe('00:00:59.9');
  });
  it('clamps bad input', () => {
    expect(formatSimClock(-5)).toBe('00:00:00.0');
    expect(formatSimClock(Number.NaN)).toBe('00:00:00.0');
  });
  it('formatSimTime drops tenths', () => {
    expect(formatSimTime(761_300)).toBe('00:12:41');
  });
});

describe('formatDuration', () => {
  it('scales units', () => {
    expect(formatDuration(8_400)).toBe('8.4 s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(2 * 3600_000 + 7 * 60_000)).toBe('2h 07m');
  });
});

describe('numbers', () => {
  it('formatPct', () => {
    expect(formatPct(0.8734)).toBe('87.3 %');
    expect(formatPct(undefined)).toBe('—');
  });
  it('formatNum picks sensible decimals', () => {
    expect(formatNum(42)).toBe('42');
    expect(formatNum(3.14159)).toBe('3.142');
    expect(formatNum(71.234)).toBe('71.23');
    expect(formatNum(128.66)).toBe('128.7');
    expect(formatNum(1.5, 0)).toBe('2');
    expect(formatNum(undefined)).toBe('—');
  });
  it('formatSpeed', () => {
    expect(formatSpeed(0.25)).toBe('0.25×');
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(100)).toBe('100×');
  });
});

describe('domain helpers', () => {
  it('limitLevel', () => {
    expect(limitLevel(69.9, 70, 80)).toBeNull();
    expect(limitLevel(70, 70, 80)).toBe('hi');
    expect(limitLevel(85, 70, 80)).toBe('hihi');
    expect(limitLevel(40, 32)).toBe('hi');
    expect(limitLevel(5)).toBeNull();
    expect(limitLevel(undefined, 1, 2)).toBeNull();
  });
  it('paramLabel splits camelCase and extracts units', () => {
    expect(paramLabel('cycleTimeS')).toEqual({ label: 'Cycle Time', unit: 's' });
    expect(paramLabel('mtbfS')).toEqual({ label: 'MTBF', unit: 's' });
    expect(paramLabel('speedMps')).toEqual({ label: 'Speed', unit: 'm/s' });
    expect(paramLabel('ratedKw')).toEqual({ label: 'Rated', unit: 'kW' });
    expect(paramLabel('tempRiseC')).toEqual({ label: 'Temp Rise', unit: '°C' });
    expect(paramLabel('scrapRate')).toEqual({ label: 'Scrap Rate', unit: 'frac' });
    expect(paramLabel('capacity')).toEqual({ label: 'Capacity', unit: '' });
  });
  it('severityRank orders critical first', () => {
    expect(['info', 'critical', 'warning'].sort((a, b) => severityRank(a) - severityRank(b))).toEqual(['critical', 'warning', 'info']);
  });
});
