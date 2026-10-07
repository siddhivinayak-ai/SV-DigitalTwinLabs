// v0.2 Connected Twin UI: pure helpers (unit-tested in logic.test.ts).
import type {
  Alarm, AlarmSource, ConnectionState, ConnectionStatus, EventRecord, Scenario, ScenarioSummary, Severity, SimStatus, TwinMode,
} from '../net/contracts';
import type { OverrideRow } from '../dialogs/whatIfLogic';
import { severityRank } from '../shell/format';

// ---------------------------------------------------------------- connections

/** "0.4 s ago", "3.2 s ago", "4 min 05 s ago", "2 h 07 min ago"; "—" when unknown. */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} s ago`;
  const total = Math.floor(s);
  if (total < 3600) return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s ago`;
  return `${Math.floor(total / 3600)} h ${String(Math.floor(total / 60) % 60).padStart(2, '0')} min ago`;
}

/** LED state (st-* token) and blink for a connection status. ISA-101: grey when disabled. */
export function connectionLed(status: ConnectionState): { led: string; blink: boolean } {
  switch (status) {
    case 'connected': return { led: 'running', blink: false };
    case 'connecting': return { led: 'starved', blink: true };
    case 'error': return { led: 'fault', blink: false };
    default: return { led: 'off', blink: false };
  }
}

export function connectionStatusLabel(status: ConnectionState): string {
  return status.toUpperCase();
}

export function connectionKindLabel(kind: ConnectionStatus['kind']): string {
  return kind === 'opcua' ? 'OPC UA' : kind === 'mqtt' ? 'MQTT' : String(kind).toUpperCase();
}

/**
 * Turns `lastValueMs` (a sim-time stamp, see the contract-gap note in the report) into a live,
 * wall-clock age that ticks smoothly between `connection` frames.
 *
 * When a new stamp is observed, the age at that moment is (simNow − lastValueMs) / speed, which
 * is converted into a wall-clock anchor. Between frames the age then grows at wall speed.
 */
export class ValueAgeTracker {
  private readonly anchors = new Map<string, { stamp: number; wallAt: number }>();

  observe(c: Pick<ConnectionStatus, 'id' | 'lastValueMs'>, sim: Pick<SimStatus, 'simTimeMs' | 'speed'>, wallNow: number): void {
    if (c.lastValueMs === undefined || c.lastValueMs === null) { this.anchors.delete(c.id); return; }
    const prev = this.anchors.get(c.id);
    if (prev && prev.stamp === c.lastValueMs) return;
    const simAge = Math.max(0, sim.simTimeMs - c.lastValueMs);
    const wallAge = simAge / Math.max(0.01, sim.speed || 1);
    this.anchors.set(c.id, { stamp: c.lastValueMs, wallAt: wallNow - wallAge });
  }

  /** Wall-clock age in ms, or null when the connection never delivered a value. */
  ageMs(id: string, wallNow: number): number | null {
    const a = this.anchors.get(id);
    return a ? Math.max(0, wallNow - a.wallAt) : null;
  }

  forget(id: string): void { this.anchors.delete(id); }
  clear(): void { this.anchors.clear(); }
}

/** Sort for the grid: errors first, then connecting, connected, disabled; then id (pure). */
export function sortConnections(list: Iterable<ConnectionStatus>): ConnectionStatus[] {
  const rank: Record<ConnectionState, number> = { error: 0, connecting: 1, connected: 2, disabled: 3 };
  return [...list].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.id.localeCompare(b.id));
}

export function connectionsSummary(list: Iterable<ConnectionStatus>): string {
  let n = 0, ok = 0, bad = 0, tags = 0;
  for (const c of list) { n++; tags += c.boundTags; if (c.status === 'connected') ok++; if (c.status === 'error') bad++; }
  if (!n) return 'No connections';
  return `${n} connection${n === 1 ? '' : 's'} · ${ok} connected${bad ? ` · ${bad} in error` : ''} · ${tags} bound tags`;
}

// ---------------------------------------------------------------- twin mode

