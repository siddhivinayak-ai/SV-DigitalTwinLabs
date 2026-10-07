import samplePlant from '../../../contracts/plant/sample_line.json';
import connectedPlant from '../../../contracts/plant/sample_line.connected.json';
import type {
  AckData, Alarm, AssetDef, AssetState, AssetStateKind, BindingDef, CommandData, ConnectionDef, ConnectionStatus, EventRecord,
  HistorySeries, KpiReport, PartPosition, PlantModel, SaveScenarioRequest, Scenario, ScenarioSummary, ServerMessage,
  SensorValue, SimStatus, StateBreakdown, TwinMode, WhatIfRequest, WhatIfResult,
} from './contracts';
import type { TwinSource } from './source';
import type { TwinStore } from '../state/store';
import { ApiError } from './api';

/**
 * In-browser stand-in for the server: a small, approximate flow model of the sample line so the
 * UI can be developed and demoed without the backend (open the app with ?source=mock).
 * It is NOT the reference simulation; the C# engine is.
 */

interface MPart { id: number; progress: number; done: boolean; scrap: boolean }
interface MAsset {
  def: AssetDef;
  state: AssetStateKind;
  since: number;
  parts: MPart[];
  cycle: number;          // current cycle length (s)
  timer: number;          // source arrival timer
  faultLeft: number;      // s remaining in fault
  maintenance: boolean;
  enabled: boolean;
  wear: number;
  good: number;
  scrap: number;
  rr: number;             // round-robin pointer
  temp: number;
  stateSec: StateBreakdown;
}

const DT = 0.1;
/** Wall frames (200 ms) the demo OPC UA connection spends in 'connecting'. */
const CONNECT_FRAMES = 8;
/** Deviation alarm debounce, in samples (one sample per 200 ms frame), as in the contract. */
const DEVIATION_SAMPLES = 10;
const HISTORY_EVENTS_CAP = 5000;
const HISTORY_ALARMS_CAP = 2000;

interface Drift { sensorId: string; factor: number; frames: number; total: number }
const zeroStates = (): StateBreakdown => ({ off: 0, idle: 0, running: 0, starved: 0, blocked: 0, fault: 0, maintenance: 0 });

export class MockSource implements TwinSource {
  readonly kind = 'mock' as const;
  private plant: PlantModel = MockSource.demoPlant();
  private assets = new Map<string, MAsset>();
  private sim: SimStatus = { state: 'running', speed: 10, simTimeMs: 0, tick: 0, seed: this.plant.seed, mode: 'simulate' };
  private seq = 0;
  private partSeq = 0;
  private eventSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kpiAcc = 0;
  private rand = mulberry32(this.plant.seed);
  private alarms = new Map<string, Alarm>();
  private events: EventRecord[] = [];
  private sinkLog: { t: number; good: number }[] = [];

  // ---- v0.2 demo: one emulated OPC UA connection, shadow mode, persistence stand-ins ----
  private conns = new Map<string, ConnectionStatus>();
  private connCountdown = new Map<string, number>();
  private frameNo = 0;
  private shadowRand = mulberry32(this.plant.seed ^ 0x5eed);
  private drift: Drift | null = null;
  private devCount = new Map<string, { hi: number; calm: number }>();
  private historyEvents: EventRecord[] = [];
  private historyAlarms = new Map<string, Alarm>();
  private scenarios = new Map<string, Scenario>();

  constructor(private readonly store: TwinStore) {
    for (const c of this.plant.connections ?? []) {
      this.conns.set(c.id, { id: c.id, kind: c.kind, endpoint: c.endpoint, status: 'disabled', boundTags: this.boundTags(c.id) });
    }
    this.reset();
    this.seedScenarios();
  }

