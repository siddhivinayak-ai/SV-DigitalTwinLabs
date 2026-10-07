import type {
  AckData, Alarm, AssetDef, ConnectionStatus, AssetState, EventRecord, KpiReport, ParamsData, PartPosition,
  PlantModel, SensorDef, ServerMessage, SimStatus, SnapshotData, TickData,
} from '../net/contracts';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'mock';
export type Theme = 'light' | 'dark';

export interface StoreEvents {
  snapshot: SnapshotData;
  tick: TickData;
  kpi: KpiReport;
  event: EventRecord;
  alarm: Alarm;
  params: ParamsData;
  ack: AckData;
  selection: string | null;
  connection: ConnectionState;
  /** v0.2: an external (OPC UA / MQTT) connection changed. */
  connectionStatus: ConnectionStatus;
  theme: Theme;
}

type Listener<T> = (payload: T) => void;

/** Client-side sensor history: columnar arrays (sim seconds, value), ready for uPlot. */
export interface Series { t: number[]; v: number[] }

const HISTORY_CAP = 3000;
const EVENTS_CAP = 500;

/**
 * Single source of UI truth. Sources (live WS or mock) push ServerMessages via apply();
 * panels read fields directly and subscribe with on(). Selection is global.
 */
export class TwinStore {
  plant: PlantModel | null = null;
  sim: SimStatus = { state: 'stopped', speed: 1, simTimeMs: 0, tick: 0, seed: 0, mode: 'simulate' };
  readonly assets = new Map<string, AssetState>();
  readonly sensors = new Map<string, number>();
  parts: PartPosition[] = [];
  kpi: KpiReport | null = null;
  readonly alarms = new Map<string, Alarm>();
  /** v0.2: external connections by id. */
  readonly connections = new Map<string, ConnectionStatus>();
  events: EventRecord[] = [];
  selection: string | null = null;
  connection: ConnectionState = 'disconnected';
  theme: Theme = 'light';
  lastSeq = 0;

  private readonly history = new Map<string, Series>();
  private readonly listeners = new Map<keyof StoreEvents, Set<Listener<never>>>();

  on<K extends keyof StoreEvents>(type: K, fn: Listener<StoreEvents[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }

  private emit<K extends keyof StoreEvents>(type: K, payload: StoreEvents[K]): void {
    this.listeners.get(type)?.forEach((fn) => (fn as Listener<StoreEvents[K]>)(payload));
  }

  apply(msg: ServerMessage): void {
    this.lastSeq = msg.seq;
    switch (msg.type) {
      case 'snapshot': return this.applySnapshot(msg.data);
      case 'tick': return this.applyTick(msg.data);
      case 'kpi': this.kpi = msg.data; return this.emit('kpi', msg.data);
      case 'event':
        this.events.push(msg.data);
        if (this.events.length > EVENTS_CAP) this.events.splice(0, this.events.length - EVENTS_CAP);
        return this.emit('event', msg.data);
      case 'alarm':
        if (msg.data.active) this.alarms.set(msg.data.id, msg.data);
        else this.alarms.delete(msg.data.id);
        return this.emit('alarm', msg.data);
      case 'params': {
        const def = this.assetDef(msg.data.assetId);
        if (def) def.params = { ...def.params, ...msg.data.params };
        return this.emit('params', msg.data);
      }
      case 'ack': return this.emit('ack', msg.data);
      case 'connection':
        this.connections.set(msg.data.id, msg.data);
        return this.emit('connectionStatus', msg.data);
    }
  }

  private applySnapshot(s: SnapshotData): void {
    this.plant = s.plant;
    this.sim = s.sim;
    this.assets.clear();
    for (const a of s.assets) this.assets.set(a.id, a);
    this.sensors.clear();
    this.history.clear();
    for (const v of s.sensors) this.sensors.set(v.id, v.v);
    this.parts = s.parts;
    this.kpi = s.kpi ?? null;
    this.alarms.clear();
    for (const a of s.alarms) if (a.active) this.alarms.set(a.id, a);
    this.events = [...s.events];
    this.connections.clear();
    for (const c of s.connections ?? []) this.connections.set(c.id, c);
    if (this.selection && !this.assetDef(this.selection)) this.selection = null;
    this.emit('snapshot', s);
  }

  private applyTick(t: TickData): void {
    this.sim = t.sim;
    for (const a of t.assets) this.assets.set(a.id, a);
    const ts = t.sim.simTimeMs / 1000;
    for (const s of t.sensors) {
      this.sensors.set(s.id, s.v);
      let h = this.history.get(s.id);
      if (!h) this.history.set(s.id, (h = { t: [], v: [] }));
      if (h.t.length && ts <= h.t[h.t.length - 1]) continue; // paused: don't duplicate samples
      h.t.push(ts);
      h.v.push(s.v);
      if (h.t.length > HISTORY_CAP) { h.t.splice(0, h.t.length - HISTORY_CAP); h.v.splice(0, h.v.length - HISTORY_CAP); }
    }
    this.parts = t.parts;
    this.emit('tick', t);
  }

  getHistory(sensorId: string): Series {
    return this.history.get(sensorId) ?? { t: [], v: [] };
  }

  select(assetId: string | null): void {
    if (this.selection === assetId) return;
    this.selection = assetId;
    this.emit('selection', assetId);
  }

  setConnection(c: ConnectionState): void {
    this.connection = c;
    this.emit('connection', c);
  }

  setTheme(t: Theme): void {
    this.theme = t;
    document.documentElement.dataset.theme = t;
    this.emit('theme', t);
  }

  assetDef(id: string): AssetDef | undefined {
    return this.plant?.assets.find((a) => a.id === id);
  }

  sensorDefsFor(assetId: string): SensorDef[] {
    return this.plant?.sensors.filter((s) => s.assetId === assetId) ?? [];
  }

  sensorDef(id: string): SensorDef | undefined {
    return this.plant?.sensors.find((s) => s.id === id);
  }
}
