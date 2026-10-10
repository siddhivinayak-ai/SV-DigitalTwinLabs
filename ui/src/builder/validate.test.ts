import { describe, expect, it } from 'vitest';
import samplePlant from '../../../contracts/plant/sample_line.json';
import v03 from '../../../contracts/examples/plant.v03.json';
import type { PlantModel } from '../net/contracts';
import { issuesByAsset, validatePlant } from './validate';
import * as ops from './ops';

const sample = () => JSON.parse(JSON.stringify(samplePlant)) as PlantModel;
const codes = (p: PlantModel) => validatePlant(p).issues.map((i) => `${i.code}:${i.assetId ?? ''}`);
const find = (p: PlantModel, id: string) => p.assets.find((a) => a.id === id)!;

describe('local validator', () => {
  it('the sample line and the v0.3 example are valid', () => {
    const r = validatePlant(sample());
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    const r2 = validatePlant(JSON.parse(JSON.stringify(v03)) as PlantModel);
    expect(r2.ok).toBe(true);
  });

  it('EMPTY_PLANT', () => {
    expect(codes({ ...sample(), assets: [], sensors: [] })).toEqual(['EMPTY_PLANT:']);
  });

  it('NO_SOURCE / NO_SINK', () => {
    const p = sample();
    ops.deleteAssets(p, ['SRC-01']);
    expect(codes(p)).toContain('NO_SOURCE:');
    const q = sample();
    ops.deleteAssets(q, ['SNK-01']);
    expect(codes(q)).toContain('NO_SINK:');
    expect(codes(q)).toContain('DEAD_END:PACK-01');
  });

  it('UNKNOWN_DOWNSTREAM', () => {
    const p = sample();
    find(p, 'BUF-01').downstream.push('NOPE');
    expect(codes(p)).toEqual(['UNKNOWN_DOWNSTREAM:BUF-01']);
  });

  it('CYCLE and SELF_LOOP', () => {
    const p = sample();
    find(p, 'ROB-01').downstream.push('BUF-01');
    const c = validatePlant(p).issues.filter((i) => i.code === 'CYCLE');
    expect(c).toHaveLength(1);
    expect(c[0].message).toMatch(/BUF-01 → ROB-01 → BUF-01/);
    const q = sample();
    find(q, 'BUF-01').downstream.push('BUF-01');
    expect(codes(q)).toEqual(['SELF_LOOP:BUF-01']);
  });

  it('DEAD_END, UNREACHABLE, NO_SINK_REACHABLE', () => {
    const p = sample();
    ops.addAsset(p, 'machine', 0, 10); // CNC-03: orphan, no downstream
    expect(codes(p)).toEqual(['DEAD_END:CNC-03', 'UNREACHABLE:CNC-03']);
    const q = sample();
    ops.addAsset(q, 'buffer', 0, 10); // BUF-02
    ops.addAsset(q, 'buffer', 4, 10); // BUF-03
    ops.connect(q, 'CONV-01', 'BUF-02');
    ops.connect(q, 'BUF-02', 'BUF-03');
    ops.connect(q, 'BUF-03', 'BUF-02');
    const cs = codes(q);
    expect(cs).toContain('NO_SINK_REACHABLE:BUF-02');
    expect(cs).toContain('NO_SINK_REACHABLE:BUF-03');
    expect(cs).toContain('CYCLE:BUF-02');
    expect(cs).not.toContain('UNREACHABLE:BUF-02');
  });

  it('DUPLICATE_ID for assets and sensors', () => {
    const p = sample();
    p.assets.push({ ...find(p, 'BUF-01'), position: { x: 0, y: 0, z: 20 } });
    p.sensors.push({ ...p.sensors[0] });
    const cs = codes(p);
    expect(cs).toContain('DUPLICATE_ID:BUF-01');
    expect(cs).toContain('DUPLICATE_ID:CONV-01');
  });

  it('OVERLAP is a warning and does not block', () => {
    const p = sample();
    find(p, 'CNC-02').position.z = -1; // into CNC-01
    const r = validatePlant(p);
    expect(r.issues).toEqual([{ severity: 'warning', code: 'OVERLAP', message: 'CNC-01 overlaps CNC-02', assetId: 'CNC-01' }]);
    expect(r.ok).toBe(true);
    // rotated footprints: a 90° CONV-02 now pokes into ASSY-01/QC-01? No: shorten first, then rotate is clear
    const q = sample();
    find(q, 'CONV-02').rotationY = 90;
    expect(codes(q).filter((c) => c.startsWith('OVERLAP'))).toEqual([]);
  });

  it('touching footprints do not overlap', () => {
    const p = sample();
    find(p, 'CNC-02').position.z = -0.5; // CNC-01 spans z -3.3..-1.1; CNC-02 now -1.6..0.6
    expect(codes(p).filter((c) => c.startsWith('OVERLAP'))).toEqual(['OVERLAP:CNC-01']);
    find(p, 'CNC-02').position.z = 0; // CNC-02 now -1.1..1.1: touching CNC-01
    expect(codes(p).filter((c) => c.startsWith('OVERLAP'))).toEqual([]); find(p, 'CNC-01').position.z = -2.2;
    expect(codes(p).filter((c) => c.startsWith('OVERLAP'))).toEqual([]);
  });

  it('params, refs, resources, shifts, limits, sensors, mesh', () => {
    const p = sample();
    delete find(p, 'CNC-01').params.cycleTimeS;
    find(p, 'BUF-01').params.capacity = 0;
    find(p, 'CONV-01').resourceId = 'op';
    find(p, 'CNC-02').shiftId = 'night';
    p.resources = [{ id: 'op', name: 'Ops', kind: 'operator', count: 0 }];
    p.calendar = { startHourOfDay: 6, shifts: [{ id: 'x', name: 'X', startHour: 8, endHour: 8 }] };
    p.sensors.find((s) => s.id === 'CNC-02.temp')!.hiHi = 60;
    p.sensors = p.sensors.filter((s) => s.assetId !== 'ROB-01');
    find(p, 'QC-01').mesh = 'http://x/y.glb';
    const cs = codes(p);
    for (const c of ['MISSING_PARAM:CNC-01', 'BAD_PARAM:BUF-01', 'RESOURCE_KIND:CONV-01', 'UNKNOWN_REF:CNC-02', 'BAD_RESOURCE_COUNT:', 'BAD_SHIFT:', 'LIMIT_ORDER:CNC-02', 'NO_SENSORS:ROB-01', 'MESH_URL:QC-01']) {
      expect(cs).toContain(c);
    }
  });

  it('issuesByAsset keeps the worst severity', () => {
    const m = issuesByAsset([
      { severity: 'warning', code: 'OVERLAP', message: '', assetId: 'A' },
      { severity: 'critical', code: 'DEAD_END', message: '', assetId: 'A' },
      { severity: 'warning', code: 'OVERLAP', message: '', assetId: 'B' },
      { severity: 'info', code: 'X', message: '', assetId: 'C' },
    ]);
    expect([...m]).toEqual([['A', 'critical'], ['B', 'warning']]);
  });
});
