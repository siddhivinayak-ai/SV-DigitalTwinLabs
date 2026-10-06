import { describe, expect, it } from 'vitest';
import samplePlant from '../../../contracts/plant/sample_line.json';
import type { AssetDef, PlantModel } from '../net/contracts';
import {
  bufferSlot, CONVEYOR, localToWorld, machineVariant, PART, partLocalPosition, partWorldPosition,
  rackLayout, robotTargets, smoothingAlpha, worldToLocal,
} from './placement';
import { robotPose, solveArm, toolPoint, ROBOT } from './robot';
import { fitDistance, presetDirection } from './camera';

const plant = samplePlant as unknown as PlantModel;
const asset = (id: string) => plant.assets.find((a) => a.id === id)!;
const ctx = { assets: plant.assets };

describe('part placement', () => {
  it('interpolates along a conveyor’s local X across its length, on top of the belt', () => {
    const c = asset('CONV-01'); // x = 5.5, length 8
    const half = (c.size.x - 2 * CONVEYOR.endMargin) / 2;
    const p0 = partWorldPosition(c, 0, ctx);
    const p1 = partWorldPosition(c, 1, ctx);
    const pm = partWorldPosition(c, 0.5, ctx);
    expect(p0.x).toBeCloseTo(5.5 - half);
    expect(p1.x).toBeCloseTo(5.5 + half);
    expect(pm.x).toBeCloseTo(5.5);
    expect(pm.y).toBeCloseTo(c.size.y + PART.y / 2);
    expect(pm.z).toBeCloseTo(0);
  });

  it('clamps progress outside 0..1 and tolerates NaN', () => {
    const c = asset('CONV-02');
    expect(partWorldPosition(c, 2, ctx)).toEqual(partWorldPosition(c, 1, ctx));
    expect(partWorldPosition(c, -1, ctx)).toEqual(partWorldPosition(c, 0, ctx));
    expect(partWorldPosition(c, Number.NaN, ctx)).toEqual(partWorldPosition(c, 0, ctx));
  });

  it('honours rotationY (degrees, right-handed about +Y)', () => {
    const c: AssetDef = { ...asset('CONV-02'), position: { x: 0, y: 0, z: 0 }, rotationY: 90 };
    const end = partWorldPosition(c, 1, ctx);
    // +X local maps to -Z world after +90° about Y
    expect(end.x).toBeCloseTo(0);
    expect(end.z).toBeLessThan(-2);
    const back = worldToLocal(c, localToWorld(c, { x: 1.2, y: 0.3, z: -0.4 }));
    expect(back.x).toBeCloseTo(1.2);
    expect(back.y).toBeCloseTo(0.3);
    expect(back.z).toBeCloseTo(-0.4);
  });

  it('places a machine part on the fixture inside the footprint, above the table', () => {
    const m = asset('CNC-01');
    const p = partWorldPosition(m, 0.4, ctx);
    expect(Math.abs(p.x - m.position.x)).toBeLessThan(m.size.x / 2);
    expect(Math.abs(p.z - m.position.z)).toBeLessThan(m.size.z / 2);
    expect(p.y).toBeGreaterThan(0.5);
    expect(p.y).toBeLessThan(m.size.y);
    // a machine part does not move with progress
    expect(partWorldPosition(m, 0.9, ctx)).toEqual(p);
  });

  it('picks the machine variant from id/name', () => {
    expect(machineVariant(asset('CNC-01'))).toBe('cnc');
    expect(machineVariant(asset('ASSY-01'))).toBe('press');
    expect(machineVariant(asset('PACK-01'))).toBe('pack');
  });

  it('maps buffer slots to distinct shelf positions inside the rack', () => {
    const b = asset('BUF-01'); // capacity 10 → 2 levels x 5
    const L = rackLayout(b);
    expect(L.levels).toBe(2);
    expect(L.cols).toBe(5);
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const s = bufferSlot(b, i);
      expect(Math.abs(s.x)).toBeLessThan(b.size.x / 2);
      expect(s.y).toBeLessThan(b.size.y);
      seen.add(`${s.x.toFixed(3)},${s.y.toFixed(3)}`);
    }
    expect(seen.size).toBe(10);
    // slot index from progress, like the mock: (i + 0.5) / capacity
    expect(partLocalPosition(b, 2.5 / 10)).toEqual(bufferSlot(b, 2));
    // explicit FIFO rank wins, out-of-range ranks clamp
    expect(partLocalPosition(b, 0, { assets: plant.assets, slotIndex: 7 })).toEqual(bufferSlot(b, 7));
    expect(bufferSlot(b, 99)).toEqual(bufferSlot(b, 9));
  });

  it('carries robot parts from the upstream side to the downstream side', () => {
    const r = asset('ROB-01');
    const start = partWorldPosition(r, 0, ctx);
    const end = partWorldPosition(r, 1, ctx);
    expect(start.x).toBeLessThan(r.position.x - 0.8); // towards BUF-01
    expect(end.x).toBeGreaterThan(r.position.x + 0.8); // towards ASSY-01
    const mid = partWorldPosition(r, 0.45, ctx);
    expect(mid.y).toBeGreaterThan(start.y); // lifted while swinging
  });

  it('smoothing alpha is frame-rate independent and bounded', () => {
    expect(smoothingAlpha(0)).toBe(0);
    expect(smoothingAlpha(-1)).toBe(0);
    const a = smoothingAlpha(1 / 60, 10);
    const b = smoothingAlpha(1 / 30, 10);
    expect(1 - b).toBeCloseTo((1 - a) ** 2);
    expect(smoothingAlpha(10)).toBeLessThan(1);
  });
});

describe('robot kinematics', () => {
  it('IK solution reproduces the target through FK', () => {
    for (const pose of [{ yaw: 0, r: 1.6, h: 0.9 }, { yaw: Math.PI, r: 1.2, h: 1.3 }, { yaw: 1, r: 1.9, h: 0.7 }]) {
      const t = toolPoint(solveArm(pose));
      expect(Math.hypot(t.x, t.z)).toBeCloseTo(pose.r, 5);
      expect(t.y).toBeCloseTo(pose.h, 5);
    }
  });

  it('path starts at pick and ends at place', () => {
    const { pick, place } = robotTargets(asset('ROB-01'), plant.assets);
    expect(robotPose(0, pick, place)).toEqual(pick);
    expect(robotPose(1, pick, place)).toEqual(place);
    expect(robotPose(0.4, pick, place).h).toBeGreaterThanOrEqual(Math.min(pick.h, place.h) + ROBOT.lift - 1e-9);
  });
});

describe('camera framing', () => {
  it('fits a long line farther away in a narrow viewport', () => {
    const box = { min: { x: 0, y: 0, z: -3 }, max: { x: 42, y: 2.5, z: 3 } };
    const wide = fitDistance(box, presetDirection('front'), 35, 2);
    const narrow = fitDistance(box, presetDirection('front'), 35, 1);
    expect(narrow).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThan(21 / Math.tan((17.5 * Math.PI) / 180) / 2 - 1);
  });
});
