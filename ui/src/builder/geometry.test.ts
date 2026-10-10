import { describe, expect, it } from 'vitest';
import {
  aabb, assetInRect, exitPoint, fitView, footprintsOverlap, localToWorld, niceStep, normDeg, pointInAsset,
  screenToWorld, snap, worldToLocal, worldToScreen, zoomAt, type View,
} from './geometry';

const box = (x: number, z: number, sx: number, sz: number, rot = 0) => ({ position: { x, y: 0, z }, rotationY: rot, size: { x: sx, y: 1, z: sz } });

describe('screen ↔ world', () => {
  const v: View = { scale: 20, ox: 100, oy: 50 };
  it('round-trips', () => {
    const s = worldToScreen(v, 3.25, -1.5);
    expect(s).toEqual({ sx: 165, sy: 20 });
    expect(screenToWorld(v, s.sx, s.sy)).toEqual({ x: 3.25, z: -1.5 });
  });

  it('zoomAt keeps the point under the cursor fixed and clamps', () => {
    const before = screenToWorld(v, 300, 200);
    const z = zoomAt(v, 300, 200, 2);
    expect(z.scale).toBe(40);
    const after = screenToWorld(z, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.z).toBeCloseTo(before.z, 9);
    expect(zoomAt(v, 0, 0, 1000).scale).toBe(400);
    expect(zoomAt(v, 0, 0, 0.0001).scale).toBe(4);
  });

  it('fitView centres a rect in the drawing area', () => {
    const f = fitView({ x0: 0, z0: -2, x1: 40, z1: 2 }, 1000, 500, 40, 18, 18);
    const c = worldToScreen(f, 20, 0);
    expect(c.sx).toBeCloseTo(18 + (1000 - 18) / 2);
    expect(c.sy).toBeCloseTo(18 + (500 - 18) / 2);
    expect(f.scale).toBeCloseTo((1000 - 18 - 80) / 40);
  });
});

describe('snap', () => {
  it('snaps to 0.5 m and cleans float noise', () => {
    expect(snap(1.26)).toBe(1.5);
    expect(snap(1.24)).toBe(1);
    expect(snap(-0.2)).toBe(0);
    expect(Object.is(snap(-0.2), -0)).toBe(false);
    expect(snap(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(snap(3.3, 0)).toBe(3.3);
  });
  it('normalises degrees', () => {
    expect(normDeg(-90)).toBe(270);
    expect(normDeg(450)).toBe(90);
    expect(normDeg(360)).toBe(0);
  });
});

describe('footprints', () => {
  it('local/world matches the viewport convention (rotationY 90 sends +X to -Z)', () => {
    const a = box(5, 5, 4, 2, 90);
    const p = localToWorld(a, 2, 0);
    expect(p.x).toBeCloseTo(5);
    expect(p.z).toBeCloseTo(3);
    const l = worldToLocal(a, p.x, p.z);
    expect(l.x).toBeCloseTo(2);
    expect(l.z).toBeCloseTo(0);
  });

  it('aabb of a rotated box swaps extents', () => {
    const r = aabb(box(0, 0, 4, 2, 90));
    expect(r.x0).toBeCloseTo(-1); expect(r.x1).toBeCloseTo(1);
    expect(r.z0).toBeCloseTo(-2); expect(r.z1).toBeCloseTo(2);
  });

  it('hit tests rotated footprints', () => {
    const a = box(0, 0, 4, 1, 90);
    expect(pointInAsset(a, 0, 1.8)).toBe(true);
    expect(pointInAsset(a, 1.8, 0)).toBe(false);
  });

  it('SAT overlap handles rotation and touching edges', () => {
    expect(footprintsOverlap(box(0, 0, 2, 2), box(2, 0, 2, 2))).toBe(false); // touching
    expect(footprintsOverlap(box(0, 0, 2, 2), box(1.9, 0, 2, 2))).toBe(true);
    expect(footprintsOverlap(box(0, 0, 4, 0.5, 45), box(1.6, -1.6, 0.5, 0.5))).toBe(true);
    expect(footprintsOverlap(box(0, 0, 4, 0.5, 45), box(1.6, 1.6, 0.5, 0.5))).toBe(false);
  });

  it('marquee intersects footprints', () => {
    expect(assetInRect(box(5, 5, 2, 2), { x0: 0, z0: 0, x1: 4.2, z1: 4.2 })).toBe(true);
    expect(assetInRect(box(5, 5, 2, 2), { x0: 0, z0: 0, x1: 3.9, z1: 3.9 })).toBe(false);
  });

  it('exitPoint lands on the outline', () => {
    const a = box(0, 0, 4, 2);
    expect(exitPoint(a, 10, 0)).toEqual({ x: 2, z: 0 });
    const p = exitPoint(a, 0, -10);
    expect(p.x).toBeCloseTo(0); expect(p.z).toBeCloseTo(-1);
  });
});

describe('rulers', () => {
  it('niceStep picks 1/2/5 × 10^n', () => {
    expect(niceStep(20, 50)).toBe(5);
    expect(niceStep(100, 50)).toBe(0.5);
    expect(niceStep(5, 50)).toBe(10);
    expect(niceStep(60, 50)).toBe(1);
  });
});
