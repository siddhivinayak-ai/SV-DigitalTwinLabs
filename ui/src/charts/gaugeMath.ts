// Pure maths for the gauges and meters (no DOM), unit-tested.

export interface GaugeZones {
  /** Below this the value is in alarm (red). */
  alarm?: number;
  /** Below this the value is in warning (amber). */
  warn?: number;
  /** At or above this the value has reached its target (green accent). */
  target?: number;
  /** true when larger is worse (e.g. scrap rate): the comparisons are inverted. */
  invert?: boolean;
}

export type GaugeLevel = 'alarm' | 'warn' | 'normal' | 'target';

export function clampValue(v: number | null | undefined, min = 0, max = 1): number {
  if (v == null || !Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** Fraction 0..1 of `v` within [min, max], clamped (NaN → 0). */
export function fraction(v: number | null | undefined, min = 0, max = 1): number {
  if (!(max > min)) return 0;
  return (clampValue(v, min, max) - min) / (max - min);
}

/** Classify a value against its zones (ISA-101: colour only when abnormal, or when on target). */
export function gaugeLevel(v: number | null | undefined, z: GaugeZones): GaugeLevel {
  if (v == null || !Number.isFinite(v)) return 'normal';
  const short = (lim?: number) => lim != null && (z.invert ? v > lim : v < lim);
  if (short(z.alarm)) return 'alarm';
  if (short(z.warn)) return 'warn';
  if (z.target != null && !short(z.target)) return 'target';
  return 'normal';
}

export interface LevelColors { alarm: string; warn: string; normal: string; target: string }

export function gaugeColor(v: number | null | undefined, z: GaugeZones, c: LevelColors): string {
  return c[gaugeLevel(v, z)];
}

/** Classic analog gauge sweep: 240°, from lower-left clockwise to lower-right (canvas angles, y down). */
export const ARC_START = (150 * Math.PI) / 180;
export const ARC_SWEEP = (240 * Math.PI) / 180;

/** Canvas angle of a value on the arc. */
export function arcAngle(v: number | null | undefined, min = 0, max = 1): number {
  return ARC_START + fraction(v, min, max) * ARC_SWEEP;
}

/** Percent string with fixed decimals, '—' for missing values. */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v * 100).toFixed(digits);
}

/** World-class OEE reference targets (Nakajima): A 90 %, P 95 %, Q 99.9 %, OEE 85 %. */
export const WORLD_CLASS = { oee: 0.85, availability: 0.9, performance: 0.95, quality: 0.999 } as const;
