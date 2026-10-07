import samplePlant from '../../../contracts/plant/sample_line.json';
import type {
  AckData, Alarm, AssetDef, AssetState, AssetStateKind, CommandData, EventRecord, HistorySeries,
  KpiReport, PartPosition, PlantModel, ServerMessage, SensorValue, SimStatus, StateBreakdown,
  WhatIfRequest, WhatIfResult,
} from './contracts';
import type { TwinSource } from './source';
import type { TwinStore } from '../state/store';

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
const zeroStates = (): StateBreakdown => ({ off: 0, idle: 0, running: 0, starved: 0, blocked: 0, fault: 0, maintenance: 0 });

export class MockSource implements TwinSource {
  readonly kind = 'mock' as const;
  private plant: PlantModel = structuredClone(samplePlant as unknown as PlantModel);
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

  constructor(private readonly store: TwinStore) {
    this.reset();
  }

  connect(): void {
    this.store.setConnection('mock');
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
    this.push('tick', { sim: { ...this.sim }, assets: this.assetStates(), sensors: this.sensorValues(), parts: this.partPositions() });
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
    };
  }

  private push<T extends ServerMessage['type']>(type: T, data: Extract<ServerMessage, { type: T }>['data']): void {
    this.store.apply({ type, t: this.sim.simTimeMs, seq: ++this.seq, data } as ServerMessage);
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
