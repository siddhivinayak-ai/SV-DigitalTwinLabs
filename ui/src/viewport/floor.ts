import * as THREE from 'three';
import type { AssetDef, Vec3 } from '../net/contracts';
import { localToWorld } from './placement';
import { ROBOT } from './robot';

/** Integer-metre rectangle enclosing the plant with a margin. */
export function floorExtent(assets: readonly AssetDef[], margin = 4): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const a of assets) {
    const r = Math.hypot(a.size.x, a.size.z) / 2;
    x0 = Math.min(x0, a.position.x - r); x1 = Math.max(x1, a.position.x + r);
    z0 = Math.min(z0, a.position.z - r); z1 = Math.max(z1, a.position.z + r);
  }
  if (!Number.isFinite(x0)) { x0 = -10; x1 = 10; z0 = -10; z1 = 10; }
  return { x0: Math.floor(x0 - margin), x1: Math.ceil(x1 + margin), z0: Math.floor(z0 - margin), z1: Math.ceil(z1 + margin) };
}

/** 1 m minor / 5 m major grid lines as two LineSegments. */
export function buildGrid(ext: ReturnType<typeof floorExtent>, color: THREE.Color): { group: THREE.Group; minor: THREE.LineBasicMaterial; major: THREE.LineBasicMaterial } {
  const minorPts: number[] = [], majorPts: number[] = [];
  const y = 0.002;
  for (let x = ext.x0; x <= ext.x1; x++) (x % 5 === 0 ? majorPts : minorPts).push(x, y, ext.z0, x, y, ext.z1);
  for (let z = ext.z0; z <= ext.z1; z++) (z % 5 === 0 ? majorPts : minorPts).push(ext.x0, y, z, ext.x1, y, z);
  const mk = (pts: number[], mat: THREE.LineBasicMaterial) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, mat);
    l.userData.noPick = true;
    return l;
  };
  const minor = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false });
  const major = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false });
  const group = new THREE.Group();
  group.add(mk(minorPts, minor), mk(majorPts, major));
  return { group, minor, major };
}

/** Append a flat quad strip from a to b (width w) at height y to `pos` (triangles). */
function strip(pos: number[], ax: number, az: number, bx: number, bz: number, w: number, y: number): void {
  const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (w / 2), nz = (dx / l) * (w / 2);
  pos.push(ax + nx, y, az + nz, bx + nx, y, bz + nz, bx - nx, y, bz - nz);
  pos.push(ax + nx, y, az + nz, bx - nx, y, bz - nz, ax - nx, y, az - nz);
}

function meshFrom(pos: number[], mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.userData.noPick = true;
  m.receiveShadow = true;
  return m;
}

/** Safety-yellow floor tape around every cell (conveyors excluded); robots get their reach envelope. */
export function buildSafetyLines(assets: readonly AssetDef[], mat: THREE.Material): THREE.Mesh {
  const pos: number[] = [];
  const w = 0.075, y = 0.004;
  for (const a of assets) {
    if (a.kind === 'conveyor') continue;
    const reach = a.kind === 'robot' ? ROBOT.shoulderR + ROBOT.upper + ROBOT.fore - 0.25 : 0;
    const hx = Math.max(a.size.x / 2 + 0.4, reach), hz = Math.max(a.size.z / 2 + 0.4, reach);
    const c = [{ x: -hx, z: -hz }, { x: hx, z: -hz }, { x: hx, z: hz }, { x: -hx, z: hz }].map((p) => localToWorld(a, { x: p.x, y: 0, z: p.z }));
    for (let i = 0; i < 4; i++) {
      const p = c[i], q = c[(i + 1) % 4];
      if (a.kind === 'robot') {
        // dashed tape for the robot envelope
        const L = Math.hypot(q.x - p.x, q.z - p.z), n = Math.max(1, Math.round(L / 0.5));
        for (let k = 0; k < n; k += 1) {
          const t0 = k / n, t1 = (k + 0.6) / n;
          strip(pos, p.x + (q.x - p.x) * t0, p.z + (q.z - p.z) * t0, p.x + (q.x - p.x) * t1, p.z + (q.z - p.z) * t1, w, y);
        }
      } else {
        // extend by half the width so corners close cleanly
        const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
        const ex = (dx / l) * (w / 2), ez = (dz / l) * (w / 2);
        strip(pos, p.x - ex, p.z - ez, q.x + ex, q.z + ez, w, y);
      }
    }
  }
  return meshFrom(pos, mat);
}

/** Exit point (+X face centre) / entry point (−X face centre) of an asset on the floor. */
const port = (a: AssetDef, side: 1 | -1): Vec3 => localToWorld(a, { x: (side * a.size.x) / 2, y: 0, z: 0 });

/** Orthogonal (Manhattan) route between two floor points. */
export function routeFlow(a: Vec3, b: Vec3): Vec3[] {
  if (Math.abs(a.z - b.z) < 0.05 || Math.abs(a.x - b.x) < 0.05) return [a, b];
  const mx = (a.x + b.x) / 2;
  return [a, { x: mx, y: 0, z: a.z }, { x: mx, y: 0, z: b.z }, b];
}

/** Subtle floor arrows for every downstream link. */
export function buildFlowLines(assets: readonly AssetDef[], mat: THREE.Material): THREE.Mesh {
  const pos: number[] = [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const w = 0.07, y = 0.006, head = 0.32, headW = 0.24;
  for (const a of assets) for (const id of a.downstream) {
    const b = byId.get(id);
    if (!b) continue;
    const pts = routeFlow(port(a, 1), port(b, -1));
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const last = i === pts.length - 2;
      const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      const ux = dx / l, uz = dz / l;
      const end = last ? Math.max(0, l - head) : l;
      // extend joints by half width for clean corners
      const ext = i > 0 ? w / 2 : 0;
      strip(pos, p.x - ux * ext, p.z - uz * ext, p.x + ux * (end + (last ? 0 : w / 2)), p.z + uz * (end + (last ? 0 : w / 2)), w, y);
      if (last) {
        const bx = p.x + ux * end, bz = p.z + uz * end, nx = -uz * headW / 2, nz = ux * headW / 2;
        pos.push(bx + nx, y, bz + nz, q.x, y, q.z, bx - nx, y, bz - nz);
      }
    }
  }
  return meshFrom(pos, mat);
}

/** CAD-style corner brackets around a box (selection indicator). */
export function bracketGeometry(b: THREE.Box3, frac = 0.22): THREE.BufferGeometry {
  const pts: number[] = [];
  const s = new THREE.Vector3(); b.getSize(s);
  const lx = s.x * frac, ly = s.y * frac, lz = s.z * frac;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b.max.x : b.min.x, y = i & 2 ? b.max.y : b.min.y, z = i & 4 ? b.max.z : b.min.z;
    const sx = i & 1 ? -1 : 1, sy = i & 2 ? -1 : 1, sz = i & 4 ? -1 : 1;
    pts.push(x, y, z, x + sx * lx, y, z, x, y, z, x, y + sy * ly, z, x, y, z, x, y, z + sz * lz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** Floor footprint rectangle outline (for selection and status) as line loop points. */
export function footprintGeometry(b: THREE.Box3, y = 0.01): THREE.BufferGeometry {
  const pts = [b.min.x, y, b.min.z, b.max.x, y, b.min.z, b.max.x, y, b.max.z, b.min.x, y, b.max.z, b.min.x, y, b.min.z];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
