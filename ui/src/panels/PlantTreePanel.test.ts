import { describe, expect, it } from 'vitest';
import samplePlant from '../../../contracts/plant/sample_line.json';
import type { PlantModel } from '../net/contracts';
import plantV03 from '../../../contracts/examples/plant.v03.json';
import {
  assetIdForNode, buildPlantTree, groupByLine, prodLineNodeId, RESOURCES_NODE, resourceNodeId, sensorNodeId, SHIFTS_NODE, shiftNodeId, UNASSIGNED_NODE,
} from './PlantTreePanel';
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

describe('buildPlantTree (v0.3 lines, resources, shifts)', () => {
  const v03 = plantV03 as unknown as PlantModel;
  const tree = buildPlantTree(v03);
  const root = tree[0];

  it('groups Plant → Line → kind → asset, with (Unassigned) last before resources and shifts', () => {
    expect(root.children!.map((n) => n.id)).toEqual([
      prodLineNodeId('line-a'), prodLineNodeId('line-b'), UNASSIGNED_NODE, RESOURCES_NODE, SHIFTS_NODE,
    ]);
    expect(root.children!.map((n) => n.label)).toEqual(['Line A (2)', 'Line B (1)', '(Unassigned) (1)', 'Resources (1)', 'Shifts (2)']);
    const a = root.children![0];
    expect(a.children!.map((g) => g.id)).toEqual(['group:line-a:source', 'group:line-a:machine']);
    expect(a.children![1].children!.map((x) => x.id)).toEqual(['CNC-A']);
    expect(root.children![2].children![0].children!.map((x) => x.id)).toEqual(['SNK']);
  });

  it('lists every asset exactly once', () => {
    const ids: string[] = [];
    const walk = (ns: typeof tree) => ns.forEach((n) => { if (v03.assets.some((a) => a.id === n.id)) ids.push(n.id); if (n.children) walk(n.children); });
    walk(tree);
    expect(ids.sort()).toEqual(v03.assets.map((a) => a.id).sort());
  });

  it('describes resources and shifts', () => {
    const res = root.children!.find((n) => n.id === RESOURCES_NODE)!.children!;
    expect(res).toMatchObject([{ id: resourceNodeId('op-pool'), label: 'Operators', meta: '2 × operator' }]);
    expect(res[0].title).toContain('CNC-A');
    const sh = root.children!.find((n) => n.id === SHIFTS_NODE)!.children!;
    expect(sh.map((s) => [s.id, s.meta])).toEqual([[shiftNodeId('day'), '06–14 h'], [shiftNodeId('night'), '22–06 h']]);
    expect(sh[1].title).toContain('wraps midnight');
  });

  it('puts assets with unknown line ids under (Unassigned) and never maps v0.3 nodes to assets', () => {
    const g = groupByLine({ ...v03, assets: v03.assets.map((a) => (a.id === 'SRC-B' ? { ...a, lineId: 'ghost' } : a)) });
    expect(g.map((x) => [x.lineId, x.assets.map((a) => a.id)])).toEqual([['line-a', ['SRC-A', 'CNC-A']], ['line-b', []], [null, ['SRC-B', 'SNK']]]);
    for (const id of [prodLineNodeId('line-a'), UNASSIGNED_NODE, RESOURCES_NODE, resourceNodeId('op-pool'), shiftNodeId('day')]) expect(assetIdForNode(v03, id)).toBeNull();
  });

  it('keeps the v0.1 layout for plants without lines', () => {
    expect(buildPlantTree(plant)[0].children!.every((g) => g.id.startsWith('group:') && g.id.split(':').length === 2)).toBe(true);
  });
});