  /** The sample line plus the connections and bindings of sample_line.connected.json. */
  private static demoPlant(): PlantModel {
    const p = structuredClone(samplePlant as unknown as PlantModel);
    const c = connectedPlant as unknown as { connections?: ConnectionDef[]; bindings?: BindingDef[] };
    p.connections = structuredClone(c.connections ?? []);
    p.bindings = structuredClone(c.bindings ?? []);
    return p;
  }

  connect(): void {
    this.store.setConnection('mock');
    for (const c of this.conns.values()) { c.status = 'connecting'; delete c.error; this.connCountdown.set(c.id, CONNECT_FRAMES); }
    this.push('snapshot', this.snapshot());
    this.timer ??= setInterval(() => this.frame(), 200);
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.setConnection('disconnected');
  }

  async command(cmd: Omit<CommandData, 'id'>): Promise<AckData> {
    const id = `m-${++this.seq}`;
    let error: string | undefined;
    const a = cmd.assetId ? this.assets.get(cmd.assetId) : undefined;
    if (cmd.assetId && !a) error = `Unknown asset '${cmd.assetId}'`;
    else switch (cmd.action) {
      case 'sim.start': this.sim.state = 'running'; break;
      case 'sim.pause': this.sim.state = 'paused'; break;
      case 'sim.stop': this.sim.state = 'stopped'; break;
      case 'sim.reset': this.reset(); this.push('snapshot', this.snapshot()); break;
      case 'sim.speed': this.sim.speed = Math.min(100, Math.max(0.25, cmd.value ?? 1)); break;
      case 'asset.fault': this.fault(a!, cmd.durationS ?? a!.def.params.mttrS ?? 300); break;
      case 'asset.clearFault': if (a!.state === 'fault') a!.faultLeft = 0; break;
      case 'asset.maintenance': a!.maintenance = (cmd.value ?? 1) > 0; break;
      case 'asset.enable': a!.enabled = (cmd.value ?? 1) > 0; break;
      case 'asset.params':
        Object.assign(a!.def.params, cmd.params ?? {});
        this.push('params', { assetId: a!.def.id, params: cmd.params ?? {} });
        this.event('command', 'info', `${a!.def.id} params changed: ${JSON.stringify(cmd.params)}`, a!.def.id);
        break;
      case 'alarm.ack': {
        const al = cmd.alarmId ? this.alarms.get(cmd.alarmId) : undefined;
        if (!al) error = `Unknown alarm '${cmd.alarmId}'`;
        else { al.acknowledged = true; this.push('alarm', { ...al }); }
        break;
      }
      case 'twin.mode': error = this.switchMode((cmd.value ?? 0) > 0 ? 'shadow' : 'simulate') ?? undefined; break;
    }
    const ack: AckData = error ? { commandId: id, ok: false, error } : { commandId: id, ok: true };
    this.push('ack', ack);
    return ack;
  }

  async whatIf(req: WhatIfRequest): Promise<WhatIfResult> {
    await new Promise((r) => setTimeout(r, 600));
    const base = this.kpi();
    const gain = req.overrides.length * 0.04;
    const scen: KpiReport = {
      ...base,
      line: {
        ...base.line,
        oee: Math.min(1, base.line.oee * (1 + gain)),
        throughputPerHour: base.line.throughputPerHour * (1 + gain * 1.3),
      },
    };
    const metrics = ['oee', 'availability', 'performance', 'quality', 'throughputPerHour'] as const;
    return {
      durationS: req.durationS,
      seed: req.seed ?? this.plant.seed,
      baseline: base,
      scenario: scen,
      deltas: metrics.map((m) => {
        const b = base.line[m], s = scen.line[m];
        return { metric: m, baseline: b, scenario: s, delta: s - b, deltaPct: b ? ((s - b) / b) * 100 : 0 };
      }),
      elapsedMs: 600,
    };
  }

  async history(sensorId: string, _seconds: number): Promise<HistorySeries> {
    const h = this.store.getHistory(sensorId);
    const unit = this.plant.sensors.find((s) => s.id === sensorId)?.unit ?? '';
    return { sensorId, unit, t: h.t.map((s) => Math.round(s * 1000)), v: [...h.v] };
  }

