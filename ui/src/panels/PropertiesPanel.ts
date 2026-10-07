// Properties: WinForms-PropertyGrid view of the selected asset. Identity, live state, KPI,
// sensors (limit-coloured) and editable parameters (Enter → asset.params, revert on error).
import type { AssetDef, PlantModel } from '../net/contracts';
import type { Panel, PanelFactory } from './panel';
import { PropertyGrid, type PgCategory } from '../widgets/PropertyGrid';
import { ComboBox } from '../widgets/ComboBox';
import { button, setChecked } from '../widgets/Button';
import { h } from '../widgets/dom';
import { formatDuration, formatNum, limitLevel, paramLabel, sensorDigits } from '../shell/format';
import { runCommand } from '../shell/actions';
import { openInjectFaultDialog } from '../dialogs/InjectFaultDialog';

const PARAM_HELP: Record<string, string> = {
  arrivalIntervalS: 'Mean time between raw part releases.',
  arrivalStdS: 'Standard deviation of the release interval.',
  lengthM: 'Conveyor length. Transit time = length / speed.',
  speedMps: 'Belt speed.',
  capacity: 'Maximum number of parts held.',
  cycleTimeS: 'Mean processing time per part.',
  cycleTimeStdS: 'Standard deviation of the cycle time.',
  mtbfS: 'Mean time between failures (wear increases the hazard).',
  mttrS: 'Mean time to repair after a fault.',
  scrapRate: 'Probability (0–1) that a finished part is scrapped.',
  ratedKw: 'Electrical power when running at full load.',
  idleKw: 'Electrical power when idle.',
  ambientC: 'Ambient temperature the asset cools towards.',
  tempRiseC: 'Temperature rise above ambient at full load.',
  vibBaselineMms: 'Vibration baseline when running with zero wear.',
};

// ---- v0.3 identity rows (feature/ui-library). Read-only here; the Plant Builder edits them.
type V03Key = 'lineId' | 'resourceId' | 'shiftId' | 'mesh';

/** v0.3 identity rows to show: only when the plant uses the concept or the asset sets the field. */
export function v03IdentityRows(plant: PlantModel | null, def: AssetDef): { key: V03Key; label: string; description: string }[] {
  const rows: { key: V03Key; label: string; description: string }[] = [];
  const ro = ' Read-only here: edit it in the Plant Builder.';
  if (plant?.lines?.length || def.lineId) rows.push({ key: 'lineId', label: 'Line', description: 'Production line the asset belongs to (labelling group for per-line KPIs).' + ro });
  if (plant?.resources?.length || def.resourceId) rows.push({ key: 'resourceId', label: 'Resource', description: 'Shared resource needed for each cycle; the asset is Starved while no unit is free.' + ro });
  if (plant?.calendar?.shifts.length || def.shiftId) rows.push({ key: 'shiftId', label: 'Shift', description: 'Shift the asset runs in; it is Off outside the shift window.' + ro });
  if (def.mesh || plant?.assets.some((a) => a.mesh)) rows.push({ key: 'mesh', label: 'Mesh', description: 'Custom glTF/GLB model shown in the 3D view (procedural model when empty). Manage files in Tools > Mesh Library.' + ro });
  return rows;
}

/** Display text for a v0.3 identity row (name plus id, or an em dash). */
export function v03IdentityText(plant: PlantModel | null, def: AssetDef, key: V03Key): string {
  const pad = (h: number) => String(h).padStart(2, '0');
  switch (key) {
    case 'lineId': {
      const l = def.lineId ? plant?.lines?.find((x) => x.id === def.lineId) : undefined;
      return def.lineId ? (l ? `${l.name} (${l.id})` : `${def.lineId} (unknown)`) : '(none)';
    }
    case 'resourceId': {
      const r = def.resourceId ? plant?.resources?.find((x) => x.id === def.resourceId) : undefined;
      return def.resourceId ? (r ? `${r.name} (${r.count} × ${r.kind})` : `${def.resourceId} (unknown)`) : '(none)';
    }
    case 'shiftId': {
      const sh = def.shiftId ? plant?.calendar?.shifts.find((x) => x.id === def.shiftId) : undefined;
      return def.shiftId ? (sh ? `${sh.name} (${pad(sh.startHour)}–${pad(sh.endHour)} h)` : `${def.shiftId} (unknown)`) : '(always on)';
    }
    case 'mesh': return def.mesh ?? '(procedural)';
  }
}

