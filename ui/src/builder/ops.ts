// Plant Builder: document operations. Each one mutates a PlantModel in place and returns an error
// string when it refuses (nothing changed). BuilderDoc wraps them in undoable commands.
import type {
  AssetDef, AssetKind, LineDef, PlantModel, ResourceDef, ResourceKind, SensorDef, SensorKind, ShiftDef, Vec3,
} from '../net/contracts';
import { createAsset, isValidId, kindPrefix, nextId, prefixOf, sensorSuffix } from './model';
import { normDeg, rotateVec, round3, snap } from './geometry';

export type OpResult = string | void;

const find = (p: PlantModel, id: string) => p.assets.find((a) => a.id === id);
const allIds = (p: PlantModel) => p.assets.map((a) => a.id);

// ---------------- assets ----------------

/** Add a new asset of `kind` centred at (x, z); returns its id. */
export function addAsset(p: PlantModel, kind: AssetKind, x: number, z: number): string {
  const { asset, sensors } = createAsset(kind, x, z, allIds(p));
  p.assets.push(asset);
  p.sensors.push(...sensors);
  return asset.id;
}

export function moveAssets(p: PlantModel, ids: string[], dx: number, dz: number): OpResult {
  if (!ids.length) return 'Nothing selected';
  for (const id of ids) {
    const a = find(p, id);
    if (!a) continue;
    a.position = { ...a.position, x: round3(a.position.x + dx), z: round3(a.position.z + dz) };
  }
}

export function setPosition(p: PlantModel, id: string, x: number, z: number): OpResult {
  const a = find(p, id);
  if (!a) return `Unknown asset ${id}`;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 'Position must be a number';
  a.position = { ...a.position, x: round3(x), z: round3(z) };
}

/**
 * Rotate by `deg` (multiples of 90 in the UI). One asset rotates in place; several rotate as a
 * group about their common centre (snapped to `pivotSnap`), like a CAD rotate.
 */
export function rotateAssets(p: PlantModel, ids: string[], deg: number, pivotSnap = 0.5): OpResult {
  const list = ids.map((id) => find(p, id)).filter((a): a is AssetDef => !!a);
  if (!list.length) return 'Nothing selected';
  let cx = 0, cz = 0;
  if (list.length > 1) {
    cx = snap(list.reduce((s, a) => s + a.position.x, 0) / list.length, pivotSnap);
    cz = snap(list.reduce((s, a) => s + a.position.z, 0) / list.length, pivotSnap);
  }
  for (const a of list) {
    a.rotationY = normDeg((a.rotationY || 0) + deg);
    if (list.length > 1) {
      const r = rotateVec(a.position.x - cx, a.position.z - cz, deg);
      a.position = { ...a.position, x: round3(cx + r.x), z: round3(cz + r.z) };
    }
  }
}

export function setRotation(p: PlantModel, id: string, deg: number): OpResult {
  const a = find(p, id);
  if (!a) return `Unknown asset ${id}`;
  if (!Number.isFinite(deg)) return 'Rotation must be a number';
  a.rotationY = normDeg(deg);
}

/** Resize (metres). Conveyors keep `lengthM` in step with their footprint length. */
export function resizeAsset(p: PlantModel, id: string, size: Partial<Vec3>, position?: { x: number; z: number }): OpResult {
  const a = find(p, id);
  if (!a) return `Unknown asset ${id}`;
  const next = { ...a.size, ...size };
  for (const v of [next.x, next.y, next.z]) if (!(v > 0) || !Number.isFinite(v)) return 'Size must be > 0';
  a.size = { x: round3(next.x), y: round3(next.y), z: round3(next.z) };
  if (position) a.position = { ...a.position, x: round3(position.x), z: round3(position.z) };
  if (a.kind === 'conveyor' && size.x !== undefined) a.params = { ...a.params, lengthM: a.size.x };
}

/** Delete assets, their sensors, every downstream reference to them and bindings that target them. */
export function deleteAssets(p: PlantModel, ids: string[]): OpResult {
  const gone = new Set(ids.filter((id) => find(p, id)));
  if (!gone.size) return 'Nothing to delete';
  p.assets = p.assets.filter((a) => !gone.has(a.id));
  for (const a of p.assets) if (a.downstream.some((d) => gone.has(d))) a.downstream = a.downstream.filter((d) => !gone.has(d));
  const goneSensors = new Set(p.sensors.filter((s) => gone.has(s.assetId)).map((s) => s.id));
  p.sensors = p.sensors.filter((s) => !gone.has(s.assetId));
  if (p.bindings) {
    p.bindings = p.bindings.filter((b) => {
      const t = bindingTarget(b.target);
      return !(t && ((t.type === 'asset' && gone.has(t.id)) || (t.type === 'sensor' && goneSensors.has(t.id))));
    });
  }
}

