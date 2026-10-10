import { describe, expect, it } from 'vitest';
import plantV03 from '../../../contracts/examples/plant.v03.json';
import type { AssetDef, PlantModel } from '../net/contracts';
import { fitMeshToBox, footprintAabb, hourOfDay, inShiftWindow, lineZones, resourceWait, shiftDimmed } from './v03';

const plant = plantV03 as unknown as PlantModel;
const def = (id: string) => plant.assets.find((a) => a.id === id)!;

describe('fitMeshToBox', () => {
  it('scales uniformly by the tightest axis, centres x/z and grounds y', () => {
    // a 2 × 1 × 1 mesh modelled around (10, 5, -3) into a 3 × 3 × 1 box → z limits: scale 1
    const f = fitMeshToBox({ x: 9, y: 4.5, z: -3.5 }, { x: 11, y: 5.5, z: -2.5 }, { x: 3, y: 3, z: 1 });
    expect(f.scale).toBeCloseTo(1);
    expect(f.offset).toEqual({ x: -10, y: -4.5, z: 3 });
    expect(f.fitted).toEqual({ x: 2, y: 1, z: 1 });
  });

  it('handles millimetre models (shrinks) and keeps the result inside the box', () => {
    const f = fitMeshToBox({ x: 1500, y: 0, z: -1450 }, { x: 3300, y: 1980, z: -150 }, { x: 3, y: 2.4, z: 2.2 });
    expect(f.scale).toBeCloseTo(2.4 / 1980); // height is the tightest axis
    expect(f.fitted.y).toBeCloseTo(2.4);
    expect(f.fitted.x).toBeLessThanOrEqual(3);
    expect(f.fitted.y).toBeLessThanOrEqual(2.4 + 1e-9);
    expect(f.fitted.z).toBeLessThanOrEqual(2.2 + 1e-9);
    // centre maps to 0 on x/z, min y to 0
    expect(2400 * f.scale + f.offset.x).toBeCloseTo(0);
    expect(-800 * f.scale + f.offset.z).toBeCloseTo(0);
    expect(f.offset.y).toBeCloseTo(0);
  });

  it('enlarges small models', () => {
    const f = fitMeshToBox({ x: -0.5, y: 0, z: -0.5 }, { x: 0.5, y: 0.5, z: 0.5 }, { x: 2, y: 2, z: 2 });
    expect(f.scale).toBeCloseTo(2);
    expect(f.fitted).toEqual({ x: 2, y: 1, z: 2 });
  });

  it('ignores flat axes and degenerate boxes', () => {
    const flat = fitMeshToBox({ x: -1, y: 0, z: -1 }, { x: 1, y: 0, z: 1 }, { x: 4, y: 1, z: 1 });
    expect(flat.scale).toBeCloseTo(0.5);
    const empty = fitMeshToBox({ x: Infinity, y: Infinity, z: Infinity }, { x: -Infinity, y: -Infinity, z: -Infinity }, { x: 1, y: 1, z: 1 });
    expect(empty.scale).toBe(1);
    const point = fitMeshToBox({ x: 2, y: 2, z: 2 }, { x: 2, y: 2, z: 2 }, { x: 1, y: 1, z: 1 });
    expect(point.scale).toBe(1);
    expect(point.offset).toEqual({ x: -2, y: -2, z: -2 });
  });
});

describe('line zones', () => {
  it('rotates footprints', () => {
    expect(footprintAabb(def('CNC-A'))).toEqual({ x0: 3.9, x1: 6.1, z0: -5.5, z1: -2.5 });
  });

  it('builds one rectangle per line with assets, in line order, with a margin', () => {
    const z = lineZones(plant, 0.5);
    expect(z.map((x) => x.lineId)).toEqual(['line-a', 'line-b']);
    expect(z[0]).toMatchObject({ name: 'Line A', index: 0, assets: 2, x0: -1.3, x1: 6.6, z0: -6, z1: -2 });
    expect(z[1]).toMatchObject({ name: 'Line B', assets: 1 });
  });

  it('skips empty lines and plants without lines', () => {
    expect(lineZones({ ...plant, lines: [...plant.lines!, { id: 'line-c', name: 'C' }] }).length).toBe(2);
    expect(lineZones({ assets: plant.assets })).toEqual([]);
  });
});

describe('shift dimming', () => {
  it('maps sim time to hour of day from the calendar start', () => {
    expect(hourOfDay(plant.calendar, 0)).toBe(6);
    expect(hourOfDay(plant.calendar, 20 * 3_600_000)).toBe(2);
    expect(hourOfDay(undefined, 3_600_000)).toBe(1);
  });

  it('handles normal and wrapping windows', () => {
    const day = { startHour: 6, endHour: 14 }, night = { startHour: 22, endHour: 6 };
    expect(inShiftWindow(day, 6)).toBe(true);
    expect(inShiftWindow(day, 14)).toBe(false);
    expect(inShiftWindow(night, 23)).toBe(true);
    expect(inShiftWindow(night, 3)).toBe(true);
    expect(inShiftWindow(night, 12)).toBe(false);
  });

  it('dims only Off assets outside their shift', () => {
    const cnc = def('CNC-A'); // day shift 6–14, sim t=0 is 06:00
    const h = (x: number) => x * 3_600_000;
    expect(shiftDimmed(plant, cnc, 'off', h(10))).toBe(true);   // 16:00, off shift
    expect(shiftDimmed(plant, cnc, 'off', h(2))).toBe(false);   // 08:00, switched off by hand
    expect(shiftDimmed(plant, cnc, 'running', h(10))).toBe(false);
    expect(shiftDimmed(plant, def('SRC-A'), 'off', h(10))).toBe(false); // no shift
    expect(shiftDimmed(plant, { shiftId: 'ghost' } as AssetDef, 'off', 0)).toBe(true); // unresolved shift
  });
});

describe('resource wait', () => {
  it('flags Starved assets with a resource', () => {
    expect(resourceWait(plant, def('CNC-A'), 'starved')).toBe('operator');
    expect(resourceWait(plant, def('CNC-A'), 'running')).toBeNull();
    expect(resourceWait(plant, def('SRC-A'), 'starved')).toBeNull();
  });
});