  exportCsvUrl(): string | null {
    return null;
  }

  // ---------------- model ----------------

  private reset(): void {
    this.assets.clear();
    this.rand = mulberry32(this.plant.seed);
    this.sim = { ...this.sim, simTimeMs: 0, tick: 0 };
    this.alarms.clear();
    this.events = [];
    this.sinkLog = [];
    for (const def of this.plant.assets) {
      this.assets.set(def.id, {
        def, state: 'idle', since: 0, parts: [], cycle: 0, timer: 0, faultLeft: 0, maintenance: false,
        enabled: true, wear: this.rand() * 0.2, good: 0, scrap: 0, rr: 0, temp: def.params.ambientC ?? 24, stateSec: zeroStates(),
      });
    }
    this.event('info', 'info', `Mock simulation reset (seed ${this.plant.seed})`);
  }

  private frame(): void {
    if (this.sim.state === 'running') {
      const steps = Math.max(1, Math.round((0.2 * this.sim.speed) / DT));
      for (let i = 0; i < steps; i++) this.step();
    }
    this.frameNo++;
    this.stepConnections();
    let sensors = this.sensorValues();
    if (this.sim.mode === 'shadow') sensors = this.shadowSensors(sensors);
    this.push('tick', { sim: { ...this.sim }, assets: this.assetStates(), sensors, parts: this.partPositions() });
    this.kpiAcc += 0.2;
    if (this.kpiAcc >= 1) { this.kpiAcc = 0; this.push('kpi', this.kpi()); }
  }

  private step(): void {
    this.sim.tick++;
    this.sim.simTimeMs = Math.round(this.sim.tick * DT * 1000);
    const list = [...this.assets.values()];
    for (let i = list.length - 1; i >= 0; i--) this.stepAsset(list[i]);
  }