export function canConnect(p: PlantModel, from: string, to: string): string | null {
  const a = find(p, from), b = find(p, to);
  if (!a || !b) return 'Unknown asset';
  if (from === to) return 'An asset cannot feed itself';
  if (a.kind === 'sink') return `${from} is a sink and cannot have downstream`;
  if (b.kind === 'source') return `${to} is a source and cannot have upstream`;
  if (a.downstream.includes(to)) return `${from} already feeds ${to}`;
  return null;
}

export function connect(p: PlantModel, from: string, to: string): OpResult {
  const why = canConnect(p, from, to);
  if (why) return why;
  const a = find(p, from)!;
  a.downstream = [...a.downstream, to];
}

export function disconnect(p: PlantModel, from: string, to: string): OpResult {
  const a = find(p, from);
  if (!a || !a.downstream.includes(to)) return `${from} does not feed ${to}`;
  a.downstream = a.downstream.filter((d) => d !== to);
}

/** Remove every flow into and out of the given assets. */
export function disconnectAll(p: PlantModel, ids: string[]): OpResult {
  const set = new Set(ids);
  let n = 0;
  for (const a of p.assets) {
    if (set.has(a.id) && a.downstream.length) { n += a.downstream.length; a.downstream = []; continue; }
    const keep = a.downstream.filter((d) => !set.has(d));
    if (keep.length !== a.downstream.length) { n += a.downstream.length - keep.length; a.downstream = keep; }
  }
  if (!n) return 'No connections to remove';
}

function bindingTarget(t: string): { type: 'sensor' | 'asset'; id: string; rest: string } | null {
  if (t.startsWith('sensor:')) return { type: 'sensor', id: t.slice(7), rest: '' };
  if (t.startsWith('asset:')) {
    const body = t.slice(6);
    const i = body.lastIndexOf('.');
    return i > 0 ? { type: 'asset', id: body.slice(0, i), rest: body.slice(i) } : { type: 'asset', id: body, rest: '' };
  }
  return null;
}

/** Rename an asset and every reference: downstream lists, sensors (assetId and `<ID>.` prefix), bindings. */
export function renameAsset(p: PlantModel, oldId: string, newId: string): OpResult {
  newId = newId.trim();
  const a = find(p, oldId);
  if (!a) return `Unknown asset ${oldId}`;
  if (newId === oldId) return 'Id unchanged';
  if (!isValidId(newId)) return 'Ids may only contain A-Z a-z 0-9 . _ -';
  if (find(p, newId)) return `An asset with id ${newId} already exists`;
  a.id = newId;
  for (const o of p.assets) if (o.downstream.includes(oldId)) o.downstream = o.downstream.map((d) => (d === oldId ? newId : d));
  const sensorMap = new Map<string, string>();
  for (const s of p.sensors) {
    if (s.assetId !== oldId) continue;
    const nid = s.id.startsWith(oldId + '.') ? newId + s.id.slice(oldId.length) : s.id;
    if (nid !== s.id) sensorMap.set(s.id, nid);
    s.assetId = newId;
    s.id = nid;
  }
  for (const b of p.bindings ?? []) {
    const t = bindingTarget(b.target);
    if (!t) continue;
    if (t.type === 'asset' && t.id === oldId) b.target = `asset:${newId}${t.rest}`;
    if (t.type === 'sensor' && sensorMap.has(t.id)) b.target = `sensor:${sensorMap.get(t.id)}`;
  }
}

export type AssetPatch = Partial<Pick<AssetDef, 'name' | 'lineId' | 'resourceId' | 'shiftId' | 'mesh'>>;

/** Set simple fields; empty string or undefined removes optional ones. */
export function patchAsset(p: PlantModel, id: string, patch: AssetPatch): OpResult {
  const a = find(p, id);
  if (!a) return `Unknown asset ${id}`;
  for (const [k, v] of Object.entries(patch) as [keyof AssetPatch, string | undefined][]) {
    if (k === 'name') { a.name = v ?? ''; continue; }
    if (v === undefined || v === '') delete a[k];
    else a[k] = v;
  }
}

/** Set (or with `undefined`, remove) one parameter. */
export function setParam(p: PlantModel, id: string, key: string, value: number | undefined): OpResult {
  const a = find(p, id);
  if (!a) return `Unknown asset ${id}`;
  if (!key) return 'Empty parameter name';
  const params = { ...a.params };
  if (value === undefined) delete params[key];
  else {
    if (!Number.isFinite(value)) return 'Must be a finite number';
    params[key] = value;
  }
  a.params = params;
}

// ---------------- clipboard ----------------

export interface Clip { assets: AssetDef[]; sensors: SensorDef[] }

