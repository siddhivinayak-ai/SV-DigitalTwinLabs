// Plant Builder: kind catalogue, defaults, id generation and plant helpers (pure, unit-tested).
// Defaults mirror contracts/plant/sample_line.json so new assets behave like the reference line.
import type { AssetDef, AssetKind, PlantModel, SensorDef, SensorKind, Vec3 } from '../net/contracts';

export const KINDS: readonly AssetKind[] = ['source', 'conveyor', 'machine', 'buffer', 'robot', 'inspection', 'sink'];

export interface SensorTemplate { suffix: string; kind: SensorKind; unit: string; noise: number; hi?: number; hiHi?: number }

export interface KindSpec {
  kind: AssetKind;
  label: string;
  prefix: string;
  name: string;
  description: string;
  size: Vec3;
  params: Record<string, number>;
  sensors: SensorTemplate[];
}

const machineParams = { cycleTimeS: 50, cycleTimeStdS: 3, mtbfS: 21600, mttrS: 420, scrapRate: 0.02, ratedKw: 18, idleKw: 3, ambientC: 24, tempRiseC: 38, vibBaselineMms: 1.2 };

export const KIND_SPECS: Record<AssetKind, KindSpec> = {
  source: {
    kind: 'source', label: 'Source', prefix: 'SRC', name: 'Raw Stock Feeder',
    description: 'Releases raw parts every arrivalIntervalS. Blocked when downstream is full.',
    size: { x: 1.6, y: 1.4, z: 1.6 },
    params: { arrivalIntervalS: 22, arrivalStdS: 2 },
    sensors: [],
  },
  conveyor: {
    kind: 'conveyor', label: 'Conveyor', prefix: 'CONV', name: 'Conveyor',
    description: 'FIFO with capacity slots; transit time = lengthM / speedMps.',
    size: { x: 8, y: 0.9, z: 0.8 },
    params: { lengthM: 8, speedMps: 0.25, capacity: 6, ratedKw: 1.5, idleKw: 0.2 },
    sensors: [
      { suffix: 'speed', kind: 'speed', unit: 'm/s', noise: 0.005 },
      { suffix: 'level', kind: 'level', unit: 'pcs', noise: 0 },
      { suffix: 'power', kind: 'power', unit: 'kW', noise: 0.02 },
    ],
  },
  machine: {
    kind: 'machine', label: 'Machine', prefix: 'CNC', name: 'CNC Mill',
    description: 'Processes one part at a time; cycle ~ Normal(cycleTimeS, cycleTimeStdS); MTBF/MTTR failures.',
    size: { x: 3, y: 2.4, z: 2.2 },
    params: { ...machineParams },
    sensors: [
      { suffix: 'temp', kind: 'temperature', unit: '°C', noise: 0.005, hi: 70, hiHi: 80 },
      { suffix: 'vib', kind: 'vibration', unit: 'mm/s', noise: 0.04, hi: 4.5, hiHi: 7.1 },
      { suffix: 'power', kind: 'power', unit: 'kW', noise: 0.02 },
      { suffix: 'current', kind: 'current', unit: 'A', noise: 0.02, hi: 32 },
    ],
  },
  buffer: {
    kind: 'buffer', label: 'Buffer', prefix: 'BUF', name: 'WIP Buffer',
    description: 'FIFO store with capacity; no processing time.',
    size: { x: 1.8, y: 1.2, z: 1.2 },
    params: { capacity: 10 },
    sensors: [{ suffix: 'level', kind: 'level', unit: 'pcs', noise: 0, hi: 9 }],
  },
  robot: {
    kind: 'robot', label: 'Robot', prefix: 'ROB', name: 'Transfer Robot',
    description: 'A machine with a pick-and-place cycle time.',
    size: { x: 1.2, y: 2, z: 1.2 },
    params: { cycleTimeS: 16, cycleTimeStdS: 1, mtbfS: 14400, mttrS: 300, scrapRate: 0.002, ratedKw: 4, idleKw: 0.8, ambientC: 24, tempRiseC: 18, vibBaselineMms: 0.6 },
    sensors: [
      { suffix: 'temp', kind: 'temperature', unit: '°C', noise: 0.005, hi: 55, hiHi: 65 },
      { suffix: 'vib', kind: 'vibration', unit: 'mm/s', noise: 0.04, hi: 2.8, hiHi: 4.5 },
      { suffix: 'power', kind: 'power', unit: 'kW', noise: 0.02 },
      { suffix: 'current', kind: 'current', unit: 'A', noise: 0.02 },
    ],
  },
  inspection: {
    kind: 'inspection', label: 'Inspection', prefix: 'QC', name: 'Vision Inspection',
    description: 'A machine whose scrap is counted as a QC reject.',
    size: { x: 2, y: 2.2, z: 1.8 },
    params: { cycleTimeS: 12, cycleTimeStdS: 0.5, mtbfS: 28800, mttrS: 240, scrapRate: 0.03, ratedKw: 1.5, idleKw: 0.6, ambientC: 24, tempRiseC: 10, vibBaselineMms: 0.2 },
    sensors: [
      { suffix: 'temp', kind: 'temperature', unit: '°C', noise: 0.005, hi: 45, hiHi: 55 },
      { suffix: 'vib', kind: 'vibration', unit: 'mm/s', noise: 0.04, hi: 1.8, hiHi: 2.8 },
      { suffix: 'power', kind: 'power', unit: 'kW', noise: 0.02 },
      { suffix: 'rejects', kind: 'count', unit: 'pcs', noise: 0 },
    ],
  },
  sink: {
    kind: 'sink', label: 'Sink', prefix: 'SNK', name: 'Finished Goods Dock',
    description: 'Consumes good parts and counts throughput.',
    size: { x: 1.6, y: 1, z: 1.6 },
    params: {},
    sensors: [{ suffix: 'good', kind: 'count', unit: 'pcs', noise: 0 }],
  },
};

