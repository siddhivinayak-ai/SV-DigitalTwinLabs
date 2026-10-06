// Pure data helpers for the trend plots (no DOM, no uPlot): window slicing, alignment, ranging.

export interface Columnar { t: ArrayLike<number>; v: ArrayLike<number> }

/** Rolling window choices, in seconds of sim time (`Infinity` = all history). */
export const WINDOWS = [
  { key: '60s', label: '60 s', seconds: 60 },
  { key: '5m', label: '5 m', seconds: 300 },
  { key: '30m', label: '30 m', seconds: 1800 },
  { key: 'all', label: 'All', seconds: Infinity },
] as const;
export type WindowKey = (typeof WINDOWS)[number]['key'];

export function windowSeconds(key: WindowKey): number {
  return WINDOWS.find((w) => w.key === key)?.seconds ?? 60;
}

/** First index i with t[i] >= x (binary search over an ascending array). */
export function lowerBound(t: ArrayLike<number>, x: number): number {
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Index range [start, end) of the samples inside the rolling window ending at `now`.
 * One sample before the window is kept so the line enters from the left edge instead of starting mid-plot.
 */
export function windowIndices(t: ArrayLike<number>, now: number, seconds: number): [number, number] {
  const n = t.length;
  if (!n) return [0, 0];
  if (!Number.isFinite(seconds)) return [0, n];
  const start = Math.max(0, lowerBound(t, now - seconds) - 1);
  return [start, n];
}

/** Visible x-range of the window ending at `now`; 'all' spans the first sample to now. */
export function windowRange(t: ArrayLike<number>, now: number, seconds: number): [number, number] {
  if (!Number.isFinite(seconds)) {
    const first = t.length ? t[0] : now;
    return [first, Math.max(now, first + 1)];
  }
  return [now - seconds, now];
}

/** Slice a columnar series to the rolling window (copies, never mutates the store's arrays). */
export function sliceWindow(s: Columnar, now: number, seconds: number): { t: number[]; v: number[] } {
  const [a, b] = windowIndices(s.t, now, seconds);
  return { t: Array.prototype.slice.call(s.t, a, b) as number[], v: Array.prototype.slice.call(s.v, a, b) as number[] };
}

export type Aligned = [number[], ...(number | null)[][]];

/**
 * Align several columnar series on one x-vector (uPlot AlignedData). Fast path when all share the
 * same timestamps (the normal case: every sensor is sampled on the same tick); otherwise a merge
 * that fills gaps with null.
 */
export function alignSeries(list: readonly Columnar[]): Aligned {
  if (!list.length) return [[]];
  const t0 = list[0].t;
  const same = list.every((s) => s.t.length === t0.length && (t0.length === 0 || (s.t[0] === t0[0] && s.t[s.t.length - 1] === t0[t0.length - 1])));
  if (same) return [Array.from(t0), ...list.map((s) => Array.from(s.v) as (number | null)[])];
  const xs = new Set<number>();
  for (const s of list) for (let i = 0; i < s.t.length; i++) xs.add(s.t[i]);
  const x = [...xs].sort((a, b) => a - b);
  const idx = new Map<number, number>();
  x.forEach((v, i) => idx.set(v, i));
  const ys = list.map((s) => {
    const y: (number | null)[] = new Array(x.length).fill(null);
    for (let i = 0; i < s.t.length; i++) y[idx.get(s.t[i])!] = s.v[i];
    return y;
  });
  return [x, ...ys];
}

/**
 * MATLAB-like y-range: 6 % padding, and limit lines pulled into view once the data reaches at least
 * half-way to them (so a hi limit is visible before it is crossed, without squashing idle traces).
 */
export function yRangeWithLimits(min: number | null, max: number | null, limits: readonly number[] = []): [number, number] {
  let lo = min ?? 0, hi = max ?? 1;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  const dataLo = lo;
  for (const l of limits) {
    if (!Number.isFinite(l)) continue;
    if (hi >= l * 0.5) { hi = Math.max(hi, l); lo = Math.min(lo, l); }
  }
  if (hi - lo < 1e-9) { const c = lo; const d = Math.max(0.5, Math.abs(c) * 0.1); lo = c - d; hi = c + d; }
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  if (dataLo >= 0 && lo < 0) lo = 0; // the quantities plotted here are non-negative
  return [lo, hi];
}

/** Format seconds of sim time as m:ss or h:mm:ss for the x-axis. */
export function fmtSimTime(sec: number): string {
  if (!Number.isFinite(sec)) return '';
  const neg = sec < 0;
  let s = Math.abs(Math.round(sec));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  return neg ? `-${body}` : body;
}

/** Engineering number formatting for legends/readouts: decimals chosen by magnitude. */
export function fmtValue(v: number | null | undefined, unit = ''): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 10 ? v.toFixed(2) : v.toFixed(3);
  return unit ? `${s} ${unit}` : s;
}

// ---------------------------------------------------------------------------------------------
// Subplot layout (MATLAB `subplot(2,1,k)` + `yyaxis left/right`)

export interface PlotSensor { id: string; kind: string; unit: string; hi?: number; hiHi?: number }
export interface AxisSlot { unit: string; label: string; sensors: PlotSensor[] }
export interface SubplotSpec { left: AxisSlot; right?: AxisSlot }

const KIND_ORDER = ['temperature', 'vibration', 'power', 'current', 'speed', 'level', 'count'];
const KIND_LABEL: Record<string, string> = {
  temperature: 'Temperature', vibration: 'Vibration', power: 'Power', current: 'Current', speed: 'Speed', level: 'Level', count: 'Count',
};

/**
 * Split the checked sensors into at most two stacked subplots, one y-axis per unit and at most two
 * units per subplot (left/right). Fill order: top-left, bottom-left, bottom-right, top-right; any
 * further units share the last axis.
 */
export function layoutSubplots(sensors: readonly PlotSensor[]): SubplotSpec[] {
  if (!sensors.length) return [];
  const groups = new Map<string, PlotSensor[]>();
  const rank = (s: PlotSensor) => { const i = KIND_ORDER.indexOf(s.kind); return i < 0 ? 99 : i; };
  for (const s of [...sensors].sort((a, b) => rank(a) - rank(b))) {
    const key = s.unit || s.kind;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(s);
  }
  const slots: AxisSlot[] = [...groups.entries()].map(([unit, list]) => {
    const kinds = [...new Set(list.map((s) => KIND_LABEL[s.kind] ?? s.kind))];
    return { unit, label: `${kinds.join(' / ')} [${unit}]`, sensors: list };
  });
  if (slots.length === 1) return [{ left: slots[0] }];
  const cells: (AxisSlot | undefined)[] = [undefined, undefined, undefined, undefined];
  slots.forEach((s, i) => {
    const c = Math.min(i, 3);
    const prev = cells[c];
    cells[c] = prev ? { unit: `${prev.unit}, ${s.unit}`, label: `${prev.label}, ${s.label}`, sensors: [...prev.sensors, ...s.sensors] } : s;
  });
  const top: SubplotSpec = { left: cells[0]!, ...(cells[3] ? { right: cells[3] } : {}) };
  const bottom: SubplotSpec = { left: cells[1]!, ...(cells[2] ? { right: cells[2] } : {}) };
  return [top, bottom];
}
