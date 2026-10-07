import { describe, expect, it } from 'vitest';
import samplePlant from '../../../contracts/plant/sample_line.json';
import type { PlantModel } from '../net/contracts';
import {
  KINDS, KIND_SPECS, checkParam, createAsset, defaultSensors, kindPrefix, newPlant, nextId, normalizePlant, prefixOf, sensorSuffix,
} from './model';
import { validatePlant } from './validate';

const sample = samplePlant as unknown as PlantModel;

describe('id generation', () => {
  it('continues after the highest number with two-digit padding', () => {
    expect(nextId(['CNC-01', 'CNC-02'], 'CNC')).toBe('CNC-03');
    expect(nextId([], 'ROB')).toBe('ROB-01');
    expect(nextId(['CNC-09'], 'CNC')).toBe('CNC-10');
    expect(nextId(['CNC-01', 'CNC-07'], 'CNC')).toBe('CNC-08');
    expect(nextId(['QC-01', 'QCX-05'], 'QC')).toBe('QC-02');
  });

  it('uses the standard prefix per kind and M as fallback', () => {
    expect(KINDS.map(kindPrefix)).toEqual(['SRC', 'CONV', 'CNC', 'BUF', 'ROB', 'QC', 'SNK']);
    expect(kindPrefix('weird')).toBe('M');
  });

  it('extracts prefixes', () => {
    expect(prefixOf('CNC-03')).toBe('CNC');
    expect(prefixOf('PACK-01')).toBe('PACK');
    expect(prefixOf('M12')).toBe('M');
    expect(prefixOf('Dock')).toBe('Dock');
  });

  it('createAsset picks a fresh id next to the sample line', () => {
    const { asset } = createAsset('machine', 3, 4, sample.assets.map((a) => a.id));
    expect(asset.id).toBe('CNC-03');
    expect(asset.position).toEqual({ x: 3, y: 0, z: 4 });
  });
});

describe('defaults per kind', () => {
  it('mirror the sample line sensors (ids, kinds, units, limits)', () => {
    const pairs: [string, (typeof KINDS)[number]][] = [['CNC-01', 'machine'], ['ROB-01', 'robot'], ['QC-01', 'inspection'], ['BUF-01', 'buffer'], ['CONV-01', 'conveyor'], ['SNK-01', 'sink']];
    for (const [id, kind] of pairs) {
      const expected = sample.sensors.filter((s) => s.assetId === id);
      expect(defaultSensors(id, kind)).toEqual(expected);
    }
    expect(defaultSensors('SRC-02', 'source')).toEqual([]);
  });

  it('mirror the sample line params and sizes', () => {
    const cnc = sample.assets.find((a) => a.id === 'CNC-01')!;
    expect(KIND_SPECS.machine.params).toEqual(cnc.params);
    expect(KIND_SPECS.machine.size).toEqual(cnc.size);
    const conv = sample.assets.find((a) => a.id === 'CONV-01')!;
    expect(KIND_SPECS.conveyor.params).toEqual(conv.params);
  });

  it('sensor ids follow <ASSET>.<suffix>', () => {
    const s = defaultSensors('CNC-07', 'machine');
    expect(s.map((x) => x.id)).toEqual(['CNC-07.temp', 'CNC-07.vib', 'CNC-07.power', 'CNC-07.current']);
    expect(sensorSuffix(s[0])).toBe('temp');
  });

  it('every kind default passes the param rules', () => {
    for (const k of KINDS) for (const [key, v] of Object.entries(KIND_SPECS[k].params)) expect(checkParam(key, v)).toBeNull();
  });
});

describe('param rules', () => {
  it('match ParamValidator', () => {
    expect(checkParam('capacity', 0)).toMatch(/integer/);
    expect(checkParam('capacity', 2.5)).toMatch(/integer/);
    expect(checkParam('cycleTimeS', 0)).toMatch(/> 0/);
    expect(checkParam('cycleTimeStdS', 0)).toBeNull();
    expect(checkParam('scrapRate', 1)).toMatch(/< 1/);
    expect(checkParam('ambientC', -5)).toBeNull();
    expect(checkParam('warmupS', 0)).toMatch(/> 0/);
  });
});

describe('new plant & normalize', () => {
  it('New is a valid source → sink plant', () => {
    const p = newPlant();
    expect(p.assets.map((a) => a.kind)).toEqual(['source', 'sink']);
    expect(validatePlant(p).ok).toBe(true);
  });

  it('normalize fills missing fields and rejects non-plants', () => {
    const p = normalizePlant({ assets: [{ id: 'X', kind: 'buffer' }] });
    expect(p.assets[0].downstream).toEqual([]);
    expect(p.assets[0].size).toEqual(KIND_SPECS.buffer.size);
    expect(p.sensors).toEqual([]);
    expect(() => normalizePlant({ foo: 1 })).toThrow(/assets/);
    expect(() => normalizePlant(null)).toThrow();
  });
});
