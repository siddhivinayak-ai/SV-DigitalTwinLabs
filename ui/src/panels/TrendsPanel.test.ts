import { describe, expect, it } from 'vitest';
import samplePlant from '../../../contracts/plant/sample_line.json';
import type { PlantModel } from '../net/contracts';
import { groupByAsset, pickAutoSensors } from './TrendsPanel';

const plant = samplePlant as unknown as PlantModel;

describe('TrendsPanel sensor selection', () => {
  it('auto-selects the live signals of the selected asset, not its counters', () => {
    expect(pickAutoSensors(plant.sensors, 'CNC-01')).toEqual(['CNC-01.temp', 'CNC-01.vib', 'CNC-01.power', 'CNC-01.current']);
    expect(pickAutoSensors(plant.sensors, 'QC-01')).not.toContain('QC-01.rejects');
  });

  it('falls back to counters when an asset has nothing else', () => {
    expect(pickAutoSensors(plant.sensors, 'SNK-01')).toEqual(['SNK-01.good']);
    expect(pickAutoSensors(plant.sensors, 'SRC-01')).toEqual([]);
  });

  it('groups the sensor list by asset in plant order', () => {
    const g = groupByAsset(plant.sensors);
    expect([...g.keys()][0]).toBe('CONV-01');
    expect(g.get('BUF-01')?.map((s) => s.id)).toEqual(['BUF-01.level']);
    expect([...g.values()].reduce((n, l) => n + l.length, 0)).toBe(plant.sensors.length);
  });
});
