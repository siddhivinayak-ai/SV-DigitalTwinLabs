// Data Grid: one live, sortable row per asset (state, load, wear, wip, counts, OEE).
// Rows are recycled; each tick only rewrites cell text.
import type { AssetDef, AssetState } from '../net/contracts';
import type { Panel, PanelFactory } from './panel';
import type { TwinStore } from '../state/store';
import { DataGrid } from '../widgets/DataGrid';
import { h, setText, setPrefixedClass } from '../widgets/dom';
import { formatDuration } from '../shell/format';

export interface AssetRow { def: AssetDef; st?: AssetState; oee?: number; stateMs: number }

export function assetRows(store: TwinStore): AssetRow[] {
  const now = store.sim.simTimeMs;
  return (store.plant?.assets ?? []).map((def) => {
    const st = store.assets.get(def.id);
    return { def, st, oee: store.kpi?.assets.find((k) => k.assetId === def.id)?.oee, stateMs: st ? now - st.stateSinceMs : 0 };
  });
}

const pct = (v: number | undefined, d = 1) => (v === undefined ? '' : (v * 100).toFixed(d));

function barCell(cell: HTMLElement, frac: number | undefined, warnAt = 2, badAt = 2): void {
  let bar = cell.querySelector<HTMLElement>('.bar');
  let txt = cell.querySelector<HTMLElement>('.ct');
  if (!bar) {
    bar = h('span.bar', null, h('i'));
    txt = h('span.ct');
    cell.append(bar, txt);
  }
  const f = frac ?? 0;
  const w = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
  const i = bar.firstElementChild as HTMLElement;
  if (i.style.width !== w) i.style.width = w;
  const cls = 'bar' + (f >= badAt ? ' bad' : f >= warnAt ? ' warn' : '');
  if (bar.className !== cls) bar.className = cls;
  setText(txt!, frac === undefined ? '' : (f * 100).toFixed(1));
}

export const createDataGridPanel: PanelFactory = (ctx) => {
  const { store } = ctx;
  const offs: (() => void)[] = [];
  let grid: DataGrid<AssetRow>;

  const refresh = () => grid.setRows(assetRows(store));

  const panel: Panel = {
    id: 'grid',
    title: 'Data Grid',
    mount(host) {
      const root = h('div.panel-col');
      const body = h('div.panel-fill');
      grid = new DataGrid<AssetRow>({
        storageKey: 'svdtl.grid.assets.v1',
        emptyText: 'Waiting for plant data…',
        rowId: (r) => r.def.id,
        onSelect: (r) => store.select(r?.def.id ?? null),
        columns: [
          { key: 'id', title: 'Asset', width: 70, text: (r) => r.def.id },
          { key: 'name', title: 'Name', width: 168, text: (r) => r.def.name },
          { key: 'kind', title: 'Kind', width: 72, text: (r) => r.def.kind },
          {
            key: 'state', title: 'State', width: 104, sortKey: (r) => r.st?.state ?? '',
            render: (cell, r) => {
              let led = cell.querySelector<HTMLElement>('.led');
              let txt = cell.querySelector<HTMLElement>('.ct');
              if (!led) { led = h('span.led'); txt = h('span.ct'); cell.append(led, txt); }
              const s = r.st?.state ?? 'off';
              setPrefixedClass(led, 'st-', s);
              led.classList.toggle('blink', s === 'fault');
              led.classList.toggle('blocked', s === 'blocked');
              setText(txt!, s.toUpperCase());
              const c = s === 'fault' ? 'ct tx-fault' : 'ct';
              if (txt!.className !== c) txt!.className = c;
            },
          },
          { key: 'inState', title: 'In state', width: 70, align: 'right', text: (r) => (r.st ? formatDuration(r.stateMs) : ''), sortKey: (r) => r.stateMs },
          { key: 'load', title: 'Load %', width: 54, align: 'right', text: (r) => pct(r.st?.load, 0), sortKey: (r) => r.st?.load },
          { key: 'wear', title: 'Wear %', width: 96, align: 'right', sortKey: (r) => r.st?.wear, render: (c, r) => barCell(c, r.st?.wear, 0.6, 0.8) },
          { key: 'wip', title: 'WIP', width: 44, align: 'right', text: (r) => String(r.st?.wip ?? ''), sortKey: (r) => r.st?.wip },
          { key: 'good', title: 'Good', width: 58, align: 'right', text: (r) => String(r.st?.good ?? ''), sortKey: (r) => r.st?.good },
          { key: 'scrap', title: 'Scrap', width: 52, align: 'right', text: (r) => String(r.st?.scrap ?? ''), sortKey: (r) => r.st?.scrap },
          { key: 'cycle', title: 'Cycle %', width: 58, align: 'right', text: (r) => (['machine', 'robot', 'inspection'].includes(r.def.kind) ? pct(r.st?.cycleProgress, 0) : ''), sortKey: (r) => r.st?.cycleProgress },
          { key: 'oee', title: 'OEE %', width: 58, align: 'right', text: (r) => pct(r.oee), sortKey: (r) => r.oee },
        ],
      });
      body.append(grid.el);
      root.append(body);
      host.append(root);
      offs.push(
        store.on('snapshot', refresh),
        store.on('tick', refresh),
        store.on('kpi', refresh),
        store.on('selection', (id) => grid.select(id, true)),
      );
      refresh();
      grid.select(store.selection, false);
    },
    resize() { grid?.refresh(); },
    dispose() {
      offs.splice(0).forEach((f) => f());
      grid?.dispose();
    },
  };
  return panel;
};
