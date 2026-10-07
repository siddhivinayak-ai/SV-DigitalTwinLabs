// Pure camera framing maths (no three.js), unit-tested.

import type { Vec3 } from '../net/contracts';

export interface Box3Like { min: Vec3; max: Vec3 }
export type ViewPreset = 'iso' | 'top' | 'front' | 'fit';

/** Unit direction from the target towards the camera for each preset. */
export function presetDirection(p: Exclude<ViewPreset, 'fit'>): Vec3 {
  switch (p) {
    case 'iso': return normalize({ x: -0.32, y: 0.62, z: 1 });
    case 'top': return normalize({ x: 0, y: 1, z: 0.0015 });
    case 'front': return normalize({ x: 0, y: 0.12, z: 1 });
  }
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Distance from the box centre, along `dir` (target → camera), at which a perspective camera with
 * vertical FOV `fovDeg` and `aspect` sees every corner of the box, with relative `margin`.
 */
export function fitDistance(box: Box3Like, dir: Vec3, fovDeg: number, aspect: number, margin = 1.08): number {
  const d = normalize(dir);
  const worldUp = Math.abs(d.y) > 0.999 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(worldUp, d));
  const up = cross(d, right);
  const c = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  const tanV = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const tanH = tanV * Math.max(1e-3, aspect);
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    const p = { x: i & 1 ? box.max.x : box.min.x, y: i & 2 ? box.max.y : box.min.y, z: i & 4 ? box.max.z : box.min.z };
    const q = { x: (p.x - c.x) * margin, y: (p.y - c.y) * margin, z: (p.z - c.z) * margin };
    const along = dot(q, d);
    dist = Math.max(dist, along + Math.abs(dot(q, right)) / tanH, along + Math.abs(dot(q, up)) / tanV);
  }
  return Math.max(dist, 0.5);
}

/** Ease-in-out cubic for camera tweens. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
