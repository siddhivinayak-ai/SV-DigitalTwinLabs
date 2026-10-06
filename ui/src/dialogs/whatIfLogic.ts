// Pure what-if helpers (unit-tested).
import type { KpiDelta, WhatIfOverride } from '../net/contracts';

export interface OverrideRow { assetId: string; param: string; value: number }

/** Merge editor rows into the request shape: one override per asset, last value wins. */
export function buildOverrides(rows: OverrideRow[]): WhatIfOverride[] {
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (!r.assetId || !r.param || !Number.isFinite(r.value)) continue;
    let p = map.get(r.assetId);
    if (!p) map.set(r.assetId, (p = {}));
    p[r.param] = r.value;
  }
  return [...map].map(([assetId, params]) => ({ assetId, params }));
}

const LOWER_IS_BETTER = new Set(['scrap', 'wip']);
const PCT_METRICS = new Set(['oee', 'availability', 'performance', 'quality']);

export function higherIsBetter(metric: string): boolean {
  return !LOWER_IS_BETTER.has(metric);
}

/** 'better' | 'worse' | 'same' for a delta, honouring metric direction. */
export function classifyDelta(d: Pick<KpiDelta, 'metric' | 'delta' | 'deltaPct'>, epsPct = 0.05): 'better' | 'worse' | 'same' {
  if (!Number.isFinite(d.delta) || d.delta === 0 || Math.abs(d.deltaPct) < epsPct) return 'same';
  const up = d.delta > 0;
  return up === higherIsBetter(d.metric) ? 'better' : 'worse';
}

export function metricLabel(metric: string): string {
  const L: Record<string, string> = {
    oee: 'OEE', availability: 'Availability', performance: 'Performance', quality: 'Quality',
    throughputPerHour: 'Throughput', good: 'Good parts', scrap: 'Scrap', wip: 'WIP',
  };
  return L[metric] ?? metric;
}

export function metricUnit(metric: string): string {
  if (PCT_METRICS.has(metric)) return '%';
  if (metric === 'throughputPerHour') return 'pcs/h';
  return 'pcs';
}

/** Format a metric value: fractions as %, throughput 1 dp, counts as integers. */
export function formatMetric(metric: string, v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (PCT_METRICS.has(metric)) return (v * 100).toFixed(1);
  if (metric === 'throughputPerHour') return v.toFixed(1);
  return Math.round(v).toString();
}

/** Signed delta text in the metric's display unit. */
export function formatDelta(metric: string, delta: number): string {
  if (!Number.isFinite(delta)) return '—';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const a = Math.abs(delta);
  if (PCT_METRICS.has(metric)) return `${sign}${(a * 100).toFixed(1)} pt`;
  if (metric === 'throughputPerHour') return `${sign}${a.toFixed(1)}`;
  return `${sign}${Math.round(a)}`;
}

export function formatDeltaPct(p: number): string {
  if (!Number.isFinite(p)) return '—';
  const sign = p > 0 ? '+' : p < 0 ? '−' : '±';
  return `${sign}${Math.abs(p).toFixed(1)} %`;
}

export const WHATIF_DURATIONS = [
  { label: '1 hour', value: 3600 },
  { label: '4 hours', value: 4 * 3600 },
  { label: '8 hours (one shift)', value: 8 * 3600 },
  { label: '24 hours', value: 24 * 3600 },
];
