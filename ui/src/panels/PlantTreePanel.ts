// Plant Explorer: Plant → (v0.3: Line →) asset groups by kind → assets (state LED) → sensors (live value),
// plus v0.3 Resources and Shifts nodes. Selection syncs both ways with store.selection.
import type { AssetDef, AssetKind, PlantModel, ResourceKind } from '../net/contracts';
import type { Panel, PanelFactory } from './panel';
import { TreeView, type TreeNode } from '../widgets/TreeView';
import { sensorIcon, type IconName } from '../widgets/icons';
import { formatNum, limitLevel, sensorDigits } from '../shell/format';
import { openInjectFaultDialog } from '../dialogs/InjectFaultDialog';
import { hourOfDay, inShiftWindow } from '../viewport/v03';

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
/** v0.3 node ids. */
export const prodLineNodeId = (lineId: string) => `pline:${lineId}`;
export const UNASSIGNED_NODE = 'pline:~unassigned';
export const lineGroupNodeId = (lineId: string, kind: string) => `group:${lineId}:${kind}`;
export const resourceNodeId = (id: string) => `res:${id}`;
export const shiftNodeId = (id: string) => `shift:${id}`;
export const RESOURCES_NODE = 'folder:resources';
export const SHIFTS_NODE = 'folder:shifts';

const RES_KIND_LABEL: Record<ResourceKind, string> = { operator: 'operator', agv: 'AGV', tool: 'tool' };

function assetNode(plant: PlantModel, a: AssetDef): TreeNode {
  const extra: string[] = [];
  if (a.resourceId) extra.push(`resource ${a.resourceId}`);
  if (a.shiftId) extra.push(`shift ${a.shiftId}`);
  if (a.mesh) extra.push('custom mesh');
  return {
    id: a.id,
    label: a.id,
    meta: a.name,
    title: `${a.id} — ${a.name} (${a.kind})${extra.length ? `\n${extra.join(' · ')}` : ''}`,
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
  };
}

/** Kind groups (in flow order) for a set of assets; `groupId` names each group node. */
function kindGroups(plant: PlantModel, assets: AssetDef[], groupId: (kind: AssetKind) => string, expanded: boolean): TreeNode[] {
  const groups: TreeNode[] = [];
  for (const kind of KIND_ORDER) {
    const list = assets.filter((a) => a.kind === kind);
    if (!list.length) continue;
    groups.push({
      id: groupId(kind),
      label: `${KIND_GROUP[kind]} (${list.length})`,
      icon: 'folder',
      iconOpen: 'folderOpen',
      cls: 'group',
      expanded,
      children: list.map((a) => assetNode(plant, a)),
    });
  }
  return groups;
}

/** v0.3: assets grouped by line (plant line order), with assets lacking a known line under "(Unassigned)". */
export function groupByLine(plant: PlantModel): { lineId: string | null; name: string; assets: AssetDef[] }[] {
  const lines = plant.lines ?? [];
  const known = new Set(lines.map((l) => l.id));
  const out: { lineId: string | null; name: string; assets: AssetDef[] }[] = lines.map((l) => ({
    lineId: l.id, name: l.name || l.id, assets: plant.assets.filter((a) => a.lineId === l.id),
  }));
  const rest = plant.assets.filter((a) => !a.lineId || !known.has(a.lineId));
  if (rest.length) out.push({ lineId: null, name: '(Unassigned)', assets: rest });
  return out;
}

const pad2 = (h: number) => String(h).padStart(2, '0');

/** Build the explorer tree from a plant (pure). Assets keep plant order within a group. */
export function buildPlantTree(plant: PlantModel): TreeNode[] {
  let children: TreeNode[];
  if (plant.lines?.length) {
    children = groupByLine(plant).map((g) => ({
      id: g.lineId ? prodLineNodeId(g.lineId) : UNASSIGNED_NODE,
      label: `${g.name} (${g.assets.length})`,
      title: g.lineId ? `Line ${g.name} (${g.lineId})` : 'Assets without a line',
      icon: 'line' as IconName,
      cls: g.lineId ? 'pline' : 'pline unassigned',
      expanded: true,
      children: kindGroups(plant, g.assets, (k) => lineGroupNodeId(g.lineId ?? '~', k), false),
    }));
  } else {
    children = kindGroups(plant, plant.assets, groupNodeId, true);
  }

  if (plant.resources?.length) {
    children.push({
      id: RESOURCES_NODE,
      label: `Resources (${plant.resources.length})`,
      icon: 'folder',
      iconOpen: 'folderOpen',
      cls: 'group',
      expanded: true,
      children: plant.resources.map((r) => {
        const users = plant.assets.filter((a) => a.resourceId === r.id).map((a) => a.id);
        return {
          id: resourceNodeId(r.id),
          label: r.name || r.id,
          meta: `${r.count} × ${RES_KIND_LABEL[r.kind] ?? r.kind}`,
          title: `${r.name} (${r.id}): ${r.count} × ${r.kind}\nUsed by: ${users.join(', ') || '—'}`,
          cls: `res res-${r.kind}`,
        };
      }),
    });
  }
  const shifts = plant.calendar?.shifts ?? [];
  if (shifts.length) {
    children.push({
      id: SHIFTS_NODE,
      label: `Shifts (${shifts.length})`,
      icon: 'folder',
      iconOpen: 'folderOpen',
      cls: 'group',
      title: `Calendar: sim t = 0 is ${pad2(plant.calendar!.startHourOfDay)}:00 of day 1`,
      expanded: true,
      children: shifts.map((s) => {
        const users = plant.assets.filter((a) => a.shiftId === s.id).map((a) => a.id);
        return {
          id: shiftNodeId(s.id),
          label: s.name || s.id,
          meta: `${pad2(s.startHour)}–${pad2(s.endHour)} h`,
          title: `${s.name} (${s.id}): ${pad2(s.startHour)}:00–${pad2(s.endHour)}:00${s.endHour < s.startHour ? ' (wraps midnight)' : ''}\nAssets: ${users.join(', ') || '—'}`,
          led: 'off',
          cls: 'shift',
        };
      }),
    });
  }
  return [{ id: lineNodeId(plant.id), label: plant.name, icon: 'line', cls: 'root', expanded: true, children }];
}