export function copyAssets(p: PlantModel, ids: string[]): Clip | null {
  const set = new Set(ids);
  const assets = p.assets.filter((a) => set.has(a.id));
  if (!assets.length) return null;
  return JSON.parse(JSON.stringify({ assets, sensors: p.sensors.filter((s) => set.has(s.assetId)) })) as Clip;
}

/**
 * Paste copies offset by (dx, dz). Each copy gets a new id with its original prefix (CNC-01 → CNC-03);
 * flows between copied assets are kept, flows to outside assets are dropped. Returns the new ids.
 */
export function pasteAssets(p: PlantModel, clip: Clip, dx: number, dz: number): string[] {
  const taken = new Set(allIds(p));
  const map = new Map<string, string>();
  for (const a of clip.assets) {
    const id = nextId(taken, prefixOf(a.id) || kindPrefix(a.kind));
    taken.add(id);
    map.set(a.id, id);
  }
  for (const src of clip.assets) {
    const a: AssetDef = JSON.parse(JSON.stringify(src)) as AssetDef;
    a.id = map.get(src.id)!;
    a.position = { ...a.position, x: round3(a.position.x + dx), z: round3(a.position.z + dz) };
    a.downstream = src.downstream.filter((d) => map.has(d)).map((d) => map.get(d)!);
    p.assets.push(a);
  }
  const sTaken = new Set(p.sensors.map((s) => s.id));
  for (const s of clip.sensors) {
    const nid = map.get(s.assetId);
    if (!nid) continue;
    let id = `${nid}.${sensorSuffix(s)}`;
    for (let k = 2; sTaken.has(id); k++) id = `${nid}.${sensorSuffix(s)}${k}`;
    sTaken.add(id);
    p.sensors.push({ ...s, id, assetId: nid });
  }
  return [...map.values()];
}

// ---------------- sensors ----------------

export function addSensor(p: PlantModel, assetId: string, kind: SensorKind, unit: string, suffix?: string): string | { error: string } {
  if (!find(p, assetId)) return { error: `Unknown asset ${assetId}` };
  const base = suffix?.trim() || ({ temperature: 'temp', vibration: 'vib' } as Record<string, string>)[kind] || kind;
  const ids = new Set(p.sensors.map((s) => s.id));
  let id = `${assetId}.${base}`;
  for (let k = 2; ids.has(id); k++) id = `${assetId}.${base}${k}`;
  if (!isValidId(id)) return { error: 'Sensor ids may only contain A-Z a-z 0-9 . _ -' };
  p.sensors.push({ id, assetId, kind, unit, noise: 0.01 });
  return id;
}

export type SensorPatch = Partial<Pick<SensorDef, 'kind' | 'unit' | 'noise' | 'hi' | 'hiHi'>> & { suffix?: string };

/** Edit a sensor. `suffix` renames it to `<ASSET>.<suffix>`; hi/hiHi = undefined clears the limit. */
export function patchSensor(p: PlantModel, sensorId: string, patch: SensorPatch): OpResult {
  const s = p.sensors.find((x) => x.id === sensorId);
  if (!s) return `Unknown sensor ${sensorId}`;
  if ('suffix' in patch && patch.suffix !== undefined) {
    const suf = patch.suffix.trim();
    const id = `${s.assetId}.${suf}`;
    if (!suf || !isValidId(id)) return 'Suffix may only contain A-Z a-z 0-9 . _ -';
    if (id !== s.id && p.sensors.some((x) => x.id === id)) return `Sensor ${id} already exists`;
    for (const b of p.bindings ?? []) if (b.target === `sensor:${s.id}`) b.target = `sensor:${id}`;
    s.id = id;
  }
  if (patch.kind !== undefined) s.kind = patch.kind;
  if (patch.unit !== undefined) s.unit = patch.unit;
  if ('noise' in patch) {
    if (!(patch.noise! >= 0)) return 'Noise must be ≥ 0';
    s.noise = patch.noise!;
  }
  for (const k of ['hi', 'hiHi'] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === undefined) delete s[k];
    else if (!Number.isFinite(v)) return 'Limit must be a number';
    else s[k] = v;
  }
}

export function removeSensor(p: PlantModel, sensorId: string): OpResult {
  const n = p.sensors.length;
  p.sensors = p.sensors.filter((s) => s.id !== sensorId);
  if (p.sensors.length === n) return `Unknown sensor ${sensorId}`;
  if (p.bindings) p.bindings = p.bindings.filter((b) => b.target !== `sensor:${sensorId}`);
}

// ---------------- plant, lines, resources, shifts ----------------

