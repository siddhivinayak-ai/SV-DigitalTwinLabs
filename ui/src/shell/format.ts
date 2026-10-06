// Pure formatting helpers (unit-tested). All times are sim milliseconds.

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Sim clock: HH:MM:SS.s (hours keep growing past 99). */
export function formatSimClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const tenths = Math.floor(ms / 100);
  const t = tenths % 10;
  const totalS = Math.floor(tenths / 10);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const hr = Math.floor(totalS / 3600);
  return `${pad(hr)}:${pad(m)}:${pad(s)}.${t}`;
}

/** Compact time-of-day for grids: HH:MM:SS. */
export function formatSimTime(ms: number): string {
  return formatSimClock(ms).slice(0, -2);
}

/** Elapsed duration, e.g. "8.4 s", "3m 05s", "2h 07m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const totalS = Math.floor(s);
  if (totalS < 3600) return `${Math.floor(totalS / 60)}m ${pad(totalS % 60)}s`;
  return `${Math.floor(totalS / 3600)}h ${pad(Math.floor(totalS / 60) % 60)}m`;
}

/** Fraction 0..1 → "87.3 %". */
export function formatPct(frac: number | undefined, digits = 1): string {
  if (frac === undefined || !Number.isFinite(frac)) return '—';
  return `${(frac * 100).toFixed(digits)} %`;
}

/** Number with fixed decimals; '—' for missing. Integers stay integers when digits is undefined. */
export function formatNum(v: number | undefined, digits?: number): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (digits === undefined) {
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  }
  return v.toFixed(digits);
}

/** Speed multiplier label: 0.25 → "0.25×", 1 → "1×". */
export function formatSpeed(speed: number): string {
  return `${+speed.toFixed(2)}×`;
}

export const SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100] as const;

/** Upper-case run-state label for the status bar. */
export function runStateLabel(state: string): string {
  return state.toUpperCase();
}

/** Human label for a camelCase key: "cycleTimeStdS" → "Cycle Time Std (s)". */
export function paramLabel(key: string): { label: string; unit: string } {
  const UNITS: [RegExp, string][] = [
    [/Kw$/, 'kW'], [/Mms$/, 'mm/s'], [/Mps$/, 'm/s'], [/C$/, '°C'], [/M$/, 'm'], [/S$/, 's'],
  ];
  let base = key;
  let unit = '';
  for (const [re, u] of UNITS) {
    if (re.test(key)) { base = key.replace(re, ''); unit = u; break; }
  }
  if (/Rate$/.test(key)) unit = 'frac';
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bMtbf\b/, 'MTBF').replace(/\bMttr\b/, 'MTTR').replace(/\bVib\b/, 'Vibration');
  return { label: words, unit };
}

/** Decimals for a sensor kind. */
export function sensorDigits(kind: string): number {
  switch (kind) {
    case 'temperature': return 1;
    case 'vibration': return 2;
    case 'power': return 2;
    case 'current': return 1;
    case 'speed': return 3;
    default: return 0;
  }
}

/** Static-limit level of a value: 'hihi' ≥ hiHi, 'hi' ≥ hi, else null. */
export function limitLevel(v: number | undefined, hi?: number, hiHi?: number): 'hi' | 'hihi' | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  if (hiHi !== undefined && v >= hiHi) return 'hihi';
  if (hi !== undefined && v >= hi) return 'hi';
  return null;
}

/** Severity rank for sorting (critical first). */
export function severityRank(s: string): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}
