// Plan-view math (pure, unit-tested): world metres ↔ screen pixels, snapping, rotated footprints,
// hit testing and overlap. Plan view looks down -Y: screen x = world X, screen y = world Z.
// Footprints use the viewport convention (viewport/placement.ts): world = position + rotY(rotationY°)·local,
// local +X along the asset length (flow direction), size.x × size.z on the floor.
import type { AssetDef } from '../net/contracts';

export interface View {
  /** Pixels per metre. */
  scale: number;
  /** Screen position (CSS px) of world origin. */
  ox: number;
  oy: number;
}

export interface Pt { x: number; z: number }
export interface Rect { x0: number; z0: number; x1: number; z1: number }

export const MIN_SCALE = 4;
export const MAX_SCALE = 400;

export function worldToScreen(v: View, x: number, z: number): { sx: number; sy: number } {
  return { sx: x * v.scale + v.ox, sy: z * v.scale + v.oy };
}

export function screenToWorld(v: View, sx: number, sy: number): Pt {
  return { x: (sx - v.ox) / v.scale, z: (sy - v.oy) / v.scale };
}

/** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number, min = MIN_SCALE, max = MAX_SCALE): View {
  const scale = Math.min(max, Math.max(min, v.scale * factor));
  const w = screenToWorld(v, sx, sy);
  return { scale, ox: sx - w.x * scale, oy: sy - w.z * scale };
}

/** Snap to a grid step (0.5 m by default); also removes float noise. */
export function snap(value: number, step = 0.5): number {
  if (!(step > 0)) return value;
  const r = Math.round(value / step) * step;
  return +r.toFixed(6) + 0; // +0 turns -0 into 0
}

export function round3(v: number): number { return +v.toFixed(3) + 0; }

/** Normalise degrees to [0, 360). */
export function normDeg(d: number): number {
  const r = ((d % 360) + 360) % 360;
  return +r.toFixed(6) + 0;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** Asset-local floor point → world (same maths as viewport placement.localToWorld). */
export function localToWorld(a: Pick<AssetDef, 'position' | 'rotationY'>, lx: number, lz: number): Pt {
  const t = rad(a.rotationY || 0);
  const c = Math.cos(t), s = Math.sin(t);
  return { x: a.position.x + lx * c + lz * s, z: a.position.z - lx * s + lz * c };
}

export function worldToLocal(a: Pick<AssetDef, 'position' | 'rotationY'>, x: number, z: number): Pt {
  const t = rad(a.rotationY || 0);
  const c = Math.cos(t), s = Math.sin(t);
  const dx = x - a.position.x, dz = z - a.position.z;
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** Rotate an offset vector by `deg` with the same handedness as rotationY. */
export function rotateVec(x: number, z: number, deg: number): Pt {
  const t = rad(deg);
  const c = Math.cos(t), s = Math.sin(t);
  return { x: round3(x * c + z * s), z: round3(-x * s + z * c) };
}

type Foot = Pick<AssetDef, 'position' | 'rotationY' | 'size'>;

/** The 4 world corners of a footprint (counter-wise order). */
export function footprint(a: Foot): Pt[] {
  const hx = a.size.x / 2, hz = a.size.z / 2;
  return [localToWorld(a, -hx, -hz), localToWorld(a, hx, -hz), localToWorld(a, hx, hz), localToWorld(a, -hx, hz)];
}

export function aabb(a: Foot): Rect {
  const c = footprint(a);
  return {
    x0: Math.min(...c.map((p) => p.x)), z0: Math.min(...c.map((p) => p.z)),
    x1: Math.max(...c.map((p) => p.x)), z1: Math.max(...c.map((p) => p.z)),
  };
}

export function unionRect(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  return {
    x0: Math.min(...rs.map((r) => r.x0)), z0: Math.min(...rs.map((r) => r.z0)),
    x1: Math.max(...rs.map((r) => r.x1)), z1: Math.max(...rs.map((r) => r.z1)),
  };
}

export function normRect(x0: number, z0: number, x1: number, z1: number): Rect {
  return { x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) };
}

export function pointInAsset(a: Foot, x: number, z: number, pad = 0): boolean {
  const l = worldToLocal(a, x, z);
  return Math.abs(l.x) <= a.size.x / 2 + pad && Math.abs(l.z) <= a.size.z / 2 + pad;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;
}

/** Marquee semantics: the asset's footprint intersects the rect. */
export function assetInRect(a: Foot, r: Rect): boolean {
  if (!rectsIntersect(aabb(a), r)) return false;
  const rectAsset: Foot = { position: { x: (r.x0 + r.x1) / 2, y: 0, z: (r.z0 + r.z1) / 2 }, rotationY: 0, size: { x: r.x1 - r.x0, y: 0, z: r.z1 - r.z0 } };
  return footprintsOverlap(a, rectAsset, -1e-9);
}

/**
 * Separating-axis test for two rotated rectangles. Overlap must exceed `eps` metres on every axis,
 * so footprints that merely touch do not count (eps < 0 makes touching count).
 */
export function footprintsOverlap(a: Foot, b: Foot, eps = 1e-6): boolean {
  const ca = footprint(a), cb = footprint(b);
  const axes: Pt[] = [];
  for (const c of [ca, cb]) {
    for (let i = 0; i < 2; i++) {
      const p = c[i], q = c[i + 1];
      const ex = q.x - p.x, ez = q.z - p.z;
      const len = Math.hypot(ex, ez) || 1;
      axes.push({ x: -ez / len, z: ex / len });
    }
  }
  for (const ax of axes) {
    const pa = ca.map((p) => p.x * ax.x + p.z * ax.z);
    const pb = cb.map((p) => p.x * ax.x + p.z * ax.z);
    const overlap = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb));
    if (overlap <= eps) return false;
  }
  return true;
}

/**
 * Where the ray from the footprint centre towards (tx, tz) leaves the footprint (world).
 * Used to start/end flow arrows on the asset outline.
 */
export function exitPoint(a: Foot, tx: number, tz: number, pad = 0): Pt {
  const l = worldToLocal(a, tx, tz);
  const hx = a.size.x / 2 + pad, hz = a.size.z / 2 + pad;
  const sx = l.x === 0 ? Infinity : hx / Math.abs(l.x);
  const sz = l.z === 0 ? Infinity : hz / Math.abs(l.z);
  const s = Math.min(sx, sz, 1);
  return localToWorld(a, l.x * s, l.z * s);
}

/** Distance from point p to segment ab. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const L = dx * dx + dz * dz;
  let t = L ? ((px - ax) * dx + (pz - az) * dz) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** View that fits a world rect into a w×h area with `margin` px around it. */
export function fitView(r: Rect | null, w: number, h: number, margin = 40, offX = 0, offY = 0): View {
  const rr = r ?? { x0: -10, z0: -6, x1: 10, z1: 6 };
  const ww = Math.max(1, rr.x1 - rr.x0), hh = Math.max(1, rr.z1 - rr.z0);
  const availW = Math.max(40, w - offX - margin * 2), availH = Math.max(40, h - offY - margin * 2);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availW / ww, availH / hh)));
  const cx = (rr.x0 + rr.x1) / 2, cz = (rr.z0 + rr.z1) / 2;
  return { scale, ox: offX + (w - offX) / 2 - cx * scale, oy: offY + (h - offY) / 2 - cz * scale };
}

/** A "nice" ruler/grid step (1, 2, 5 × 10^n metres) so labelled ticks are ≥ minPx apart. */
export function niceStep(scale: number, minPx: number): number {
  const raw = minPx / scale;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