/** Asset id a tree node refers to (assets and their sensors), or null for groups/root/lines/resources/shifts. */
export function assetIdForNode(plant: PlantModel, nodeId: string): string | null {
  if (nodeId.startsWith('sensor:')) return plant.sensors.find((s) => sensorNodeId(s.id) === nodeId)?.assetId ?? null;
  return plant.assets.some((a) => a.id === nodeId) ? nodeId : null;
}

const RES_GLYPH: Record<ResourceKind, string> = {
  operator: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="4" r="2.6" fill="#e8c39e" stroke="currentColor"/><path d="M3 15v-3.5a5 5 0 0 1 10 0V15z" fill="#3a6ea5" stroke="currentColor"/></svg>',
  agv: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="6.5" width="13" height="5" fill="#edb120" stroke="currentColor"/><rect x="4.5" y="3.5" width="5" height="3" fill="#d9b67a" stroke="currentColor"/><circle cx="4.5" cy="12.5" r="1.6" fill="currentColor"/><circle cx="11.5" cy="12.5" r="1.6" fill="currentColor"/></svg>',
  tool: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M10.8 1.6a3.6 3.6 0 0 0-4.3 4.7L1.8 11a1.4 1.4 0 0 0 2 2l4.8-4.7a3.6 3.6 0 0 0 4.7-4.3l-2 2-2.2-.4-.4-2.2z" fill="#a3aab1" stroke="currentColor" stroke-linejoin="round"/></svg>',
};
const SHIFT_GLYPH = '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="var(--c-field)" stroke="currentColor"/><path d="M8 4v4.5l3 1.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

export const createPlantTreePanel: PanelFactory = (ctx) => {
  const { store } = ctx;
  let tree: TreeView | null = null;
  const offs: (() => void)[] = [];

  const rebuild = () => {
    if (!tree || !store.plant) return;
    tree.setNodes(buildPlantTree(store.plant));
    decorate();
    update();
    kpi();
    syncSelection();
  };

  /** Resource and shift rows get glyphs that are not part of the shared icon set. */
  const decorate = () => {
    if (!tree || !store.plant) return;
    const icon = (id: string) => tree!.el.querySelector<HTMLElement>(`.tree-row[data-id="${CSS.escape(id)}"] .ticon`);
    for (const r of store.plant.resources ?? []) { const i = icon(resourceNodeId(r.id)); if (i) i.innerHTML = RES_GLYPH[r.kind] ?? RES_GLYPH.tool; }
    for (const s of store.plant.calendar?.shifts ?? []) { const i = icon(shiftNodeId(s.id)); if (i) i.innerHTML = SHIFT_GLYPH; }
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
    const cal = store.plant.calendar;
    if (cal) {
      const hr = hourOfDay(cal, store.sim.simTimeMs);
      for (const s of cal.shifts) tree.update(shiftNodeId(s.id), { led: inShiftWindow(s, hr) ? 'running' : 'off' });
    }
  };

  /** Resource rows: count and kind, plus live utilisation when the KPI report carries it. */
  const kpi = () => {
    if (!tree || !store.plant) return;
    for (const r of store.plant.resources ?? []) {
      const k = store.kpi?.resources?.find((x) => x.resourceId === r.id);
      const base = `${r.count} × ${RES_KIND_LABEL[r.kind] ?? r.kind}`;
      tree.update(resourceNodeId(r.id), { meta: k ? `${base} · ${(k.utilization * 100).toFixed(0)} %` : base });
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
        store.on('kpi', kpi),
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