/** Known id prefixes (kind defaults plus common machine variants). */
export const KNOWN_PREFIXES = ['CNC', 'ROB', 'CONV', 'BUF', 'QC', 'PACK', 'SRC', 'SNK', 'M'] as const;

export const SENSOR_KINDS: readonly SensorKind[] = ['temperature', 'vibration', 'power', 'current', 'speed', 'level', 'count'];

export const SENSOR_UNITS: Record<SensorKind, string> = {
  temperature: '°C', vibration: 'mm/s', power: 'kW', current: 'A', speed: 'm/s', level: 'pcs', count: 'pcs',
};

/** Kinds that may hold a resource (spec §2). */
export const RESOURCE_KINDS: readonly AssetKind[] = ['machine', 'robot', 'inspection'];

/** Parameters each kind must define (MISSING_PARAM). */
export const REQUIRED_PARAMS: Record<AssetKind, string[]> = {
  source: ['arrivalIntervalS'],
  conveyor: ['lengthM', 'speedMps', 'capacity'],
  machine: ['cycleTimeS', 'mtbfS', 'mttrS'],
  buffer: ['capacity'],
  robot: ['cycleTimeS', 'mtbfS', 'mttrS'],
  inspection: ['cycleTimeS', 'mtbfS', 'mttrS'],
  sink: [],
};

export interface ParamRule { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean; integer?: boolean; hint: string }

const POS: ParamRule = { min: 0, minExclusive: true, hint: '> 0' };
const NONNEG: ParamRule = { min: 0, hint: '≥ 0' };
const RATE: ParamRule = { min: 0, max: 1, maxExclusive: true, hint: '0 ≤ x < 1' };

/** Range rule for a parameter key, mirroring TwinLabs.Simulation.ParamValidator. */
export function paramRule(key: string): ParamRule | null {
  switch (key) {
    case 'capacity': return { min: 1, integer: true, hint: 'integer ≥ 1' };
    case 'arrivalIntervalS': case 'cycleTimeS': case 'mtbfS': case 'mttrS': case 'lengthM': case 'speedMps': return POS;
    case 'arrivalStdS': case 'cycleTimeStdS': case 'ratedKw': case 'idleKw': case 'tempRiseC': case 'vibBaselineMms': return NONNEG;
    case 'scrapRate': case 'rejectRate': return RATE;
    default:
      if (key.endsWith('Rate')) return RATE;
      if (key.endsWith('S') && !key.endsWith('StdS')) return POS;
      return null;
  }
}

/** Null if the value is valid for the key, else a short reason. */
export function checkParam(key: string, v: number): string | null {
  if (!Number.isFinite(v)) return 'must be a finite number';
  const r = paramRule(key);
  if (!r) return null;
  if (r.integer && Math.floor(v) !== v) return `must be an ${r.hint}`;
  if (r.min !== undefined && (r.minExclusive ? v <= r.min : v < r.min)) return `must be ${r.hint}`;
  if (r.max !== undefined && (r.maxExclusive ? v >= r.max : v > r.max)) return `must be ${r.hint}`;
  return null;
}

export const ID_RE = /^[A-Za-z0-9._-]+$/;
export const isValidId = (id: string): boolean => ID_RE.test(id);

/** "CNC-03" → "CNC"; "ASSY-01" → "ASSY"; ids without a numeric suffix are their own prefix. */
export function prefixOf(id: string): string {
  const m = /^(.*?)-?\d+$/.exec(id);
  return m && m[1] ? m[1] : id;
}