export function patchPlant(p: PlantModel, patch: Partial<Pick<PlantModel, 'id' | 'name' | 'seed'>>): OpResult {
  if (patch.id !== undefined) {
    if (!isValidId(patch.id)) return 'Ids may only contain A-Z a-z 0-9 . _ -';
    p.id = patch.id;
  }
  if (patch.name !== undefined) p.name = patch.name;
  if (patch.seed !== undefined) {
    if (!Number.isInteger(patch.seed)) return 'Seed must be an integer';
    p.seed = patch.seed;
  }
}

function freshId(taken: string[], base: string): string {
  for (let i = 1; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

function renameRef(p: PlantModel, field: 'lineId' | 'resourceId' | 'shiftId', from: string, to: string | undefined): void {
  for (const a of p.assets) {
    if (a[field] !== from) continue;
    if (to === undefined) delete a[field]; else a[field] = to;
  }
}

/** Shared add/patch/remove for id'd collections whose ids are referenced by assets. */
function collection<T extends { id: string }>(field: 'lineId' | 'resourceId' | 'shiftId', get: (p: PlantModel) => T[], set: (p: PlantModel, list: T[] | undefined) => void) {
  return {
    patch(p: PlantModel, id: string, patch: Partial<T>): OpResult {
      const list = get(p);
      const it = list.find((x) => x.id === id);
      if (!it) return `Unknown id ${id}`;
      if (patch.id !== undefined && patch.id !== id) {
        if (!isValidId(patch.id)) return 'Ids may only contain A-Z a-z 0-9 . _ -';
        if (list.some((x) => x.id === patch.id)) return `${patch.id} already exists`;
        renameRef(p, field, id, patch.id);
      }
      Object.assign(it, patch);
    },
    remove(p: PlantModel, id: string): OpResult {
      const list = get(p);
      if (!list.some((x) => x.id === id)) return `Unknown id ${id}`;
      const next = list.filter((x) => x.id !== id);
      set(p, next.length ? next : undefined);
      renameRef(p, field, id, undefined);
    },
    add(p: PlantModel, make: (id: string) => T, base: string): string {
      const list = get(p);
      const id = freshId(list.map((x) => x.id), base);
      set(p, [...list, make(id)]);
      return id;
    },
  };
}

const lines = collection<LineDef>('lineId', (p) => p.lines ?? [], (p, l) => { if (l) p.lines = l; else delete p.lines; });
const resources = collection<ResourceDef>('resourceId', (p) => p.resources ?? [], (p, l) => { if (l) p.resources = l; else delete p.resources; });
const shifts = collection<ShiftDef>('shiftId', (p) => p.calendar?.shifts ?? [], (p, l) => {
  if (l) p.calendar = { startHourOfDay: p.calendar?.startHourOfDay ?? 6, shifts: l };
  else if (p.calendar) p.calendar = { ...p.calendar, shifts: [] };
});

export const addLine = (p: PlantModel): string => {
  const n = (p.lines?.length ?? 0) + 1;
  return lines.add(p, (id) => ({ id, name: `Line ${String.fromCharCode(64 + Math.min(26, n))}` }), 'line');
};
export const patchLine = (p: PlantModel, id: string, patch: Partial<LineDef>): OpResult => lines.patch(p, id, patch);
export const removeLine = (p: PlantModel, id: string): OpResult => lines.remove(p, id);

export const addResource = (p: PlantModel, kind: ResourceKind = 'operator'): string =>
  resources.add(p, (id) => ({ id, name: kind === 'operator' ? 'Operators' : kind === 'agv' ? 'AGV fleet' : 'Tooling', kind, count: 1 }), kind === 'operator' ? 'op' : kind);
export function patchResource(p: PlantModel, id: string, patch: Partial<ResourceDef>): OpResult {
  if (patch.count !== undefined && !(Number.isInteger(patch.count) && patch.count >= 1)) return 'Count must be an integer ≥ 1';
  return resources.patch(p, id, patch);
}
export const removeResource = (p: PlantModel, id: string): OpResult => resources.remove(p, id);

export const addShift = (p: PlantModel): string =>
  shifts.add(p, (id) => ({ id, name: 'Day shift', startHour: 6, endHour: 14 }), 'shift');
export function patchShift(p: PlantModel, id: string, patch: Partial<ShiftDef>): OpResult {
  for (const k of ['startHour', 'endHour'] as const) {
    const v = patch[k];
    if (v !== undefined && !(v >= 0 && v <= 24)) return 'Hours must be within 0..24';
  }
  return shifts.patch(p, id, patch);
}
export const removeShift = (p: PlantModel, id: string): OpResult => shifts.remove(p, id);

export function setCalendarStart(p: PlantModel, hour: number): OpResult {
  if (!(hour >= 0 && hour < 24)) return 'Start hour must be within 0..24';
  p.calendar = { startHourOfDay: hour, shifts: p.calendar?.shifts ?? [] };
}
