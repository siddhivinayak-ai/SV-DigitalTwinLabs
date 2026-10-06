// Pure mapping from (asset, progress) to part positions, shared by the mesh builders so parts sit
// exactly on belts, fixtures and shelves. No three.js imports: unit-tested in placement.test.ts.
//
// Asset-local frame: origin at the centre of the footprint on the floor, +X along the asset's length
// (the flow direction), Y up, +Z towards the operator side. World = position + rotY(rotationY°) · local.

import type { AssetDef, Vec3 } from '../net/contracts';
import { ROBOT, robotPose, solveArm, toolPoint, type ToolPose } from './robot';

/** A machined housing: the moving part. */
export const PART = { x: 0.3, y: 0.18, z: 0.24 } as const;

export const CONVEYOR = { endMargin: 0.22, beltThk: 0.04 } as const;
export const INSPECTION = { tableH: 0.86, travel: 0.6 } as const;
export const PALLET_H = 0.15;

export type MachineVariant = 'cnc' | 'press' | 'pack';

/** Which procedural model to use for a generic `machine`. */
export function machineVariant(def: Pick<AssetDef, 'id' | 'name'>): MachineVariant {
  const s = `${def.id} ${def.name}`.toLowerCase();
  if (/press|assy|assembl/.test(s)) return 'press';
  if (/pack/.test(s)) return 'pack';
  return 'cnc';
}

/** Fixture (work-holding) height in asset-local Y for a machine variant: the top of the table. */
export function machineTableH(variant: MachineVariant, sizeY: number): number {
  switch (variant) {
    case 'cnc': return Math.min(0.95, sizeY * 0.4);
    case 'press': return Math.min(0.9, sizeY * 0.5);
    case 'pack': return Math.min(0.85, sizeY * 0.45);
  }
}

export const deg2rad = (d: number) => (d * Math.PI) / 180;

/** Rotate a local vector by the asset's rotationY (degrees, right-handed about +Y) and translate. */
export function localToWorld(def: Pick<AssetDef, 'position' | 'rotationY'>, p: Vec3): Vec3 {
  const a = deg2rad(def.rotationY || 0);
  const c = Math.cos(a), s = Math.sin(a);
  return { x: def.position.x + p.x * c + p.z * s, y: def.position.y + p.y, z: def.position.z - p.x * s + p.z * c };
}

/** Inverse of localToWorld. */
export function worldToLocal(def: Pick<AssetDef, 'position' | 'rotationY'>, p: Vec3): Vec3 {
  const a = deg2rad(def.rotationY || 0);
  const c = Math.cos(a), s = Math.sin(a);
  const dx = p.x - def.position.x, dz = p.z - def.position.z;
  return { x: dx * c - dz * s, y: p.y - def.position.y, z: dx * s + dz * c };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export interface RackLayout { levels: number; cols: number; shelfY: number[]; pitchX: number }

/** Shelf layout of a buffer rack with `capacity` slots. */
export function rackLayout(def: Pick<AssetDef, 'size' | 'params'>): RackLayout {
  const cap = Math.max(1, Math.round(def.params.capacity ?? 10));
  const levels = cap > 5 ? 2 : 1;
  const cols = Math.ceil(cap / levels);
  const h = def.size.y;
  const shelfY = levels === 1 ? [h * 0.55] : [0.16, h * 0.56];
  return { levels, cols, shelfY, pitchX: (def.size.x * 0.88) / cols };
}

/** Local centre of buffer slot `i` (row-major from the outfeed end, lower shelf first). */
export function bufferSlot(def: Pick<AssetDef, 'size' | 'params'>, i: number): Vec3 {
  const L = rackLayout(def);
  const idx = Math.max(0, Math.min(L.levels * L.cols - 1, i));
  const level = Math.floor(idx / L.cols);
  const col = idx % L.cols;
  // slot 0 is nearest the outfeed (+X): FIFO head
  const x = (L.cols / 2 - col - 0.5) * L.pitchX;
  return { x, y: L.shelfY[level] + 0.025 + PART.y / 2, z: 0 };
}

/** Pick/place tool poses for a robot, derived from its upstream and downstream neighbours. */
export function robotTargets(def: AssetDef, assets: readonly AssetDef[]): { pick: ToolPose; place: ToolPose } {
  const up = assets.find((a) => a.downstream.includes(def.id));
  const down = assets.find((a) => a.id === def.downstream[0]);
  const target = (n: AssetDef | undefined, fallbackYaw: number, h: number): ToolPose => {
    if (!n) return { yaw: fallbackYaw, r: 1.6, h };
    const v = worldToLocal(def, n.position);
    const dist = Math.hypot(v.x, v.z);
    const yaw = Math.atan2(-v.z, v.x);
    const reachMax = ROBOT.shoulderR + ROBOT.upper + ROBOT.fore - 0.12;
    const r = Math.min(reachMax, Math.max(1.0, dist - Math.max(n.size.x, n.size.z) / 2 + 0.35));
    return { yaw, r, h };
  };
  const pick = target(up, Math.PI, 0.82);
  const place = target(down, 0, 0.98);
  // Swing the short way round the back (−Z) when both sides are colinear.
  if (Math.abs(pick.yaw - place.yaw) > Math.PI) place.yaw += place.yaw < pick.yaw ? 2 * Math.PI : -2 * Math.PI;
  return { pick, place };
}

export interface PlacementContext {
  /** All assets in the plant (needed for robot pick/place targets). */
  assets: readonly AssetDef[];
  /** For buffers: the part's index in the FIFO when known (otherwise derived from progress × capacity). */
  slotIndex?: number;
}

/** Part centre in asset-local coordinates. */
export function partLocalPosition(def: AssetDef, progress: number, ctx?: PlacementContext): Vec3 {
  const p = clamp01(progress);
  const half = PART.y / 2;
  switch (def.kind) {
    case 'conveyor': {
      const len = Math.max(0.1, def.size.x - 2 * CONVEYOR.endMargin);
      return { x: -len / 2 + p * len, y: def.size.y + half, z: 0 };
    }
    case 'buffer': {
      const cap = Math.max(1, Math.round(def.params.capacity ?? 10));
      const i = ctx?.slotIndex ?? Math.floor(p * cap);
      return bufferSlot(def, i);
    }
    case 'robot': {
      const { pick, place } = robotTargets(def, ctx?.assets ?? [def]);
      const t = toolPoint(solveArm(robotPose(p, pick, place)));
      return { x: t.x, y: t.y - half - 0.02, z: t.z };
    }
    case 'inspection': {
      const travel = (def.size.x * INSPECTION.travel) / 2;
      return { x: -travel + 2 * travel * p, y: INSPECTION.tableH + half, z: 0 };
    }
    case 'machine': {
      const v = machineVariant(def);
      return { x: v === 'cnc' ? -0.15 : 0, y: machineTableH(v, def.size.y) + 0.06 + half, z: v === 'cnc' ? 0 : 0.05 };
    }
    case 'source':
    case 'sink':
      return { x: 0, y: PALLET_H + half, z: 0 };
  }
}

/** Part centre in world coordinates for a part on `def` at `progress` (0..1). */
export function partWorldPosition(def: AssetDef, progress: number, ctx?: PlacementContext): Vec3 {
  return localToWorld(def, partLocalPosition(def, progress, ctx));
}

/** Frame-rate independent exponential smoothing factor: fraction to move this frame. */
export function smoothingAlpha(dtSec: number, rate = 10): number {
  if (!(dtSec > 0)) return 0;
  return 1 - Math.exp(-rate * Math.min(dtSec, 0.5));
}