  private stepAsset(a: MAsset): void {
    const p = a.def.params;
    let next: AssetStateKind;
    if (!a.enabled) next = 'off';
    else if (a.maintenance) next = 'maintenance';
    else if (a.faultLeft > 0) {
      a.faultLeft -= DT;
      next = a.faultLeft > 0 ? 'fault' : 'idle';
      if (a.faultLeft <= 0) { a.wear *= 0.2; this.event('state', 'info', `${a.def.id} repaired`, a.def.id); this.clearAlarm(`ALM-${a.def.id}-fault`); }
    } else switch (a.def.kind) {
      case 'source': {
        a.timer += DT;
        const interval = p.arrivalIntervalS ?? 20;
        if (a.timer >= interval) {
          const target = this.accepting(a);
          if (target) { a.timer = 0; target.parts.push({ id: ++this.partSeq, progress: 0, done: false, scrap: false }); next = 'running'; }
          else next = 'blocked';
        } else next = 'running';
        break;
      }
      case 'conveyor': {
        const step = ((p.speedMps ?? 0.25) * DT) / (p.lengthM ?? 5);
        const gap = 1 / (p.capacity ?? 5);
        let blocked = false;
        for (let i = 0; i < a.parts.length; i++) {
          const limit = i === 0 ? 1 : a.parts[i - 1].progress - gap;
          a.parts[i].progress = Math.min(limit, a.parts[i].progress + step);
        }
        if (a.parts.length && a.parts[0].progress >= 1) {
          const target = this.accepting(a);
          if (target) { const part = a.parts.shift()!; target.parts.push({ ...part, progress: 0, done: false }); }
          else blocked = true;
        }
        next = blocked ? 'blocked' : a.parts.length ? 'running' : 'starved';
        break;
      }
      case 'buffer': {
        if (a.parts.length) { const target = this.accepting(a); if (target) target.parts.push({ ...a.parts.shift()!, progress: 0 }); }
        a.parts.forEach((x, i) => (x.progress = (i + 0.5) / (p.capacity ?? 10)));
        next = a.parts.length ? 'running' : 'starved';
        break;
      }
      case 'sink': {
        for (const part of a.parts) { if (part.scrap) a.scrap++; else a.good++; }
        if (a.parts.length) this.sinkLog.push({ t: this.sim.simTimeMs / 1000, good: a.good });
        a.parts = [];
        next = 'running';
        break;
      }
      default: { // machine, robot, inspection
        const part = a.parts[0];
        if (!part) next = 'starved';
        else if (!part.done) {
          if (part.progress === 0) a.cycle = Math.max(0.2 * (p.cycleTimeS ?? 20), (p.cycleTimeS ?? 20) + gauss(this.rand) * (p.cycleTimeStdS ?? 0));
          part.progress = Math.min(1, part.progress + DT / a.cycle);
          a.wear += DT / (p.mtbfS ?? 3600);
          if (part.progress >= 1) {
            part.done = true;
            if (this.rand() < (p.scrapRate ?? 0)) { part.scrap = true; a.scrap++; } else a.good++;
          }
          next = 'running';
          const hazard = (DT / (p.mtbfS ?? 3600)) * (1 + 3 * a.wear * a.wear);
          if (this.rand() < hazard) { this.fault(a, -Math.log(1 - this.rand()) * (p.mttrS ?? 300)); next = 'fault'; }
        } else {
          if (part.scrap) { a.parts.shift(); next = 'starved'; }
          else {
            const target = this.accepting(a);
            if (target) { a.parts.shift(); target.parts.push({ ...part, progress: 0, done: false }); next = 'starved'; }
            else next = 'blocked';
          }
        }
      }
    }
    if (next !== a.state) { a.state = next; a.since = this.sim.simTimeMs; }
    a.stateSec[a.state] += DT;
    const running = a.state === 'running' ? 1 : 0;
    const ambient = p.ambientC ?? 24;
    a.temp += ((ambient + running * (p.tempRiseC ?? 0)) - a.temp) * (DT / 120);
  }

  private accepting(a: MAsset): MAsset | null {
    const ds = a.def.downstream;
    for (let k = 0; k < ds.length; k++) {
      const idx = (a.rr + k) % ds.length;
      const t = this.assets.get(ds[idx])!;
      if (this.accepts(t)) { a.rr = (idx + 1) % ds.length; return t; }
    }
    return null;
  }

  private accepts(t: MAsset): boolean {
    if (!t.enabled || t.maintenance || t.faultLeft > 0) return false;
    const cap = t.def.params.capacity;
    switch (t.def.kind) {
      case 'sink': return true;
      case 'buffer': return t.parts.length < (cap ?? 10);
      case 'conveyor': {
        const last = t.parts[t.parts.length - 1];
        return t.parts.length < (cap ?? 5) && (!last || last.progress >= 1 / (cap ?? 5));
      }
      default: return t.parts.length === 0;
    }
  }

  private fault(a: MAsset, durationS: number): void {
    a.faultLeft = durationS;
    a.state = 'fault';
    a.since = this.sim.simTimeMs;
    this.event('state', 'critical', `${a.def.id} FAULT (repair est. ${Math.round(durationS)} s)`, a.def.id);
    const al: Alarm = {
      id: `ALM-${a.def.id}-fault`, source: 'fault', severity: 'critical', assetId: a.def.id,
      message: `${a.def.id} in FAULT`, raisedAtMs: this.sim.simTimeMs, active: true, acknowledged: false,
    };
    this.alarms.set(al.id, al);
    this.push('alarm', al);
  }

  private clearAlarm(id: string): void {
    const al = this.alarms.get(id);
    if (!al) return;
    this.alarms.delete(id);
    this.push('alarm', { ...al, active: false, clearedAtMs: this.sim.simTimeMs });
  }

