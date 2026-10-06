import { describe, expect, it } from 'vitest';
import { ARC_START, ARC_SWEEP, arcAngle, clampValue, fraction, gaugeColor, gaugeLevel, pct } from './gaugeMath';

const colors = { alarm: 'red', warn: 'amber', normal: 'grey', target: 'green' };
const oeeZones = { alarm: 0.4, warn: 0.6, target: 0.85 };

describe('gauge value clamping', () => {
  it('clamps into range and treats NaN/null as the minimum', () => {
    expect(clampValue(1.4)).toBe(1);
    expect(clampValue(-0.2)).toBe(0);
    expect(clampValue(0.42)).toBe(0.42);
    expect(clampValue(Number.NaN)).toBe(0);
    expect(clampValue(null, 10, 20)).toBe(10);
    expect(clampValue(Infinity)).toBe(0);
  });

  it('maps values to a fraction and an arc angle', () => {
    expect(fraction(50, 0, 200)).toBe(0.25);
    expect(fraction(5, 5, 5)).toBe(0);
    expect(arcAngle(0)).toBeCloseTo(ARC_START);
    expect(arcAngle(1)).toBeCloseTo(ARC_START + ARC_SWEEP);
    expect(arcAngle(2)).toBeCloseTo(ARC_START + ARC_SWEEP);
    expect(arcAngle(0.5)).toBeCloseTo(ARC_START + ARC_SWEEP / 2);
  });
});

describe('gauge colour selection', () => {
  it('classifies against alarm / warn / target', () => {
    expect(gaugeLevel(0.3, oeeZones)).toBe('alarm');
    expect(gaugeLevel(0.5, oeeZones)).toBe('warn');
    expect(gaugeLevel(0.7, oeeZones)).toBe('normal');
    expect(gaugeLevel(0.85, oeeZones)).toBe('target');
    expect(gaugeLevel(0.95, oeeZones)).toBe('target');
    expect(gaugeColor(0.5, oeeZones, colors)).toBe('amber');
  });

  it('is grey (normal) without zones or values', () => {
    expect(gaugeLevel(0.1, {})).toBe('normal');
    expect(gaugeLevel(null, oeeZones)).toBe('normal');
    expect(gaugeLevel(Number.NaN, oeeZones)).toBe('normal');
  });

  it('inverts for larger-is-worse metrics', () => {
    const scrap = { warn: 0.02, alarm: 0.05, invert: true };
    expect(gaugeLevel(0.01, scrap)).toBe('normal');
    expect(gaugeLevel(0.03, scrap)).toBe('warn');
    expect(gaugeLevel(0.08, scrap)).toBe('alarm');
  });

  it('formats percentages', () => {
    expect(pct(0.8567)).toBe('85.7');
    expect(pct(undefined)).toBe('—');
  });
});