/** Next free id for a prefix, two-digit padded: CNC-01, CNC-02 … CNC-10 (continues after the highest). */
export function nextId(existing: Iterable<string>, prefix: string): string {
  const taken = new Set(existing);
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const id of taken) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  let id = `${prefix}-${String(n).padStart(2, '0')}`;
  while (taken.has(id)) id = `${prefix}-${String(++n).padStart(2, '0')}`;
  return id;
}

export function kindPrefix(kind: string): string {
  return (KIND_SPECS as Record<string, KindSpec | undefined>)[kind]?.prefix ?? 'M';
}

/** Standard sensors for an asset of a kind: ids `<ASSET>.<suffix>`. */
export function defaultSensors(assetId: string, kind: AssetKind): SensorDef[] {
  return KIND_SPECS[kind].sensors.map((t) => sensorFromTemplate(assetId, t));
}

export function sensorFromTemplate(assetId: string, t: SensorTemplate): SensorDef {
  const s: SensorDef = { id: `${assetId}.${t.suffix}`, assetId, kind: t.kind, unit: t.unit, noise: t.noise };
  if (t.hi !== undefined) s.hi = t.hi;
  if (t.hiHi !== undefined) s.hiHi = t.hiHi;
  return s;
}

/** Sensor id suffix: "CNC-01.temp" → "temp". */
export function sensorSuffix(s: Pick<SensorDef, 'id' | 'assetId'>): string {
  return s.id.startsWith(s.assetId + '.') ? s.id.slice(s.assetId.length + 1) : s.id;
}

/** A new asset of `kind` with defaults and a fresh id. Ids in `taken` are avoided. */
export function createAsset(kind: AssetKind, x: number, z: number, taken: Iterable<string>): { asset: AssetDef; sensors: SensorDef[] } {
  const spec = KIND_SPECS[kind];
  const id = nextId(taken, spec.prefix);
  const n = Number(/\d+$/.exec(id)?.[0] ?? 1);
  const asset: AssetDef = {
    id,
    name: `${spec.name} #${n}`,
    kind,
    position: { x, y: 0, z },
    rotationY: 0,
    size: { ...spec.size },
    downstream: [],
    params: { ...spec.params },
  };
  return { asset, sensors: defaultSensors(id, kind) };
}

/** "New" document: a connected source and sink. */
export function newPlant(): PlantModel {
  const src = createAsset('source', 0, 0, []);
  const snk = createAsset('sink', 6, 0, []);
  src.asset.name = 'Feeder';
  snk.asset.name = 'Dock';
  src.asset.downstream = [snk.asset.id];
  return {
    id: 'new-plant', name: 'New Plant', version: 1, seed: 1,
    assets: [src.asset, snk.asset],
    sensors: [...src.sensors, ...snk.sensors],
  };
}

export function clonePlant<T>(p: T): T {
  return JSON.parse(JSON.stringify(p)) as T;
}

/** Fill missing required fields so imported JSON is safe to edit. Throws on non-plant input. */
export function normalizePlant(input: unknown): PlantModel {
  if (!input || typeof input !== 'object') throw new Error('Not a JSON object');
  const o = input as Partial<PlantModel>;
  if (!Array.isArray(o.assets)) throw new Error('Missing "assets" array — not a PlantModel');
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const vec = (v: unknown, d: Vec3): Vec3 => {
    const q = (v ?? {}) as Partial<Vec3>;
    return { x: num(q.x, d.x), y: num(q.y, d.y), z: num(q.z, d.z) };
  };
  const p: PlantModel = {
    ...(o as PlantModel),
    id: typeof o.id === 'string' && o.id ? o.id : 'plant',
    name: typeof o.name === 'string' ? o.name : 'Plant',
    version: num(o.version, 1),
    seed: num(o.seed, 1),
    assets: o.assets.map((a) => {
      const kind = (KINDS as string[]).includes(a?.kind) ? a.kind : 'machine';
      const spec = KIND_SPECS[kind];
      return {
        ...a,
        id: String(a?.id ?? ''),
        name: typeof a?.name === 'string' ? a.name : String(a?.id ?? ''),
        kind,
        position: vec(a?.position, { x: 0, y: 0, z: 0 }),
        rotationY: num(a?.rotationY, 0),
        size: vec(a?.size, spec.size),
        downstream: Array.isArray(a?.downstream) ? a.downstream.map(String) : [],
        params: a?.params && typeof a.params === 'object' ? { ...a.params } : {},
      };
    }),
    sensors: Array.isArray(o.sensors) ? o.sensors.map((s) => ({ ...s })) : [],
  };
  return clonePlant(p);
}

/** Display string for a kind. */
export const kindLabel = (k: AssetKind): string => KIND_SPECS[k]?.label ?? k;
