// TypeScript mirror of contracts/README.md and server/src/TwinLabs.Core/Contracts/*.cs.
// Change all three together. contracts.test.ts guards against drift.

export type AssetKind = 'source' | 'conveyor' | 'machine' | 'buffer' | 'robot' | 'inspection' | 'sink';
export type AssetStateKind = 'off' | 'idle' | 'running' | 'starved' | 'blocked' | 'fault' | 'maintenance';
export type SensorKind = 'temperature' | 'vibration' | 'power' | 'current' | 'speed' | 'level' | 'count';
export type SimRunState = 'stopped' | 'running' | 'paused';
export type Severity = 'info' | 'warning' | 'critical';
export type EventKind = 'state' | 'alarm' | 'command' | 'info';
export type AlarmSource = 'limit' | 'anomaly' | 'fault';

export const ASSET_STATES: readonly AssetStateKind[] = ['off', 'idle', 'running', 'starved', 'blocked', 'fault', 'maintenance'];

export interface Vec3 { x: number; y: number; z: number }

export interface AssetDef {
  id: string;
  name: string;
  kind: AssetKind;
  position: Vec3;
  rotationY: number;
  size: Vec3;
  downstream: string[];
  params: Record<string, number>;
}

export interface SensorDef {
  id: string;
  assetId: string;
  kind: SensorKind;
  unit: string;
  noise: number;
  hi?: number;
  hiHi?: number;
}

export interface PlantModel {
  id: string;
  name: string;
  version: number;
  seed: number;
  assets: AssetDef[];
  sensors: SensorDef[];
}

export interface SimStatus { state: SimRunState; speed: number; simTimeMs: number; tick: number; seed: number }

export interface AssetState {
  id: string;
  state: AssetStateKind;
  stateSinceMs: number;
  load: number;
  wear: number;
  wip: number;
  good: number;
  scrap: number;
  cycleProgress: number;
}

export interface SensorValue { id: string; v: number }
export interface PartPosition { id: number; assetId: string; progress: number }

export type StateBreakdown = Record<AssetStateKind, number>;

export interface EventRecord {
  id: number;
  timeMs: number;
  kind: EventKind;
  severity: Severity;
  message: string;
  assetId?: string;
  from?: AssetStateKind;
  to?: AssetStateKind;
}

export interface Alarm {
  id: string;
  source: AlarmSource;
  severity: Severity;
  assetId: string;
  message: string;
  raisedAtMs: number;
  active: boolean;
  acknowledged: boolean;
  sensorId?: string;
  value?: number;
  limit?: number;
  clearedAtMs?: number;
}

export interface AssetKpi {
  assetId: string;
  oee: number;
  availability: number;
  performance: number;
  quality: number;
  utilization: number;
  good: number;
  scrap: number;
  states: StateBreakdown;
}

export interface LineKpi {
  oee: number;
  availability: number;
  performance: number;
  quality: number;
  throughputPerHour: number;
  wip: number;
  good: number;
  scrap: number;
  bottleneckAssetId?: string;
}

export interface KpiReport { simTimeMs: number; line: LineKpi; assets: AssetKpi[] }

export interface HistorySeries { sensorId: string; unit: string; t: number[]; v: number[] }

// ---- Messages ----

export interface SnapshotData {
  plant: PlantModel;
  sim: SimStatus;
  assets: AssetState[];
  sensors: SensorValue[];
  parts: PartPosition[];
  kpi?: KpiReport;
  alarms: Alarm[];
  events: EventRecord[];
}

export interface TickData { sim: SimStatus; assets: AssetState[]; sensors: SensorValue[]; parts: PartPosition[] }
export interface ParamsData { assetId: string; params: Record<string, number> }
export interface AckData { commandId: string; ok: boolean; error?: string }

export type CommandAction =
  | 'sim.start' | 'sim.pause' | 'sim.stop' | 'sim.reset' | 'sim.speed'
  | 'asset.params' | 'asset.fault' | 'asset.clearFault' | 'asset.maintenance' | 'asset.enable'
  | 'alarm.ack';

export interface CommandData {
  id: string;
  action: CommandAction;
  assetId?: string;
  value?: number;
  params?: Record<string, number>;
  alarmId?: string;
  durationS?: number;
}

export interface Envelope<TType extends string, TData> { type: TType; t: number; seq: number; data: TData }

export type ServerMessage =
  | Envelope<'snapshot', SnapshotData>
  | Envelope<'tick', TickData>
  | Envelope<'event', EventRecord>
  | Envelope<'alarm', Alarm>
  | Envelope<'kpi', KpiReport>
  | Envelope<'params', ParamsData>
  | Envelope<'ack', AckData>;

export type ClientMessage = Envelope<'command', CommandData>;

// ---- What-if ----

export interface WhatIfOverride { assetId: string; params: Record<string, number> }
export interface WhatIfRequest { durationS: number; overrides: WhatIfOverride[]; seed?: number; fromLive?: boolean }
export interface KpiDelta { metric: string; baseline: number; scenario: number; delta: number; deltaPct: number }
export interface WhatIfResult {
  durationS: number;
  seed: number;
  baseline: KpiReport;
  scenario: KpiReport;
  deltas: KpiDelta[];
  elapsedMs: number;
}
