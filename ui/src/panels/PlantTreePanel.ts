// Plant Explorer: Line → asset groups by kind → assets (state LED) → sensors (live value).
// Selection syncs both ways with store.selection.
import type { AssetKind, PlantModel } from '../net/contracts';
import type { Panel, PanelFactory } from './panel';
import { TreeView, type TreeNode } from '../widgets/TreeView';
import { sensorIcon, type IconName } from '../widgets/icons';
import { formatNum, limitLevel, sensorDigits } from '../shell/format';
import { openInjectFaultDialog } from '../dialogs/InjectFaultDialog';

export const KIND_ORDER: AssetKind[] = ['source', 'conveyor', 'machine', 'buffer', 'robot', 'inspection', 'sink'];
export const KIND_GROUP: Record<AssetKind, string> = {
  source: 'Sources', conveyor: 'Conveyors', machine: 'Machines', buffer: 'Buffers',
  robot: 'Robots', inspection: 'Inspection', sink: 'Sinks',
};
const KIND_ICON: Record<AssetKind, IconName> = {
  source: 'source', conveyor: 'conveyor', machine: 'machine', buffer: 'buffer',
  robot: 'robot', inspection: 'inspection', sink: 'sink',
};

export const sensorNodeId = (sensorId: string) => `sensor:${sensorId}`;
export const groupNodeId = (kind: string) => `group:${kind}`;
export const lineNodeId = (plantId: string) => `line:${plantId}`;

/** Build the explorer tree from a plant (pure). Assets keep plant order within a group. */
export function buildPlantTree(plant: PlantModel): TreeNode[] {
  const groups: TreeNode[] = [];
  for (const kind of KIND_ORDER) {
    const assets = plant.assets.filter((a) => a.kind === kind);
    if (!assets.length) continue;
    groups.push({
      id: groupNodeId(kind),
      label: `${KIND_GROUP[kind]} (${assets.length})`,
      icon: 'folder',
      iconOpen: 'folderOpen',
      cls: 'group',
      expanded: true,
      children: assets.map((a) => ({
        id: a.id,
        label: a.id,
        meta: a.name,
        title: `${a.id} — ${a.name} (${a.kind})`,
        icon: KIND_ICON[a.kind],
        led: 'off',
        expanded: false,
        children: plant.sensors.filter((s) => s.assetId === a.id).map((s) => ({
          id: sensorNodeId(s.id),
          label: s.id.slice(s.id.indexOf('.') + 1),
          meta: '',
          title: `${s.id} (${s.kind}, ${s.unit})${s.hi !== undefined ? ` hi ${s.hi}` : ''}${s.hiHi !== undefined ? ` hiHi ${s.hiHi}` : ''}`,
          icon: sensorIcon(s.kind),
        })),
      })),
    });
  }
  return [{ id: lineNodeId(plant.id), label: plant.name, icon: 'line', cls: 'root', expanded: true, children: groups }];
}

/** Asset id a tree node refers to (assets and their sensors), or null for groups/root. */
export function assetIdForNode(plant: PlantModel, nodeId: string): string | null {
  if (nodeId.startsWith('sensor:')) return plant.sensors.find((s) => sensorNodeId(s.id) === nodeId)?.assetId ?? null;
  return plant.assets.some((a) => a.id === nodeId) ? nodeId : null;
}

export const createPlantTreePanel: PanelFactory = (ctx) => {
  const { store } = ctx;
  let tree: TreeView | null = null;
  const offs: (() => void)[] = [];

  const rebuild = () => {
    if (!tree || !store.plant) return;
    tree.setNodes(buildPlantTree(store.plant));
    update();
    syncSelection();
  };

  const update = () => {
    if (!tree || !store.plant) return;
    for (const a of store.plant.assets) {
      const st = store.assets.get(a.id);
      tree.update(a.id, { led: st?.state ?? 'off' });
    }
    for (const s of store.plant.sensors) {
      const v = store.sensors.get(s.id);
      const lvl = limitLevel(v, s.hi, s.hiHi);
      tree.update(sensorNodeId(s.id), {
        meta: v === undefined ? '' : `${formatNum(v, sensorDigits(s.kind))} ${s.unit}`,
        metaClass: lvl === 'hihi' ? 'v abn-hihi' : lvl === 'hi' ? 'v abn-hi' : 'v',
      });
    }
  };

  const syncSelection = () => {
    if (!tree || !store.plant) return;
    const cur = tree.selection;
    // keep a selected sensor row if it belongs to the selected asset
    if (cur && store.selection && assetIdForNode(store.plant, cur) === store.selection) return;
    tree.select(store.selection);
  };

  const panel: Panel = {
    id: 'plant',
    title: 'Plant Explorer',
    mount(host) {
      tree = new TreeView({
        onSelect: (id) => {
          if (!store.plant) return;
          store.select(assetIdForNode(store.plant, id));
        },
        onActivate: (id) => {
          const a = store.plant && assetIdForNode(store.plant, id);
          if (a) openInjectFaultDialog(ctx, a);
        },
      });
      host.append(tree.el);
      offs.push(
        store.on('snapshot', rebuild),
        store.on('tick', update),
        store.on('selection', syncSelection),
      );
      rebuild();
    },
    dispose() {
      offs.splice(0).forEach((f) => f());
      tree?.el.remove();
      tree = null;
    },
  };
  return panel;
};
