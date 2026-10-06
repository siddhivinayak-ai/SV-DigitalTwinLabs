import { describe, expect, it } from 'vitest';
import samplePlant from '../../../contracts/plant/sample_line.json';
import type { PlantModel } from '../net/contracts';
import { assetIdForNode, buildPlantTree, sensorNodeId } from './PlantTreePanel';
import { flattenVisible } from '../widgets/TreeView';

const plant = samplePlant as unknown as PlantModel;

describe('buildPlantTree', () => {
  const tree = buildPlantTree(plant);
  const root = tree[0];

  it('has a single line root named after the plant', () => {
    expect(tree).toHaveLength(1);
    expect(root.label).toBe(plant.name);
    expect(root.id).toBe(`line:${plant.id}`);
  });

  it('groups assets by kind in flow order with counts', () => {
    expect(root.children!.map((g) => g.label)).toEqual([
      'Sources (1)', 'Conveyors (2)', 'Machines (4)', 'Buffers (1)', 'Robots (1)', 'Inspection (1)', 'Sinks (1)',
    ]);
    const machines = root.children!.find((g) => g.id === 'group:machine')!;
    expect(machines.children!.map((a) => a.id)).toEqual(['CNC-01', 'CNC-02', 'ASSY-01', 'PACK-01']);
  });

  it('includes every asset exactly once, each with a state LED', () => {
    const assets = root.children!.flatMap((g) => g.children!);
    expect(assets.map((a) => a.id).sort()).toEqual(plant.assets.map((a) => a.id).sort());
    expect(assets.every((a) => a.led === 'off')).toBe(true);
  });

  it('puts sensors under their asset', () => {
    const cnc = root.children!.flatMap((g) => g.children!).find((a) => a.id === 'CNC-01')!;
    expect(cnc.children!.map((s) => s.id)).toEqual(['CNC-01.temp', 'CNC-01.vib', 'CNC-01.power', 'CNC-01.current'].map(sensorNodeId));
    expect(cnc.children!.map((s) => s.label)).toEqual(['temp', 'vib', 'power', 'current']);
    const totalSensors = root.children!.flatMap((g) => g.children!).reduce((n, a) => n + (a.children?.length ?? 0), 0);
    expect(totalSensors).toBe(plant.sensors.length);
  });

  it('maps tree nodes back to asset ids', () => {
    expect(assetIdForNode(plant, 'CNC-02')).toBe('CNC-02');
    expect(assetIdForNode(plant, sensorNodeId('QC-01.rejects'))).toBe('QC-01');
    expect(assetIdForNode(plant, 'group:machine')).toBeNull();
    expect(assetIdForNode(plant, `line:${plant.id}`)).toBeNull();
  });

  it('flattens only expanded branches', () => {
    const expanded = new Set([root.id, 'group:machine']);
    const flat = flattenVisible(tree, (n) => expanded.has(n.id));
    expect(flat[0]).toMatchObject({ depth: 0, parent: null });
    expect(flat).toHaveLength(1 + 7 + 4);
    expect(flat.find((f) => f.node.id === 'CNC-01')).toMatchObject({ depth: 2, parent: 'group:machine', hasChildren: true });
  });
});