  private event(kind: EventRecord['kind'], severity: EventRecord['severity'], message: string, assetId?: string): void {
    const e: EventRecord = { id: ++this.eventSeq, timeMs: this.sim.simTimeMs, kind, severity, message, ...(assetId ? { assetId } : {}) };
    this.events.push(e);
    if (this.events.length > 200) this.events.shift();
    this.push('event', e);
  }

  // ---------------- projections ----------------

  private assetStates(): AssetState[] {
    return [...this.assets.values()].map((a) => ({
      id: a.def.id, state: a.state, stateSinceMs: a.since,
      load: a.state === 'running' ? 1 : 0, wear: +a.wear.toFixed(4), wip: a.parts.length,
      good: a.good, scrap: a.scrap,
      cycleProgress: ['machine', 'robot', 'inspection'].includes(a.def.kind) ? (a.parts[0]?.progress ?? 0) : 0,
    }));
  }

  private sensorValues(): SensorValue[] {
    return this.plant.sensors.map((s) => {
      const a = this.assets.get(s.assetId)!;
      const p = a.def.params;
      const load = a.state === 'running' ? 1 : 0;
      const noise = () => 1 + gauss(this.rand) * s.noise;
      let v = 0;
      switch (s.kind) {
        case 'temperature': v = a.temp * noise(); break;
        case 'vibration': v = (load ? (p.vibBaselineMms ?? 1) + a.wear * 6 : 0.15) * noise(); break;
        case 'power': v = ((p.idleKw ?? 0) + load * ((p.ratedKw ?? 0) - (p.idleKw ?? 0))) * noise(); break;
        case 'current': v = (((p.idleKw ?? 0) + load * ((p.ratedKw ?? 0) - (p.idleKw ?? 0))) / (Math.sqrt(3) * 0.4 * 0.9)) * noise(); break;
        case 'speed': v = a.state === 'running' ? (p.speedMps ?? 0) * noise() : 0; break;
        case 'level': v = a.parts.length; break;
        case 'count': v = s.id.endsWith('rejects') ? a.scrap : a.good; break;
      }
      return { id: s.id, v: +v.toFixed(3) };
    });
  }

  private partPositions(): PartPosition[] {
    const out: PartPosition[] = [];
    for (const a of this.assets.values()) for (const p of a.parts) out.push({ id: p.id, assetId: a.def.id, progress: +p.progress.toFixed(3) });
    return out;
  }

