// v0.3 viewport cues as pure logic (no three.js): mesh fit math, line zones, shift dimming and
// resource waiting. Kept DOM-free so it is unit-tested in node.
import type { AssetDef, AssetStateKind, CalendarDef, PlantModel, ResourceKind, ShiftDef, Vec3 } from '../net/contracts';

// ------------------------------------------------------------------ mesh fit

export interface MeshFit {
  /** Uniform scale applied to the loaded scene. */
  scale: number;
  /** Translation applied after scaling (asset-local metres). */
  offset: Vec3;
  /** Size of the fitted mesh (≤ the asset size box on every axis). */
  fitted: Vec3;
}

/**
 * Fit a mesh with local bounds [min, max] into an asset `size` box: scale uniformly so it fits inside,
 * centre it on x/z and sit it on y = 0. Degenerate (flat) axes are ignored when choosing the scale;
 * an empty or invalid box yields the identity fit.
 */
export function fitMeshToBox(min: Vec3, max: Vec3, size: Vec3): MeshFit {
  const ext = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  const valid = [min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite) && ext.x >= 0 && ext.y >= 0 && ext.z >= 0;
  if (!valid) return { scale: 1, offset: { x: 0, y: 0, z: 0 }, fitted: { x: 0, y: 0, z: 0 } };
  const EPS = 1e-9;
  const ratios: number[] = [];
  for (const k of ['x', 'y', 'z'] as const) if (ext[k] > EPS && size[k] > 0) ratios.push(size[k] / ext[k]);
  const scale = ratios.length ? Math.min(...ratios) : 1;
  const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
  return {
    scale,
    offset: { x: -cx * scale, y: -min.y * scale, z: -cz * scale },
    fitted: { x: ext.x * scale, y: ext.y * scale, z: ext.z * scale },
  };
}

// ------------------------------------------------------------------ line zones

export interface LineZone { lineId: string; name: string; index: number; x0: number; x1: number; z0: number; z1: number; assets: number }

/** World-space footprint AABB of an asset (its size box rotated by rotationY). */
export function footprintAabb(a: AssetDef): { x0: number; x1: number; z0: number; z1: number } {
  const r = ((a.rotationY || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const hx = (c * a.size.x + s * a.size.z) / 2, hz = (s * a.size.x + c * a.size.z) / 2;
  return { x0: a.position.x - hx, x1: a.position.x + hx, z0: a.position.z - hz, z1: a.position.z + hz };
}

/** One floor rectangle per line that has assets: the union of their footprints plus a margin. Line order is kept. */
export function lineZones(plant: Pick<PlantModel, 'assets' | 'lines'>, margin = 0.6): LineZone[] {
  const out: LineZone[] = [];
  (plant.lines ?? []).forEach((line, index) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, n = 0;
    for (const a of plant.assets) {
      if (a.lineId !== line.id) continue;
      const f = footprintAabb(a);
      x0 = Math.min(x0, f.x0); x1 = Math.max(x1, f.x1); z0 = Math.min(z0, f.z0); z1 = Math.max(z1, f.z1);
      n++;
    }
    if (!n) return;
    out.push({ lineId: line.id, name: line.name || line.id, index, x0: x0 - margin, x1: x1 + margin, z0: z0 - margin, z1: z1 + margin, assets: n });
  });
  return out;
}

// ------------------------------------------------------------------ shifts

/** Hour of day (0 ≤ h < 24) at a sim time; sim t = 0 is `startHourOfDay` of day 1. */
export function hourOfDay(calendar: Pick<CalendarDef, 'startHourOfDay'> | undefined, simTimeMs: number): number {
  const h = ((calendar?.startHourOfDay ?? 0) + simTimeMs / 3_600_000) % 24;
  return h < 0 ? h + 24 : h;
}

/** Whether an hour lies in a shift window; `endHour < startHour` wraps midnight (22 → 6). */
export function inShiftWindow(shift: Pick<ShiftDef, 'startHour' | 'endHour'>, hour: number): boolean {
  const { startHour: s, endHour: e } = shift;
  if (s === e) return true;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

/** Shift the asset runs in, if any. */
export function shiftOf(plant: Pick<PlantModel, 'calendar'> | null | undefined, def: Pick<AssetDef, 'shiftId'>): ShiftDef | undefined {
  return def.shiftId ? plant?.calendar?.shifts.find((s) => s.id === def.shiftId) : undefined;
}

/**
 * Dimmed look: the asset is Off *because of its shift* — it has a shiftId and the sim clock is outside
 * that window (or the shift cannot be resolved). An asset switched off by an operator during its
 * shift keeps the normal look.
 */
export function shiftDimmed(plant: Pick<PlantModel, 'calendar'> | null | undefined, def: Pick<AssetDef, 'shiftId'>, state: AssetStateKind | undefined, simTimeMs: number): boolean {
  if (state !== 'off' || !def.shiftId) return false;
  const shift = shiftOf(plant, def);
  if (!shift) return true;
  return !inShiftWindow(shift, hourOfDay(plant?.calendar, simTimeMs));
}

// ------------------------------------------------------------------ resources

/**
 * Resource the asset is waiting for: a Starved asset with a resourceId is shown as waiting for a free unit
 * (the wire has no separate "waiting for resource" state). Returns the resource kind, or null.
 */
export function resourceWait(plant: Pick<PlantModel, 'resources'> | null | undefined, def: Pick<AssetDef, 'resourceId'>, state: AssetStateKind | undefined): ResourceKind | null {
  if (state !== 'starved' || !def.resourceId) return null;
  return plant?.resources?.find((r) => r.id === def.resourceId)?.kind ?? 'operator';
}