export interface ModeToggleState {
  mode: TwinMode;
  simulateChecked: boolean;
  shadowChecked: boolean;
  /** Buttons disabled (offline or a switch in flight). */
  disabled: boolean;
  /** Speed combo disabled: speed is meaningless when reality drives the clock. */
  speedDisabled: boolean;
  statusText: 'SIM' | 'SHADOW';
  statusTitle: string;
}

/** Derive the [Simulate | Shadow] toggle and status segment from the store (pure). */
export function modeToggleState(sim: Pick<SimStatus, 'mode'>, online: boolean, pending: TwinMode | null = null): ModeToggleState {
  const mode: TwinMode = sim.mode === 'shadow' ? 'shadow' : 'simulate';
  const shown = pending ?? mode;
  return {
    mode,
    simulateChecked: shown === 'simulate',
    shadowChecked: shown === 'shadow',
    disabled: !online || pending !== null,
    speedDisabled: !online || mode === 'shadow',
    statusText: mode === 'shadow' ? 'SHADOW' : 'SIM',
    statusTitle: mode === 'shadow'
      ? 'Shadow mode: external tags drive the twin; the engine predicts and raises deviation alarms'
      : 'Simulate mode: the engine drives the twin',
  };
}

/** `twin.mode` command value: 0 = simulate, 1 = shadow. */
export function modeCommandValue(mode: TwinMode): 0 | 1 {
  return mode === 'shadow' ? 1 : 0;
}

// ---------------------------------------------------------------- scenarios

export interface ScenarioRow {
  id: string;
  name: string;
  created: string;
  createdMs: number;
  duration: string;
  durationS: number;
  overrides: number;
}

/** "2026-10-07 09:30" in local time; the raw string when it does not parse. */
export function formatUtcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "45 min", "8 h", "1.5 h". */
export function formatHorizon(durationS: number): string {
  if (!Number.isFinite(durationS) || durationS <= 0) return '—';
  if (durationS < 3600) return `${Math.round(durationS / 60)} min`;
  const hrs = durationS / 3600;
  return `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)} h`;
}

/** Map server summaries to grid rows, newest first (pure). */
export function scenarioRows(list: ScenarioSummary[]): ScenarioRow[] {
  return list
    .map((s) => {
      const t = Date.parse(s.createdAtUtc);
      return {
        id: s.id, name: s.name || '(unnamed)', created: formatUtcStamp(s.createdAtUtc), createdMs: Number.isNaN(t) ? 0 : t,
        duration: formatHorizon(s.durationS), durationS: s.durationS, overrides: s.overrides,
      };
    })
    .sort((a, b) => b.createdMs - a.createdMs || a.name.localeCompare(b.name));
}

/** Flatten a saved request's overrides into What-If editor rows (pure). */
export function scenarioOverrideRows(s: Pick<Scenario, 'request'>): OverrideRow[] {
  const out: OverrideRow[] = [];
  for (const o of s.request.overrides ?? []) {
    for (const [param, value] of Object.entries(o.params ?? {})) out.push({ assetId: o.assetId, param, value });
  }
  return out;
}

/** Summary row for a full scenario (used by the mock to answer GET /api/scenarios). */
export function summarize(s: Scenario): ScenarioSummary {
  return { id: s.id, name: s.name, createdAtUtc: s.createdAtUtc, durationS: s.request.durationS, overrides: scenarioOverrideRows(s).length };
}

/** Default name offered by "Save scenario…": the changed parameters, e.g. "CNC-01 cycleTimeS=18". */
export function defaultScenarioName(rows: OverrideRow[]): string {
  if (!rows.length) return 'Baseline';
  const parts = rows.slice(0, 2).map((r) => `${r.assetId} ${r.param}=${+r.value.toFixed(2)}`);
  return parts.join(', ') + (rows.length > 2 ? ` (+${rows.length - 2})` : '');
}

// ---------------------------------------------------------------- history

export type PageFetcher<T> = (limit: number, beforeId?: number) => Promise<T[]>;

/**
 * Keyset paging over `GET /api/history/events?limit=&beforeId=` (newest first).
 * loadMore() fetches the next older page below the smallest id seen so far.
 */
export class HistoryPager<T extends { id: number }> {
  rows: T[] = [];
  done = false;
  loading = false;
  private readonly seen = new Set<number>();