  private kpi(): KpiReport {
    const assets = [...this.assets.values()].filter((a) => ['machine', 'robot', 'inspection'].includes(a.def.kind)).map((a) => {
      const s = a.stateSec;
      const total = Object.values(s).reduce((x, y) => x + y, 0) || 1;
      const avail = (total - s.fault - s.maintenance) / total;
      const run = s.running + s.blocked + s.starved || 1;
      const perf = Math.min(1, ((a.def.params.cycleTimeS ?? 1) * (a.good + a.scrap)) / run);
      const qual = a.good + a.scrap ? a.good / (a.good + a.scrap) : 1;
      const states = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v / total])) as StateBreakdown;
      return { assetId: a.def.id, oee: avail * perf * qual, availability: avail, performance: perf, quality: qual, utilization: (s.running + s.fault) / total, good: a.good, scrap: a.scrap, states };
    });
    const bottleneck = [...assets].sort((x, y) => y.utilization - x.utilization)[0];
    const sink = [...this.assets.values()].find((a) => a.def.kind === 'sink')!;
    const tNow = this.sim.simTimeMs / 1000;
    const window = this.sinkLog.filter((e) => e.t >= tNow - 3600);
    const span = Math.max(60, Math.min(3600, tNow));
    const thr = window.length ? ((sink.good - (window[0].good - 1)) / span) * 3600 : 0;
    const scrap = assets.reduce((x, a) => x + a.scrap, 0);
    const quality = sink.good + scrap ? sink.good / (sink.good + scrap) : 1;
    const line = {
      oee: bottleneck ? bottleneck.availability * bottleneck.performance * quality : 0,
      availability: bottleneck?.availability ?? 1,
      performance: bottleneck?.performance ?? 0,
      quality,
      throughputPerHour: thr,
      wip: [...this.assets.values()].filter((a) => a.def.kind !== 'sink').reduce((x, a) => x + a.parts.length, 0),
      good: sink.good,
      scrap,
      ...(bottleneck ? { bottleneckAssetId: bottleneck.assetId } : {}),
    };
    return { simTimeMs: this.sim.simTimeMs, line, assets };
  }

  private snapshot() {
    return {
      plant: this.plant,
      sim: { ...this.sim },
      assets: this.assetStates(),
      sensors: this.sensorValues(),
      parts: this.partPositions(),
      kpi: this.kpi(),
      alarms: [...this.alarms.values()],
      events: [...this.events],
      connections: [...this.conns.values()].map((c) => ({ ...c })),
    };
  }

  private push<T extends ServerMessage['type']>(type: T, data: Extract<ServerMessage, { type: T }>['data']): void {
    if (type === 'event') this.recordEvent(data as EventRecord);
    else if (type === 'alarm') this.recordAlarm(data as Alarm);
    this.store.apply({ type, t: this.sim.simTimeMs, seq: ++this.seq, data } as ServerMessage);
  }

  // ---------------- v0.2 demo: connections ----------------

  private boundTags(connectionId: string): number {
    return (this.plant.bindings ?? []).filter((b) => b.connectionId === connectionId).length;
  }

  private setConn(c: ConnectionStatus, patch: Partial<ConnectionStatus>, announce = true): void {
    const before = c.status;
    Object.assign(c, patch);
    if ('error' in patch && patch.error === undefined) delete c.error;
    this.push('connection', { ...c });
    if (announce && before !== c.status) {
      const detail = c.status === 'connected' ? ` (${c.endpoint}, ${c.boundTags} tags)` : c.error ? `: ${c.error}` : '';
      this.event('info', c.status === 'error' ? 'warning' : 'info', `Connection ${c.id} ${c.status}${detail}`);
    }
  }

  /** Per 200 ms frame: finish connecting, then refresh lastValueMs once a wall second. */
  private stepConnections(): void {
    for (const c of this.conns.values()) {
      const left = this.connCountdown.get(c.id);
      if (c.status === 'connecting' && left !== undefined) {
        if (left <= 1) { this.connCountdown.delete(c.id); this.setConn(c, { status: 'connected', lastValueMs: this.sim.simTimeMs, error: undefined }); }
        else this.connCountdown.set(c.id, left - 1);
      } else if (c.status === 'connected' && this.frameNo % 5 === 0) {
        this.setConn(c, { lastValueMs: this.sim.simTimeMs }, false);
      }
    }
  }

  private shadowConnected(): boolean {
    for (const c of this.conns.values()) if (c.status === 'connected') return true;
    return false;
  }

  // ---------------- v0.2 demo: twin mode + deviation alarms ----------------

  /** Returns an error message, or null on success. */
  private switchMode(mode: TwinMode): string | null {
    if (mode === 'shadow' && !(this.plant.bindings ?? []).length) return 'Shadow mode needs at least one binding in the plant model';
    if (this.sim.mode === mode) return null;
    this.sim.mode = mode;
    this.drift = null;
    this.devCount.clear();
    for (const al of [...this.alarms.values()]) if (al.source === 'deviation') this.clearAlarm(al.id);
    this.event('command', 'info', mode === 'shadow'
      ? 'Twin mode: SHADOW (external tags drive the line; engine predicts, deviation alarms armed)'
      : 'Twin mode: SIMULATE (engine drives the line)');
    this.push('tick', { sim: { ...this.sim }, assets: this.assetStates(), sensors: this.sensorValues(), parts: this.partPositions() });
    return null;
  }

  /** Sensors with a binding that are worth perturbing (analog, non-trivial). */
  private driftCandidates(): string[] {
    const bound = new Set((this.plant.bindings ?? []).filter((b) => b.target.startsWith('sensor:')).map((b) => b.target.slice(7)));
    return this.plant.sensors
      .filter((s) => bound.has(s.id) && ['temperature', 'power', 'current'].includes(s.kind))
      .filter((s) => this.assets.get(s.assetId)?.state === 'running' || s.kind === 'temperature')
      .map((s) => s.id);
  }

  /**
   * Shadow mode: the "actual" values from the emulated PLC equal the prediction plus a little
   * measurement noise, except that now and then one bound sensor drifts away by 20–35 %, long
   * enough to trip a deviation alarm (|actual − predicted| > max(3σ, 10 %) for 10 samples).
   */
  private shadowSensors(predicted: SensorValue[]): SensorValue[] {
    if (!this.shadowConnected()) return predicted; // no live tags: fall back to the prediction
    const r = this.shadowRand;
    if (!this.drift && r() < 1 / 60) {
      const cand = this.driftCandidates();
      if (cand.length) {
        const total = 40 + Math.floor(r() * 40); // 8–16 s wall
        this.drift = { sensorId: cand[Math.floor(r() * cand.length)], factor: (r() < 0.7 ? 1 : -1) * (0.2 + r() * 0.15), frames: total, total };
      }
    }
    const d = this.drift;
    const out: SensorValue[] = [];
    for (const p of predicted) {
      const noise = this.plant.sensors.find((s) => s.id === p.id)?.noise ?? 0.01;
      let v = p.v * (1 + gauss(r) * noise * 0.3);
      if (d && d.sensorId === p.id) {
        const ramp = Math.min(1, (d.total - d.frames) / 5, d.frames / 5);
        v = p.v * (1 + d.factor * ramp);
      }
      v = +v.toFixed(3);
      this.checkDeviation(p.id, v, p.v, noise);
      out.push({ id: p.id, v });
    }
    if (d && --d.frames <= 0) this.drift = null;
    return out;
  }

  private checkDeviation(sensorId: string, actual: number, predicted: number, noise: number): void {
    const def = this.plant.sensors.find((s) => s.id === sensorId);
    if (!def) return;
    const thr = Math.max(3 * noise * Math.abs(predicted), 0.1 * Math.abs(predicted), 1e-6);
    const c = this.devCount.get(sensorId) ?? { hi: 0, calm: 0 };
    if (Math.abs(predicted) > 0.05 && Math.abs(actual - predicted) > thr) { c.hi++; c.calm = 0; } else { c.calm++; c.hi = 0; }
    this.devCount.set(sensorId, c);
    const id = `ALM-${sensorId}-deviation`;
    const active = this.alarms.get(id);
    if (!active && c.hi >= DEVIATION_SAMPLES) {
      const fmt = (v: number) => `${+v.toFixed(1)} ${def.unit}`.trim();
      const al: Alarm = {
        id, source: 'deviation', severity: 'warning', assetId: def.assetId, sensorId,
        message: `${sensorId} deviates from prediction: actual ${fmt(actual)}, predicted ${fmt(predicted)}`,
        raisedAtMs: this.sim.simTimeMs, active: true, acknowledged: false, value: +actual.toFixed(3), limit: +predicted.toFixed(3),
      };
      this.alarms.set(id, al);
      this.push('alarm', al);
      this.event('alarm', 'warning', al.message, def.assetId);
    } else if (active && c.calm >= DEVIATION_SAMPLES) {
      this.clearAlarm(id);
      this.event('alarm', 'info', `${sensorId} back in line with prediction`, def.assetId);
    }
  }

  // ---------------- v0.2 demo: persistence stand-ins (connections/api.ts DemoRestApi) ----------------

  private recordEvent(e: EventRecord): void {
    this.historyEvents.push(e);
    if (this.historyEvents.length > HISTORY_EVENTS_CAP) this.historyEvents.splice(0, this.historyEvents.length - HISTORY_EVENTS_CAP);
  }

  private recordAlarm(a: Alarm): void {
    const key = `${a.id}@${a.raisedAtMs}`;
    this.historyAlarms.delete(key); // re-insert keeps the map in last-change order
    this.historyAlarms.set(key, { ...a });
    if (this.historyAlarms.size > HISTORY_ALARMS_CAP) this.historyAlarms.delete(this.historyAlarms.keys().next().value!);
  }

  private seedScenarios(): void {
    const s: Scenario = {
      id: 'demo0001', name: 'Example: faster CNC-01 + bigger buffer',
      createdAtUtc: new Date(Date.now() - 26 * 3600_000).toISOString(),
      request: {
        durationS: 8 * 3600, seed: this.plant.seed, fromLive: true,
        overrides: [{ assetId: 'CNC-01', params: { cycleTimeS: 18 } }, { assetId: 'BUF-01', params: { capacity: 30 } }],
      },
    };
    this.scenarios.set(s.id, s);
  }

  demoConnections(): ConnectionStatus[] {
    return [...this.conns.values()].map((c) => ({ ...c }));
  }

  demoReconnect(id: string): ConnectionStatus {
    const c = this.conns.get(id);
    if (!c) throw new ApiError(`Unknown connection '${id}' (HTTP 404)`, 404);
    this.connCountdown.set(id, 5);
    this.setConn(c, { status: 'connecting', error: undefined });
    return { ...c };
  }

  demoSetMode(mode: TwinMode): SimStatus {
    const err = this.switchMode(mode);
    if (err) throw new ApiError(`${err} (HTTP 409)`, 409);
    return { ...this.sim };
  }

  demoScenarios(): ScenarioSummary[] {
    return [...this.scenarios.values()].map((s) => ({
      id: s.id, name: s.name, createdAtUtc: s.createdAtUtc, durationS: s.request.durationS,
      overrides: s.request.overrides.reduce((n, o) => n + Object.keys(o.params).length, 0),
    }));
  }

  demoScenario(id: string): Scenario {
    const s = this.scenarios.get(id);
    if (!s) throw new ApiError(`Scenario '${id}' not found (HTTP 404)`, 404);
    return structuredClone(s);
  }

  demoSaveScenario(req: SaveScenarioRequest): Scenario {
    if (!req.name?.trim()) throw new ApiError('Validation failed — name: A name is required. (HTTP 400)', 400);
    let id: string;
    do id = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'); while (this.scenarios.has(id));
    const s: Scenario = {
      id, name: req.name.trim(), createdAtUtc: new Date().toISOString(), request: structuredClone(req.request),
      ...(req.result ? { result: structuredClone(req.result) } : {}),
    };
    this.scenarios.set(id, s);
    return structuredClone(s);
  }

  demoDeleteScenario(id: string): void {
    if (!this.scenarios.delete(id)) throw new ApiError(`Scenario '${id}' not found (HTTP 404)`, 404);
  }

  /** Newest first, keyset paging below `beforeId` (like GET /api/history/events). */
  demoHistoryEvents(limit: number, beforeId?: number): EventRecord[] {
    const out: EventRecord[] = [];
    for (let i = this.historyEvents.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.historyEvents[i];
      if (beforeId === undefined || e.id < beforeId) out.push({ ...e });
    }
    return out;
  }

  /** Newest first by last change (like GET /api/history/alarms). */
  demoHistoryAlarms(limit: number): Alarm[] {
    return [...this.historyAlarms.values()].reverse().slice(0, limit).map((a) => ({ ...a }));
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = 1 - rand(), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
