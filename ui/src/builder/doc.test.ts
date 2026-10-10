import { describe, expect, it } from 'vitest';
import samplePlant from '../../../contracts/plant/sample_line.json';
import type { PlantModel } from '../net/contracts';
import { BuilderDoc } from './doc';
import * as ops from './ops';

const sample = () => JSON.parse(JSON.stringify(samplePlant)) as PlantModel;
const find = (p: PlantModel, id: string) => p.assets.find((a) => a.id === id)!;

describe('BuilderDoc undo/redo', () => {
  it('undo and redo restore the plant exactly', () => {
    const d = new BuilderDoc(sample());
    const states = [JSON.stringify(d.plant)];
    d.edit('add', (p) => { ops.addAsset(p, 'machine', 12, 6); });
    states.push(JSON.stringify(d.plant));
    d.edit('move', (p) => ops.moveAssets(p, ['CNC-01', 'BUF-01'], 1.5, -0.5));
    states.push(JSON.stringify(d.plant));
    d.edit('rename', (p) => ops.renameAsset(p, 'CNC-02', 'MILL-2'));
    states.push(JSON.stringify(d.plant));
    d.edit('delete', (p) => ops.deleteAssets(p, ['BUF-01']));
    states.push(JSON.stringify(d.plant));
    for (let i = states.length - 2; i >= 0; i--) { expect(d.undo()).toBe(true); expect(JSON.stringify(d.plant)).toBe(states[i]); }
    expect(d.undo()).toBe(false);
    for (let i = 1; i < states.length; i++) { expect(d.redo()).toBe(true); expect(JSON.stringify(d.plant)).toBe(states[i]); }
    expect(d.redo()).toBe(false);
  });

  it('keeps at least 100 steps', () => {
    const d = new BuilderDoc(sample());
    const first = JSON.stringify(d.plant);
    for (let i = 0; i < 150; i++) d.edit(`m${i}`, (p) => ops.moveAssets(p, ['SRC-01'], 0.5, 0));
    expect(d.undoDepth).toBeGreaterThanOrEqual(150);
    while (d.undo());
    expect(JSON.stringify(d.plant)).toBe(first);
  });

  it('caps history at the limit', () => {
    const d = new BuilderDoc(sample(), 120);
    for (let i = 0; i < 130; i++) d.edit(`m${i}`, (p) => ops.moveAssets(p, ['SRC-01'], 0.5, 0));
    expect(d.undoDepth).toBe(120);
  });

  it('refused edits and no-ops do not create steps', () => {
    const d = new BuilderDoc(sample());
    expect(d.edit('bad', (p) => ops.renameAsset(p, 'CNC-01', 'CNC-02'))).toMatch(/already exists/);
    d.edit('noop', () => undefined);
    expect(d.canUndo).toBe(false);
    expect(d.dirty).toBe(false);
  });

  it('merges consecutive edits with the same key', () => {
    let t = 0;
    const d = new BuilderDoc(sample(), 200, () => t);
    d.edit('nudge', (p) => ops.moveAssets(p, ['SRC-01'], 0.5, 0), 'nudge');
    t += 100;
    d.edit('nudge', (p) => ops.moveAssets(p, ['SRC-01'], 0.5, 0), 'nudge');
    expect(d.undoDepth).toBe(1);
    t += 5000;
    d.edit('nudge', (p) => ops.moveAssets(p, ['SRC-01'], 0.5, 0), 'nudge');
    expect(d.undoDepth).toBe(2);
    d.undo(); d.undo();
    expect(find(d.plant, 'SRC-01').position.x).toBe(0);
  });

  it('tracks dirty state across undo/redo and markClean', () => {
    const d = new BuilderDoc(sample());
    d.edit('a', (p) => ops.moveAssets(p, ['SRC-01'], 1, 0));
    expect(d.dirty).toBe(true);
    d.undo();
    expect(d.dirty).toBe(false);
    d.redo();
    d.markClean();
    expect(d.dirty).toBe(false);
    d.undo();
    expect(d.dirty).toBe(true);
  });
});

