// TypeScript mirror of contracts/README.md and server/src/TwinLabs.Core/Contracts/*.cs.
// Change all three together. contracts.test.ts guards against drift.

export type AssetKind = 'source' | 'conveyor' | 'machine' | 'buffer' | 'robot' | 'inspection' | 'sink';
export type AssetStateKind = 'off' | 'idle' | 'running' | 'starved' | 'blocked' | 'fault' | 'maintenance';
export type SensorKind = 'temperature' | 'vibration' | 'power' | 'current' | 'speed' | 'level' | 'count';
export type SimRunState = 'stopped' | 'running' | 'paused';
export type Severity = 'info' | 'warning' | 'critical';
export type EventKind = 'state' | 'alarm' | 'command' | 'info';
export type AlarmSource = 'limit' | 'anomaly' | 'fault' | 'deviation';
export type TwinMode = 'simulate' | 'shadow';
export type ConnectionKind = 'opcua' | 'mqtt';
export type ConnectionState = 'disabled' | 'connecting' | 'connected' | 'error';
export type ResourceKind = 'operator' | 'agv' | 'tool';

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
  /** v0.3: group into a production line (LineDef.id). */
  lineId?: string;
  /** v0.3: shared resource (ResourceDef.id) needed for each cycle. */
  resourceId?: string;
  /** v0.3: shift (ShiftDef.id) the asset runs in; Off outside it. */
  shiftId?: string;
  /** v0.3: glTF URL, e.g. /api/meshes/{id}/file; replaces the procedural model. */
  mesh?: string;
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

/** v0.2 */
export interface ConnectionDef { id: string; kind: ConnectionKind; endpoint: string; publishingIntervalMs?: number; clientId?: string }

/** v0.2: target = `sensor:<id>` | `asset:<id>.<state|good|scrap|wip|load|wear>`; value = raw*scale+offset. */
export interface BindingDef {
  target: string;
  connectionId: string;
  address: string;
  jsonPath?: string;
  scale?: number;
  offset?: number;
  stateMap?: Record<string, AssetStateKind>;
}

/** v0.3 */
export interface LineDef { id: string; name: string }
export interface ResourceDef { id: string; name: string; kind: ResourceKind; count: number }
export interface ShiftDef { id: string; name: string; startHour: number; endHour: number }
export interface CalendarDef { startHourOfDay: number; shifts: ShiftDef[] }

export interface PlantModel {
  id: string;
  name: string;
  version: number;
  seed: number;
  assets: AssetDef[];
  sensors: SensorDef[];
  connections?: ConnectionDef[];
  bindings?: BindingDef[];
  lines?: LineDef[];
  resources?: ResourceDef[];
  calendar?: CalendarDef;
}

export interface SimStatus { state: SimRunState; speed: number; simTimeMs: number; tick: number; seed: number; mode: TwinMode }

/** v0.2: live status of an external connection. */
export interface ConnectionStatus {
  id: string;
  kind: ConnectionKind;
  endpoint: string;
  status: ConnectionState;
  boundTags: number;
  lastValueMs?: number;
  error?: string;
}

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

/** v0.3 */
export interface LineKpiEntry { lineId: string; kpi: LineKpi }
export interface ResourceKpi { resourceId: string; count: number; utilization: number; waitSeconds: number }

export interface KpiReport {
  simTimeMs: number;
  line: LineKpi;
  assets: AssetKpi[];
  lines?: LineKpiEntry[];
  resources?: ResourceKpi[];
}

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
  connections?: ConnectionStatus[];
}

export interface TickData { sim: SimStatus; assets: AssetState[]; sensors: SensorValue[]; parts: PartPosition[] }
export interface ParamsData { assetId: string; params: Record<string, number> }
export interface AckData { commandId: string; ok: boolean; error?: string }

export type CommandAction =
  | 'sim.start' | 'sim.pause' | 'sim.stop' | 'sim.reset' | 'sim.speed'
  | 'asset.params' | 'asset.fault' | 'asset.clearFault' | 'asset.maintenance' | 'asset.enable'
  | 'alarm.ack' | 'twin.mode';

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
  | Envelope<'ack', AckData>
  | Envelope<'connection', ConnectionStatus>;

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

// ---- v0.2: scenarios ----

export interface SaveScenarioRequest { name: string; request: WhatIfRequest; result?: WhatIfResult }
export interface ScenarioSummary { id: string; name: string; createdAtUtc: string; durationS: number; overrides: number }
export interface Scenario { id: string; name: string; createdAtUtc: string; request: WhatIfRequest; result?: WhatIfResult }

// ---- v0.3: plant editing ----

export interface ValidationIssue { severity: Severity; code: string; message: string; assetId?: string }
export interface ValidationResult { ok: boolean; issues: ValidationIssue[] }
export interface TemplateInfo { id: string; name: string; description: string; assetCount: number; tags: string[] }
export interface SaveLayoutRequest { name: string; plant: PlantModel }
export interface LayoutSummary { id: string; name: string; updatedAtUtc: string; assetCount: number }
export interface Layout { id: string; name: string; updatedAtUtc: string; plant: PlantModel }
export interface MeshInfo { id: string; name: string; url: string; sizeBytes: number }
