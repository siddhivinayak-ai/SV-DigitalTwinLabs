// v0.2 REST calls used by the Connected Twin UI. Live: the TwinLabs API (/api/...).
// Demo: the MockSource answers the same calls in memory (it implements DemoRestApi).
import type {
  Alarm, ConnectionStatus, EventRecord, SaveScenarioRequest, Scenario, ScenarioSummary, SimStatus, TwinMode,
} from '../net/contracts';
import type { TwinSource } from '../net/source';
import { Api } from '../net/api';

/** Everything the v0.2 console needs beyond the WebSocket. */
export interface ConnectedTwinApi {
  connections(): Promise<ConnectionStatus[]>;
  reconnect(id: string): Promise<ConnectionStatus>;
  /** REST alternative to the `twin.mode` command; 409 when shadow is requested without bindings. */
  setMode(mode: TwinMode): Promise<SimStatus>;
  scenarios(): Promise<ScenarioSummary[]>;
  scenario(id: string): Promise<Scenario>;
  saveScenario(req: SaveScenarioRequest): Promise<Scenario>;
  deleteScenario(id: string): Promise<void>;
  historyEvents(limit: number, beforeId?: number): Promise<EventRecord[]>;
  historyAlarms(limit: number): Promise<Alarm[]>;
}

/** Optional in-memory REST stand-in implemented by MockSource (structural; no runtime import). */
export interface DemoRestApi {
  demoConnections(): ConnectionStatus[];
  demoReconnect(id: string): ConnectionStatus;
  demoSetMode(mode: TwinMode): SimStatus;
  demoScenarios(): ScenarioSummary[];
  demoScenario(id: string): Scenario;
  demoSaveScenario(req: SaveScenarioRequest): Scenario;
  demoDeleteScenario(id: string): void;
  demoHistoryEvents(limit: number, beforeId?: number): EventRecord[];
  demoHistoryAlarms(limit: number): Alarm[];
}

export function isDemoRest(x: unknown): x is DemoRestApi {
  return !!x && typeof (x as DemoRestApi).demoScenarios === 'function' && typeof (x as DemoRestApi).demoHistoryEvents === 'function';
}

export class RestConnectedTwinApi implements ConnectedTwinApi {
  constructor(private readonly api = new Api()) {}
  connections() { return this.api.get<ConnectionStatus[]>('/connections'); }
  reconnect(id: string) { return this.api.post<ConnectionStatus>(`/connections/${encodeURIComponent(id)}/reconnect`); }
  setMode(mode: TwinMode) { return this.api.post<SimStatus>('/twin/mode', { mode }); }
  scenarios() { return this.api.get<ScenarioSummary[]>('/scenarios'); }
  scenario(id: string) { return this.api.get<Scenario>(`/scenarios/${encodeURIComponent(id)}`); }
  saveScenario(req: SaveScenarioRequest) { return this.api.post<Scenario>('/scenarios', req); }
  async deleteScenario(id: string) { await this.api.request<unknown>('DELETE', `/scenarios/${encodeURIComponent(id)}`); }
  historyEvents(limit: number, beforeId?: number) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (beforeId !== undefined) q.set('beforeId', String(beforeId));
    return this.api.get<EventRecord[]>(`/history/events?${q}`);
  }
  historyAlarms(limit: number) { return this.api.get<Alarm[]>(`/history/alarms?limit=${limit}`); }
}

/** Wraps the mock's synchronous methods in promises with a short latency, like the network. */
export class DemoConnectedTwinApi implements ConnectedTwinApi {
  constructor(private readonly mock: DemoRestApi, private readonly latencyMs = 60) {}
  private later<T>(fn: () => T): Promise<T> {
    return new Promise((resolve, reject) => setTimeout(() => { try { resolve(fn()); } catch (e) { reject(e); } }, this.latencyMs));
  }
  connections() { return this.later(() => this.mock.demoConnections()); }
  reconnect(id: string) { return this.later(() => this.mock.demoReconnect(id)); }
  setMode(mode: TwinMode) { return this.later(() => this.mock.demoSetMode(mode)); }
  scenarios() { return this.later(() => this.mock.demoScenarios()); }
  scenario(id: string) { return this.later(() => this.mock.demoScenario(id)); }
  saveScenario(req: SaveScenarioRequest) { return this.later(() => this.mock.demoSaveScenario(req)); }
  deleteScenario(id: string) { return this.later(() => this.mock.demoDeleteScenario(id)); }
  historyEvents(limit: number, beforeId?: number) { return this.later(() => this.mock.demoHistoryEvents(limit, beforeId)); }
  historyAlarms(limit: number) { return this.later(() => this.mock.demoHistoryAlarms(limit)); }
}

const cache = new WeakMap<TwinSource, ConnectedTwinApi>();

/** Live REST or the mock's in-memory stand-in, depending on `source.kind`. */
export function connectedTwinApi(source: TwinSource): ConnectedTwinApi {
  let api = cache.get(source);
  if (!api) {
    api = source.kind === 'mock' && isDemoRest(source) ? new DemoConnectedTwinApi(source) : new RestConnectedTwinApi();
    cache.set(source, api);
  }
  return api;
}