export const createPropertiesPanel: PanelFactory = (ctx) => {
  const { store, source } = ctx;
  const offs: (() => void)[] = [];
  let grid: PropertyGrid;
  let picker: ComboBox<string>;
  let btnFault: HTMLButtonElement, btnClear: HTMLButtonElement, btnMaint: HTMLButtonElement, btnEnable: HTMLButtonElement;
  let shown: string | null = null;

  const sensorKey = (id: string) => `sensor.${id}`;
  const paramKey = (k: string) => `param.${k}`;

  const build = () => {
    const def = store.selection ? store.assetDef(store.selection) : undefined;
    shown = def?.id ?? null;
    syncPicker();
    if (!def) {
      grid.setEmpty(store.plant ? 'Select an asset in the Plant Explorer, the 3D view or the Data Grid.' : 'Waiting for plant data…');
      updateButtons();
      return;
    }
    const sensors = store.sensorDefsFor(def.id);
    const cats: PgCategory[] = [
      {
        name: 'Identity',
        rows: [
          { key: 'id', label: 'Id', kind: 'text' },
          { key: 'name', label: 'Name', kind: 'text' },
          { key: 'kind', label: 'Kind', kind: 'text' },
          { key: 'downstream', label: 'Downstream', kind: 'text', description: 'Assets that receive parts from this one (round-robin when several).' },
          ...v03IdentityRows(store.plant, def).map((r) => ({ key: `v03.${r.key}`, label: r.label, kind: 'text' as const, description: r.description })),
        ],
      },
      {
        name: 'Live State',
        rows: [
          { key: 'state', label: 'State', kind: 'state', description: 'PackML-style state. Grey = normal; colour = active or abnormal.' },
          { key: 'inState', label: 'Time in state', kind: 'num' },
          { key: 'load', label: 'Load', kind: 'meter', unit: '%' },
          { key: 'wear', label: 'Wear', kind: 'meter', unit: '%', description: 'Accumulated wear; raises fault hazard and vibration. Reset to 20 % on repair.' },
          { key: 'cycle', label: 'Cycle progress', kind: 'meter', unit: '%' },
          { key: 'wip', label: 'WIP', kind: 'num', unit: 'pcs' },
          { key: 'good', label: 'Good', kind: 'num', unit: 'pcs' },
          { key: 'scrap', label: 'Scrap', kind: 'num', unit: 'pcs' },
        ],
      },
    ];
    if (['machine', 'robot', 'inspection'].includes(def.kind)) {
      cats.push({
        name: 'KPI',
        rows: [
          { key: 'kpi.oee', label: 'OEE', kind: 'num', unit: '%', description: 'Availability × Performance × Quality.' },
          { key: 'kpi.availability', label: 'Availability', kind: 'num', unit: '%' },
          { key: 'kpi.performance', label: 'Performance', kind: 'num', unit: '%' },
          { key: 'kpi.quality', label: 'Quality', kind: 'num', unit: '%' },
          { key: 'kpi.utilization', label: 'Utilisation', kind: 'num', unit: '%' },
        ],
      });
    }
    if (sensors.length) {
      cats.push({
        name: 'Sensors',
        rows: sensors.map((s) => ({
          key: sensorKey(s.id), label: s.id.slice(s.id.indexOf('.') + 1) + ` (${s.kind})`, kind: 'num' as const, unit: s.unit,
          description: `${s.id}${s.hi !== undefined ? ` — hi ${s.hi} ${s.unit}` : ''}${s.hiHi !== undefined ? `, hiHi ${s.hiHi} ${s.unit}` : ''}. Coloured amber beyond hi and red beyond hiHi.`,
        })),
      });
    }
    const keys = Object.keys(def.params);
    if (keys.length) {
      cats.push({
        name: 'Parameters',
        rows: keys.map((k) => {
          const { label, unit } = paramLabel(k);
          return { key: paramKey(k), label, unit, editable: true, min: 0, max: k === 'scrapRate' ? 1 : undefined, description: `${PARAM_HELP[k] ?? k} Type a value and press Enter to apply (Esc reverts).` };
        }),
      });
    }
    grid.setCategories(cats);
    grid.setValue('id', def.id);
    grid.setValue('name', def.name);
    grid.setValue('kind', def.kind);
    grid.setValue('downstream', def.downstream.join(', ') || '—');
    for (const r of v03IdentityRows(store.plant, def)) grid.setValue(`v03.${r.key}`, v03IdentityText(store.plant, def, r.key));
    writeParams(def);
    tick();
    kpi();
  };

  const writeParams = (def: AssetDef) => {
    for (const [k, v] of Object.entries(def.params)) grid.setValue(paramKey(k), formatNum(v));
  };

  const tick = () => {
    if (!shown) return;
    const st = store.assets.get(shown);
    if (st) {
      grid.setState('state', st.state, st.state.toUpperCase());
      grid.setValue('inState', formatDuration(store.sim.simTimeMs - st.stateSinceMs));
      grid.setValue('load', (st.load * 100).toFixed(0));
      grid.setMeter('load', st.load, st.load > 0 ? 'run' : null);
      grid.setValue('wear', (st.wear * 100).toFixed(1), st.wear >= 0.8 ? 'val-hihi' : st.wear >= 0.6 ? 'val-hi' : '');
      grid.setMeter('wear', st.wear, st.wear >= 0.8 ? 'bad' : st.wear >= 0.6 ? 'warn' : null);
      grid.setValue('cycle', (st.cycleProgress * 100).toFixed(0));
      grid.setMeter('cycle', st.cycleProgress, null);
      grid.setValue('wip', String(st.wip));
      grid.setValue('good', String(st.good));
      grid.setValue('scrap', String(st.scrap));
    }
    for (const s of store.sensorDefsFor(shown)) {
      const v = store.sensors.get(s.id);
      const lvl = limitLevel(v, s.hi, s.hiHi);
      grid.setValue(sensorKey(s.id), formatNum(v, sensorDigits(s.kind)), lvl === 'hihi' ? 'val-hihi' : lvl === 'hi' ? 'val-hi' : '');
    }
    updateButtons();
  };

  const kpi = () => {
    if (!shown) return;
    const k = store.kpi?.assets.find((a) => a.assetId === shown);
    const f = (v?: number) => (v === undefined ? '—' : (v * 100).toFixed(1));
    grid.setValue('kpi.oee', f(k?.oee));
    grid.setValue('kpi.availability', f(k?.availability));
    grid.setValue('kpi.performance', f(k?.performance));
    grid.setValue('kpi.quality', f(k?.quality));
    grid.setValue('kpi.utilization', f(k?.utilization));
  };

  const updateButtons = () => {
    const st = shown ? store.assets.get(shown)?.state : undefined;
    const has = !!shown;
    btnFault.disabled = !has || st === 'fault';
    btnClear.disabled = st !== 'fault';
    btnMaint.disabled = !has;
    btnEnable.disabled = !has;
    setChecked(btnMaint, st === 'maintenance');
    setChecked(btnEnable, has && st !== 'off');
    btnMaint.title = st === 'maintenance' ? 'End maintenance' : 'Put the asset into maintenance';
    btnEnable.title = st === 'off' ? 'Enable the asset' : 'Disable (switch off) the asset';
  };

  const syncPicker = () => {
    const items = (store.plant?.assets ?? []).map((a) => ({ value: a.id, label: `${a.id}  ${a.name}` }));
    picker.setItems([{ value: '', label: '(none)' }, ...items], store.selection ?? '');
  };

  const commitParam = async (key: string, value: number): Promise<true | string> => {
    if (!shown || !key.startsWith('param.')) return 'No asset selected';
    const param = key.slice(6);
    const ack = await runCommand(source, { action: 'asset.params', assetId: shown, params: { [param]: value } }, `Set ${shown}.${param} = ${value}`);
    return ack.ok ? true : (ack.error ?? 'Rejected');
  };

  const panel: Panel = {
    id: 'properties',
    title: 'Properties',
    mount(host) {
      const root = h('div.props');
      picker = new ComboBox<string>({ items: [], title: 'Selected object', onChange: (id) => store.select(id || null) });
      const top = h('div.props-top', null, picker.el);
      const gridWrap = h('div.props-grid');
      grid = new PropertyGrid({ onCommit: commitParam });
      gridWrap.append(grid.el);
      btnFault = button({ text: 'Inject Fault…', icon: 'fault', small: true, onClick: () => openInjectFaultDialog(ctx, shown) });
      btnClear = button({ text: 'Clear', icon: 'clearFault', small: true, title: 'Clear fault', onClick: () => shown && runCommand(source, { action: 'asset.clearFault', assetId: shown }) });
      btnMaint = button({ text: 'Maint.', icon: 'maintenance', small: true, onClick: () => {
        if (!shown) return;
        const on = store.assets.get(shown)?.state !== 'maintenance';
        void runCommand(source, { action: 'asset.maintenance', assetId: shown, value: on ? 1 : 0 });
      } });
      btnEnable = button({ text: 'Enabled', icon: 'power', small: true, onClick: () => {
        if (!shown) return;
        const enable = store.assets.get(shown)?.state === 'off';
        void runCommand(source, { action: 'asset.enable', assetId: shown, value: enable ? 1 : 0 });
      } });
      const actions = h('div.props-actions', null, btnFault, btnClear, btnMaint, btnEnable);
      root.append(top, gridWrap, actions);
      host.append(root);
      offs.push(
        store.on('selection', build),
        store.on('snapshot', build),
        store.on('tick', tick),
        store.on('kpi', kpi),
        store.on('params', (p) => { if (p.assetId === shown) { const d = store.assetDef(p.assetId); if (d) writeParams(d); } }),
      );
      build();
    },
    dispose() {
      offs.splice(0).forEach((f) => f());
    },
  };
  return panel;
};