  constructor(private readonly fetchPage: PageFetcher<T>, readonly pageSize = 200) {}

  get oldestId(): number | undefined {
    return this.rows.length ? this.rows[this.rows.length - 1].id : undefined;
  }

  async reload(): Promise<T[]> {
    this.rows = [];
    this.seen.clear();
    this.done = false;
    return this.loadMore();
  }

  async loadMore(): Promise<T[]> {
    if (this.done || this.loading) return [];
    this.loading = true;
    try {
      const page = await this.fetchPage(this.pageSize, this.oldestId);
      const fresh = page.filter((r) => !this.seen.has(r.id));
      for (const r of fresh) this.seen.add(r.id);
      this.rows = [...this.rows, ...fresh].sort((a, b) => b.id - a.id);
      if (page.length < this.pageSize || fresh.length === 0) this.done = true;
      return fresh;
    } finally {
      this.loading = false;
    }
  }
}

/** Filter predicate for history events (pure). */
export function historyEventMatches(e: EventRecord, text: string, minSev: Severity | 'all', kind: EventRecord['kind'] | 'all'): boolean {
  if (kind !== 'all' && e.kind !== kind) return false;
  if (minSev !== 'all' && severityRank(e.severity) > severityRank(minSev)) return false;
  if (!text) return true;
  const t = text.toLowerCase();
  return e.message.toLowerCase().includes(t) || (e.assetId ?? '').toLowerCase().includes(t);
}

/** Filter predicate for history alarms and the live Alarms panel source filter (pure). */
export function alarmMatches(a: Alarm, text: string, source: AlarmSource | 'all', minSev: Severity | 'all' = 'all'): boolean {
  if (source !== 'all' && a.source !== source) return false;
  if (minSev !== 'all' && severityRank(a.severity) > severityRank(minSev)) return false;
  if (!text) return true;
  const t = text.toLowerCase();
  return a.message.toLowerCase().includes(t) || a.assetId.toLowerCase().includes(t) || (a.sensorId ?? '').toLowerCase().includes(t) || a.id.toLowerCase().includes(t);
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a header row (pure). */
export function toCsv<T>(columns: { title: string; value: (r: T) => unknown }[], rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.title)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export const EVENT_CSV_COLUMNS: { title: string; value: (e: EventRecord) => unknown }[] = [
  { title: 'id', value: (e) => e.id },
  { title: 'timeMs', value: (e) => e.timeMs },
  { title: 'kind', value: (e) => e.kind },
  { title: 'severity', value: (e) => e.severity },
  { title: 'assetId', value: (e) => e.assetId },
  { title: 'from', value: (e) => e.from },
  { title: 'to', value: (e) => e.to },
  { title: 'message', value: (e) => e.message },
];

export const ALARM_CSV_COLUMNS: { title: string; value: (a: Alarm) => unknown }[] = [
  { title: 'id', value: (a) => a.id },
  { title: 'source', value: (a) => a.source },
  { title: 'severity', value: (a) => a.severity },
  { title: 'assetId', value: (a) => a.assetId },
  { title: 'sensorId', value: (a) => a.sensorId },
  { title: 'raisedAtMs', value: (a) => a.raisedAtMs },
  { title: 'clearedAtMs', value: (a) => a.clearedAtMs },
  { title: 'active', value: (a) => a.active },
  { title: 'acknowledged', value: (a) => a.acknowledged },
  { title: 'value', value: (a) => a.value },
  { title: 'limit', value: (a) => a.limit },
  { title: 'message', value: (a) => a.message },
];

/** Label for an alarm source in grids and filters. */
export function alarmSourceLabel(s: AlarmSource): string {
  switch (s) {
    case 'limit': return 'Limit';
    case 'anomaly': return 'Anomaly';
    case 'fault': return 'Fault';
    case 'deviation': return 'Deviation';
    default: return String(s);
  }
}

export const ALARM_SOURCE_ITEMS: { value: AlarmSource | 'all'; label: string }[] = [
  { value: 'all', label: 'All sources' },
  { value: 'limit', label: 'Limit' },
  { value: 'anomaly', label: 'Anomaly' },
  { value: 'fault', label: 'Fault' },
  { value: 'deviation', label: 'Deviation (shadow)' },
];