describe('operations', () => {
  it('addAsset creates defaults with the next id', () => {
    const p = sample();
    expect(ops.addAsset(p, 'machine', 0, 8)).toBe('CNC-03');
    expect(p.sensors.filter((s) => s.assetId === 'CNC-03')).toHaveLength(4);
    expect(ops.addAsset(p, 'machine', 0, 8)).toBe('CNC-04');
  });

  it('delete removes sensors, downstream refs and bindings', () => {
    const p = sample();
    p.bindings = [
      { target: 'sensor:CNC-01.temp', connectionId: 'c', address: 'a' },
      { target: 'asset:CNC-01.state', connectionId: 'c', address: 'b' },
      { target: 'asset:CNC-02.state', connectionId: 'c', address: 'c' },
    ];
    ops.deleteAssets(p, ['CNC-01']);
    expect(p.assets.some((a) => a.id === 'CNC-01')).toBe(false);
    expect(find(p, 'CONV-01').downstream).toEqual(['CNC-02']);
    expect(p.sensors.some((s) => s.assetId === 'CNC-01')).toBe(false);
    expect(p.bindings.map((b) => b.target)).toEqual(['asset:CNC-02.state']);
  });

  it('rename updates downstream lists, sensors and bindings', () => {
    const p = sample();
    p.bindings = [{ target: 'sensor:CNC-01.vib', connectionId: 'c', address: 'a' }, { target: 'asset:CNC-01.good', connectionId: 'c', address: 'b' }];
    expect(ops.renameAsset(p, 'CNC-01', 'MILL-01')).toBeUndefined();
    expect(find(p, 'CONV-01').downstream).toEqual(['MILL-01', 'CNC-02']);
    const s = p.sensors.filter((x) => x.assetId === 'MILL-01').map((x) => x.id);
    expect(s).toEqual(['MILL-01.temp', 'MILL-01.vib', 'MILL-01.power', 'MILL-01.current']);
    expect(p.bindings.map((b) => b.target)).toEqual(['sensor:MILL-01.vib', 'asset:MILL-01.good']);
    expect(ops.renameAsset(p, 'MILL-01', 'bad id')).toMatch(/only contain/);
    expect(ops.renameAsset(p, 'MILL-01', 'CNC-02')).toMatch(/exists/);
  });

  it('connect / disconnect with guards', () => {
    const p = sample();
    expect(ops.connect(p, 'SNK-01', 'SRC-01')).toMatch(/sink/);
    expect(ops.connect(p, 'BUF-01', 'SRC-01')).toMatch(/source/);
    expect(ops.connect(p, 'BUF-01', 'BUF-01')).toMatch(/itself/);
    expect(ops.connect(p, 'BUF-01', 'ROB-01')).toMatch(/already/);
    expect(ops.connect(p, 'BUF-01', 'QC-01')).toBeUndefined();
    expect(find(p, 'BUF-01').downstream).toEqual(['ROB-01', 'QC-01']);
    expect(ops.disconnect(p, 'BUF-01', 'ROB-01')).toBeUndefined();
    expect(find(p, 'BUF-01').downstream).toEqual(['QC-01']);
    expect(ops.disconnect(p, 'BUF-01', 'ROB-01')).toMatch(/does not/);
    ops.disconnectAll(p, ['QC-01']);
    expect(find(p, 'BUF-01').downstream).toEqual([]);
    expect(find(p, 'QC-01').downstream).toEqual([]);
  });

  it('rotate in 90° steps: single in place, group about the centre', () => {
    const p = sample();
    ops.rotateAssets(p, ['CNC-01'], 90);
    expect(find(p, 'CNC-01').rotationY).toBe(90);
    expect(find(p, 'CNC-01').position).toEqual({ x: 12, y: 0, z: -2.2 });
    ops.rotateAssets(p, ['CNC-01'], -180);
    expect(find(p, 'CNC-01').rotationY).toBe(270);
    ops.rotateAssets(p, ['SRC-01', 'CONV-01'], 90); // centre snaps to (3, 0)
    expect(find(p, 'SRC-01').position).toEqual({ x: 3, y: 0, z: 3 });
    expect(find(p, 'CONV-01').position).toEqual({ x: 3, y: 0, z: -2.5 });
  });

  it('resize keeps conveyor length in step', () => {
    const p = sample();
    expect(ops.resizeAsset(p, 'CONV-01', { x: 5 })).toBeUndefined();
    expect(find(p, 'CONV-01').size.x).toBe(5);
    expect(find(p, 'CONV-01').params.lengthM).toBe(5);
    expect(ops.resizeAsset(p, 'CONV-01', { x: 0 })).toMatch(/> 0/);
  });

  it('paste gives new ids per prefix, keeps internal flows, drops external ones', () => {
    const p = sample();
    const clip = ops.copyAssets(p, ['CNC-01', 'BUF-01', 'PACK-01'])!;
    const ids = ops.pasteAssets(p, clip, 1, 1);
    expect(ids).toEqual(['CNC-03', 'BUF-02', 'PACK-02']);
    expect(find(p, 'CNC-03').downstream).toEqual(['BUF-02']);
    expect(find(p, 'BUF-02').downstream).toEqual([]);
    expect(find(p, 'CNC-03').position).toEqual({ x: 13, y: 0, z: -1.2 });
    expect(p.sensors.filter((s) => s.assetId === 'CNC-03').map((s) => s.id)).toContain('CNC-03.temp');
  });

  it('params and sensors', () => {
    const p = sample();
    ops.setParam(p, 'CNC-01', 'cycleTimeS', 44);
    expect(find(p, 'CNC-01').params.cycleTimeS).toBe(44);
    ops.setParam(p, 'CNC-01', 'ambientC', undefined);
    expect('ambientC' in find(p, 'CNC-01').params).toBe(false);
    const id = ops.addSensor(p, 'CNC-01', 'temperature', '°C');
    expect(id).toBe('CNC-01.temp2');
    expect(ops.patchSensor(p, 'CNC-01.temp2', { suffix: 'spindle', hi: 60, hiHi: 75, noise: 0.01 })).toBeUndefined();
    const s = p.sensors.find((x) => x.id === 'CNC-01.spindle')!;
    expect([s.hi, s.hiHi]).toEqual([60, 75]);
    ops.patchSensor(p, 'CNC-01.spindle', { hi: undefined });
    expect('hi' in s || 'hi' in p.sensors.find((x) => x.id === 'CNC-01.spindle')!).toBe(false);
    expect(ops.patchSensor(p, 'CNC-01.spindle', { suffix: 'temp' })).toMatch(/exists/);
    expect(ops.removeSensor(p, 'CNC-01.spindle')).toBeUndefined();
  });

  it('lines/resources/shifts CRUD keeps asset refs consistent', () => {
    const p = sample();
    const l = ops.addLine(p);
    expect(l).toBe('line-1');
    ops.patchAsset(p, 'CNC-01', { lineId: l });
    ops.patchLine(p, l, { id: 'main', name: 'Main line' });
    expect(find(p, 'CNC-01').lineId).toBe('main');
    ops.removeLine(p, 'main');
    expect(find(p, 'CNC-01').lineId).toBeUndefined();
    expect(p.lines).toBeUndefined();

    const r = ops.addResource(p);
    ops.patchAsset(p, 'CNC-01', { resourceId: r });
    expect(ops.patchResource(p, r, { count: 0 })).toMatch(/≥ 1/);
    ops.patchResource(p, r, { count: 2 });
    expect(p.resources![0].count).toBe(2);
    ops.removeResource(p, r);
    expect(find(p, 'CNC-01').resourceId).toBeUndefined();

    const s = ops.addShift(p);
    expect(p.calendar).toEqual({ startHourOfDay: 6, shifts: [{ id: s, name: 'Day shift', startHour: 6, endHour: 14 }] });
    ops.patchAsset(p, 'CNC-01', { shiftId: s });
    expect(ops.patchShift(p, s, { endHour: 25 })).toMatch(/0\.\.24/);
    ops.patchShift(p, s, { id: 'day' });
    expect(find(p, 'CNC-01').shiftId).toBe('day');
    ops.removeShift(p, 'day');
    expect(find(p, 'CNC-01').shiftId).toBeUndefined();
    ops.setCalendarStart(p, 22);
    expect(p.calendar!.startHourOfDay).toBe(22);
  });
});
