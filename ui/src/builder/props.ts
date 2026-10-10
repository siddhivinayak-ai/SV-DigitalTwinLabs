// Plant Builder property inspector: an editable PropertyGrid (same look as widgets/PropertyGrid,
// which only edits numbers) with text, number and combo rows; plus the Sensors sub-grid tab.
import type { AssetDef, PlantModel, SensorDef, SensorKind } from '../net/contracts';
import { h, svg } from '../widgets/dom';
import { icons } from '../widgets/icons';
import { button } from '../widgets/Button';
import { DataGrid, type Column } from '../widgets/DataGrid';
import { TabStrip } from '../widgets/TabStrip';
import { parseNumeric } from '../widgets/NumericInput';
import { paramLabel, formatNum } from '../shell/format';
import type { BuilderEditor } from './editor';
import { attachCellEditing } from './gridEdit';
import { bicons } from './icons';
import {
  KIND_SPECS, REQUIRED_PARAMS, RESOURCE_KINDS, SENSOR_KINDS, SENSOR_UNITS, checkParam, kindLabel, paramRule, sensorFromTemplate, sensorSuffix,
} from './model';
import * as ops from './ops';

type RowKind = 'ro' | 'text' | 'num' | 'combo';

interface Row {
  key: string;
  label: string;
  kind: RowKind;
  value: string;
  unit?: string;
  description?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  disabled?: boolean;
  /** Commit; return an error to revert. */
  commit?: (text: string) => string | undefined | void;
  /** "…" button (collection editors). */
  ellipsis?: () => void;
  cls?: string;
}

interface Cat { name: string; rows: Row[] }

/** Classic categorised property grid with in-place editors; rebuilt on change, focus preserved. */
class EditGrid {
  readonly el: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly desc: HTMLDivElement;
  private readonly collapsed = new Set<string>();
  private selKey: string | null = null;
  private inputs = new Map<string, HTMLElement>();
  private rowsByKey = new Map<string, Row>();

  constructor() {
    this.el = h('div.bld-pg');
    const wrap = h('div.bld-pg-wrap');
    this.scroller = h('div.pgrid');
    wrap.append(this.scroller);
    this.desc = h('div.pg-desc');
    this.el.append(wrap, this.desc);
  }

  focusKey(key: string): void {
    const el = this.inputs.get(key);
    if (el) { el.focus(); if (el instanceof HTMLInputElement) el.select(); }
  }

  /** The first editable control (F6 / Enter from the plan). */
  focusFirst(): void {
    const first = this.scroller.querySelector<HTMLElement>('input:not([readonly]), select:not(:disabled)');
    first?.focus();
  }

  set(cats: Cat[]): void {
    const active = document.activeElement as HTMLElement | null;
    const focusedKey = active && this.scroller.contains(active) ? active.dataset.key ?? null : null;
    const scroll = this.scroller.scrollTop;
    this.scroller.textContent = '';
    this.inputs.clear();
    this.rowsByKey.clear();
    for (const cat of cats) {
      const header = h('div.pg-cat');
      const box = h('span.box');
      header.append(h('span.tw', null, box), h('span', { text: cat.name }));
      const body = h('div');
      const apply = () => { const c = this.collapsed.has(cat.name); box.classList.toggle('plus', c); body.style.display = c ? 'none' : ''; };
      header.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.collapsed.has(cat.name)) this.collapsed.delete(cat.name); else this.collapsed.add(cat.name);
        apply();
      });
      for (const r of cat.rows) body.append(this.row(r));
      apply();
      this.scroller.append(header, body);
    }
    this.scroller.scrollTop = scroll;
    if (focusedKey && this.inputs.has(focusedKey)) this.focusKey(focusedKey);
    this.setDesc(this.selKey ? this.rowsByKey.get(this.selKey) ?? null : null);
  }

  private row(r: Row): HTMLDivElement {
    this.rowsByKey.set(r.key, r);
    const row = h('div.pg-row');
    row.classList.add(r.kind === 'ro' || r.disabled ? 'ro' : 'editable');
    if (r.cls) row.classList.add(r.cls);
    if (r.key === this.selKey) row.classList.add('sel');
    const key = h('div.pg-key', { text: r.label, title: r.description ?? r.label });
    const val = h('div.pg-val');
    const sel = () => {
      this.scroller.querySelectorAll('.pg-row.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      this.selKey = r.key;
      this.setDesc(r);
    };
    row.addEventListener('mousedown', sel);
    if (r.kind === 'ro' || r.disabled) {
      val.append(h(`span.v${r.kind === 'num' ? '.n' : ''}`, { text: r.value }));
    } else if (r.kind === 'combo') {
      const s = h('select.pg-select', { 'data-key': r.key, 'aria-label': r.label });
      for (const o of r.options ?? []) s.append(h('option', { value: o.value, text: o.label }));
      s.value = r.value;
      s.addEventListener('focus', sel);
      s.addEventListener('change', () => { const err = r.commit?.(s.value); if (err) this.flashErr(row, err); });
      s.addEventListener('keydown', (e) => e.stopPropagation());
      val.append(s);
      this.inputs.set(r.key, s);
    } else {
      const inp = h('input.pg-edit', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'data-key': r.key, 'aria-label': r.label, placeholder: r.placeholder });
      if (r.kind === 'text') inp.classList.add('txt');
      inp.value = r.value;
      let last = r.value;
      const commit = () => {
        if (inp.value === last) { row.classList.remove('dirty', 'err'); return; }
        const err = r.commit?.(inp.value);
        if (err) { inp.value = last; this.flashErr(row, err); return; }
        last = inp.value;
        row.classList.remove('dirty');
      };
      inp.addEventListener('focus', () => { sel(); inp.select(); });
      inp.addEventListener('input', () => {
        row.classList.toggle('dirty', inp.value !== last);
        if (r.kind === 'num') row.classList.toggle('err', inp.value.trim() !== '' && parseNumeric(inp.value) === null);
      });
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { inp.value = last; row.classList.remove('dirty', 'err'); inp.blur(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const all = [...this.scroller.querySelectorAll<HTMLElement>('input.pg-edit, select.pg-select')];
          const i = all.indexOf(inp);
          all[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
      });
      inp.addEventListener('blur', commit);
      val.append(inp);
      this.inputs.set(r.key, inp);
    }
    if (r.unit !== undefined) val.append(h('span.u', { text: r.unit }));
    if (r.ellipsis) {
      const b = h('button.pg-ellipsis', { type: 'button', title: `Edit ${r.label}…`, text: '…' });
      b.addEventListener('click', () => r.ellipsis!());
      val.append(b);
    }
    row.append(h('div.gutter'), key, val);
    return row;
  }

  private flashErr(row: HTMLElement, msg: string): void {
    row.classList.add('err');
    row.title = msg;
    this.desc.textContent = '';
    this.desc.append(h('b', { text: 'Invalid value' }), h('span.err', { text: msg }));
    setTimeout(() => { row.classList.remove('err'); row.title = ''; }, 2500);
  }

  private setDesc(r: Row | null): void {
    this.desc.textContent = '';
    if (!r) { this.desc.append(h('span.dim', { text: 'Select a property to see its description.' })); return; }
    this.desc.append(h('b', { text: r.label + (r.unit ? ` (${r.unit})` : '') }), h('span', { text: r.description ?? (r.kind === 'ro' ? 'Read-only.' : 'Type a value and press Enter.') }));
  }
}

const num = (text: string, key: string, min?: number): number | string => {
  const v = parseNumeric(text);
  if (v === null) return `${key}: not a number`;
  if (min !== undefined && v < min) return `${key}: must be ≥ ${min}`;
  return v;
};

export interface PropsHooks {
  openLines(): void;
  openResources(): void;
  openShifts(): void;
}

export class PropsPanel {
  readonly el: HTMLDivElement;
  readonly tabs: TabStrip;
  private readonly grid = new EditGrid();
  private readonly sensorGrid: DataGrid<SensorDef>;
  private readonly sensorHead: HTMLDivElement;
  private readonly sensorTools: HTMLDivElement;
  private readonly sensorEdit: { edit(rowId: string, key?: string): void };
  private readonly addKind: HTMLSelectElement;
  private readonly cmdBar: HTMLDivElement;

  constructor(private readonly ed: BuilderEditor, private readonly hooks: PropsHooks) {
    this.el = h('div.bld-props');
    this.tabs = new TabStrip([{ id: 'props', label: 'Properties', icon: 'layout' }, { id: 'sensors', label: 'Sensors', icon: 'sensor' }]);
    this.el.append(this.tabs.el);

    // --- properties page
    const pp = this.tabs.page('props');
    pp.classList.add('bld-props-page');
    this.cmdBar = h('div.bld-cmdbar');
    pp.append(this.grid.el, this.cmdBar);

    // --- sensors page
    const sp = this.tabs.page('sensors');
    sp.classList.add('bld-sensors-page');
    this.sensorHead = h('div.bld-sens-head');
    this.sensorTools = h('div.panel-toolbar');
    this.addKind = h('select.bld-select', { title: 'Sensor kind to add', 'aria-label': 'Sensor kind' });
    for (const k of SENSOR_KINDS) this.addKind.append(h('option', { value: k, text: k }));
    const add = button({ icon: 'plus', text: 'Add', small: true, title: 'Add a sensor of the chosen kind', onClick: () => this.addSensor() });
    const rm = button({ icon: 'minus', text: 'Remove', small: true, title: 'Remove the selected sensor (Del)', onClick: () => this.removeSensor() });
    const std = button({ text: 'Add Standard', small: true, title: 'Add the standard sensors for this kind that are missing', onClick: () => this.addStandard() });
    this.sensorTools.append(this.addKind, add, rm, h('span.sep'), std);
    const cols: Column<SensorDef>[] = [
      { key: 'suffix', title: 'Id suffix', width: 56, text: (s) => sensorSuffix(s), sortable: false, mono: true },
      { key: 'kind', title: 'Kind', width: 70, sortable: false },
      { key: 'unit', title: 'Unit', width: 40, sortable: false },
      { key: 'noise', title: 'Noise', width: 44, align: 'right', text: (s) => formatNum(s.noise), sortable: false },
      { key: 'hi', title: 'Hi', width: 38, align: 'right', text: (s) => (s.hi === undefined ? '' : String(s.hi)), sortable: false },
      { key: 'hiHi', title: 'HiHi', width: 40, align: 'right', text: (s) => (s.hiHi === undefined ? '' : String(s.hiHi)), sortable: false,
        cellClass: (s) => (s.hi !== undefined && s.hiHi !== undefined && s.hiHi <= s.hi ? 'tx-warn' : '') },
    ];
    this.sensorGrid = new DataGrid<SensorDef>({ columns: cols, rowId: (s) => s.id, emptyText: '(no sensors — Add one)', framed: true });
    const sensorWrap = h('div.bld-sens-grid');
    sensorWrap.append(this.sensorGrid.el);
    sp.append(this.sensorHead, this.sensorTools, sensorWrap, h('div.bld-sens-hint', { text: 'Double-click or F2 to edit a cell; Tab moves to the next. Empty Hi/HiHi clears the limit.' }));
    const optNum = (label: string) => (t: string): number | undefined | string => {
      if (t.trim() === '') return undefined;
      const v = parseNumeric(t);
      return v === null ? `${label}: not a number` : v;
    };
    const patch = (s: SensorDef, p: ops.SensorPatch) => this.ed.edit(`Edit sensor ${s.id}`, (pl) => ops.patchSensor(pl, s.id, p));
    this.sensorEdit = attachCellEditing<SensorDef>(this.sensorGrid, cols, {
      suffix: { kind: 'text', get: (s) => sensorSuffix(s), set: (s, t) => patch(s, { suffix: t }) },
      kind: {
        kind: 'enum', options: [...SENSOR_KINDS], get: (s) => s.kind,
        set: (s, t) => patch(s, { kind: t as SensorKind, unit: s.unit === SENSOR_UNITS[s.kind] ? SENSOR_UNITS[t as SensorKind] : s.unit }),
      },
      unit: { kind: 'text', get: (s) => s.unit, set: (s, t) => patch(s, { unit: t }) },
      noise: { kind: 'num', get: (s) => String(s.noise), set: (s, t) => { const v = parseNumeric(t, 0); return v === null ? 'Noise must be a number ≥ 0' : patch(s, { noise: v }); } },
      hi: { kind: 'num', get: (s) => (s.hi === undefined ? '' : String(s.hi)), set: (s, t) => { const v = optNum('Hi')(t); return typeof v === 'string' ? v : patch(s, { hi: v }); } },
      hiHi: { kind: 'num', get: (s) => (s.hiHi === undefined ? '' : String(s.hiHi)), set: (s, t) => { const v = optNum('HiHi')(t); return typeof v === 'string' ? v : patch(s, { hiHi: v }); } },
    }, (id) => this.ed.plant.sensors.find((s) => s.id === id), (m) => this.ed.status(m, 'error'));
    this.sensorGrid.el.addEventListener('keydown', (e) => {
      if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); this.removeSensor(); }
      else if (e.key === 'Insert') { e.preventDefault(); e.stopPropagation(); this.addSensor(); }
    });

    this.tabs.activate('props');
    ed.on('change', () => this.refresh());
    ed.on('selection', () => this.refresh());
    this.refresh();
  }

  dispose(): void { this.sensorGrid.dispose(); }

  /** Focus the property grid (Enter on the plan). */
  activate(key = 'id'): void {
    this.tabs.activate('props');
    this.grid.focusKey(key);
  }

  focusFirst(): void {
    if (this.tabs.active === 'sensors') this.sensorGrid.el.focus();
    else this.grid.focusFirst();
  }

  private sensorsFor(id: string): SensorDef[] { return this.ed.plant.sensors.filter((s) => s.assetId === id); }

  private refresh(): void {
    const ed = this.ed;
    const p = ed.plant;
    const sel = ed.selection;
    const a = sel.length === 1 ? ed.asset(sel[0]) : undefined;
    this.cmdBar.textContent = '';
    if (a) this.grid.set(this.assetCats(p, a));
    else if (sel.length > 1) this.grid.set(this.multiCats(p, sel));
    else this.grid.set(this.plantCats(p));
    if (!a) {
      const mk = (label: string, icon: keyof typeof bicons, fn: () => void, title: string) => {
        const b = button({ text: label, small: true, title, onClick: fn });
        b.prepend(svg(bicons[icon]));
        return b;
      };
      this.cmdBar.append(
        mk('Lines…', 'lines', () => this.hooks.openLines(), 'Edit production lines'),
        mk('Resources…', 'resources', () => this.hooks.openResources(), 'Edit shared resources (operators, AGVs, tools)'),
        mk('Shifts…', 'shifts', () => this.hooks.openShifts(), 'Edit the shift calendar'),
      );
    }
    this.cmdBar.style.display = a ? 'none' : '';

    // sensors tab
    this.sensorHead.textContent = '';
    if (a) {
      const list = this.sensorsFor(a.id);
      this.sensorHead.append(svg(icons.sensor), h('b', { text: a.id }), h('span.dim', { text: ` · ${list.length} sensor${list.length === 1 ? '' : 's'}` }));
      this.sensorGrid.setRows(list);
      this.sensorTools.querySelectorAll('button, select').forEach((b) => ((b as HTMLButtonElement).disabled = false));
    } else {
      this.sensorHead.append(h('span.dim', { text: sel.length > 1 ? 'Select a single asset to edit its sensors.' : 'Select an asset to edit its sensors.' }));
      this.sensorGrid.setRows([]);
      this.sensorTools.querySelectorAll('button, select').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    }
  }

  private addSensor(): void {
    const id = this.ed.primary;
    if (!id || this.ed.selection.length !== 1) return;
    const kind = this.addKind.value as SensorKind;
    let sid: string | { error: string } = '';
    this.ed.edit(`Add sensor to ${id}`, (p) => { sid = ops.addSensor(p, id, kind, SENSOR_UNITS[kind]); if (typeof sid !== 'string') return sid.error; });
    if (typeof sid === 'string' && sid) { this.sensorGrid.select(sid); this.ed.status(`Added ${sid}`, 'ok'); this.sensorEdit.edit(sid, 'suffix'); }
  }

  private removeSensor(): void {
    const sid = this.sensorGrid.selection;
    if (!sid) { this.ed.status('Select a sensor to remove', 'error'); return; }
    if (!this.ed.edit(`Remove sensor ${sid}`, (p) => ops.removeSensor(p, sid))) this.ed.status(`Removed ${sid}`, 'ok');
  }

  private addStandard(): void {
    const a = this.ed.asset(this.ed.primary);
    if (!a) return;
    const have = new Set(this.sensorsFor(a.id).map((s) => s.id));
    const missing = KIND_SPECS[a.kind].sensors.map((t) => sensorFromTemplate(a.id, t)).filter((s) => !have.has(s.id));
    if (!missing.length) { this.ed.status(`${a.id} already has all standard sensors`); return; }
    this.ed.edit(`Add standard sensors to ${a.id}`, (p) => { p.sensors.push(...missing); });
    this.ed.status(`Added ${missing.map((s) => s.id).join(', ')}`, 'ok');
  }

  // ---------- categories ----------

  private refOptions(list: { id: string; name: string }[] | undefined): { value: string; label: string }[] {
    return [{ value: '', label: '(none)' }, ...(list ?? []).map((x) => ({ value: x.id, label: `${x.id} — ${x.name}` }))];
  }

  private assetCats(p: PlantModel, a: AssetDef): Cat[] {
    const ed = this.ed;
    const id = a.id;
    const upstream = p.assets.filter((o) => o.downstream.includes(id)).map((o) => o.id);
    const edit = (label: string, fn: (pl: PlantModel) => ops.OpResult) => ed.edit(`${label} ${id}`, fn);
    const canRes = RESOURCE_KINDS.includes(a.kind);
    const spec = KIND_SPECS[a.kind];
    const keys = [...new Set([...REQUIRED_PARAMS[a.kind], ...Object.keys(spec.params), ...Object.keys(a.params)])];
    const nSensors = this.sensorsFor(id).length;

    return [
      {
        name: 'Design', rows: [
          { key: 'id', label: '(Id)', kind: 'text', value: id, description: 'Unique asset id (A-Z a-z 0-9 . _ -). Renaming updates downstream lists and sensor ids.', commit: (t) => ed.rename(id, t) },
          { key: 'name', label: 'Name', kind: 'text', value: a.name, description: 'Display name.', commit: (t) => edit('Rename', (pl) => ops.patchAsset(pl, id, { name: t })) },
          { key: 'kind', label: 'Kind', kind: 'ro', value: kindLabel(a.kind), description: spec.description },
        ],
      },
      {
        name: 'Layout', rows: [
          { key: 'x', label: 'Position X', kind: 'num', unit: 'm', value: String(a.position.x), description: 'Centre of the footprint along the plant X axis.', commit: (t) => { const v = num(t, 'X'); return typeof v === 'string' ? v : edit('Move', (pl) => ops.setPosition(pl, id, v, a.position.z)); } },
          { key: 'z', label: 'Position Z', kind: 'num', unit: 'm', value: String(a.position.z), description: 'Centre of the footprint along the plant Z axis (down in the plan).', commit: (t) => { const v = num(t, 'Z'); return typeof v === 'string' ? v : edit('Move', (pl) => ops.setPosition(pl, id, a.position.x, v)); } },
          { key: 'rot', label: 'Rotation', kind: 'num', unit: '°', value: String(a.rotationY), description: 'Rotation about the vertical axis in degrees, counter-clockwise in the plan. R / Shift+R rotate by 90°.', commit: (t) => { const v = num(t, 'Rotation'); return typeof v === 'string' ? v : edit('Rotate', (pl) => ops.setRotation(pl, id, v)); } },
          { key: 'sx', label: 'Size X (length)', kind: 'num', unit: 'm', value: String(a.size.x), description: 'Footprint length along the flow direction. For conveyors this also sets lengthM.', commit: (t) => { const v = num(t, 'Size X'); return typeof v === 'string' ? v : edit('Resize', (pl) => ops.resizeAsset(pl, id, { x: v })); } },
          { key: 'sz', label: 'Size Z (width)', kind: 'num', unit: 'm', value: String(a.size.z), description: 'Footprint width.', commit: (t) => { const v = num(t, 'Size Z'); return typeof v === 'string' ? v : edit('Resize', (pl) => ops.resizeAsset(pl, id, { z: v })); } },
          { key: 'sy', label: 'Size Y (height)', kind: 'num', unit: 'm', value: String(a.size.y), description: 'Height of the 3D model box.', commit: (t) => { const v = num(t, 'Size Y'); return typeof v === 'string' ? v : edit('Resize', (pl) => ops.resizeAsset(pl, id, { y: v })); } },
        ],
      },
      {
        name: 'Flow', rows: [
          { key: 'down', label: 'Downstream', kind: 'text', value: a.downstream.join(', '), placeholder: a.kind === 'sink' ? '(sink)' : '(none)', description: 'Comma-separated ids this asset feeds, in round-robin order. The Connect tool (C) draws these.', disabled: a.kind === 'sink', commit: (t) => edit('Set downstream of', (pl) => ops.setDownstream(pl, id, t.split(','))) },
          { key: 'up', label: 'Upstream', kind: 'ro', value: upstream.join(', ') || '(none)', description: 'Assets that feed this one.' },
        ],
      },
      {
        name: 'Assignment', rows: [
          { key: 'line', label: 'Line', kind: 'combo', value: a.lineId ?? '', options: this.refOptions(p.lines), description: 'Production line for per-line KPIs. Edit lines with nothing selected.', commit: (v) => edit('Set line of', (pl) => ops.patchAsset(pl, id, { lineId: v })) },
          { key: 'res', label: 'Resource', kind: 'combo', value: a.resourceId ?? '', options: this.refOptions(p.resources), disabled: !canRes && !a.resourceId, description: canRes ? 'Shared resource held for each cycle (operator, AGV, tool).' : 'Only machines, robots and inspection stations can use a resource.', commit: (v) => edit('Set resource of', (pl) => ops.patchAsset(pl, id, { resourceId: v })) },
          { key: 'shift', label: 'Shift', kind: 'combo', value: a.shiftId ?? '', options: this.refOptions(p.calendar?.shifts), description: 'The asset is Off outside this shift window.', commit: (v) => edit('Set shift of', (pl) => ops.patchAsset(pl, id, { shiftId: v })) },
          { key: 'mesh', label: 'Mesh', kind: 'text', value: a.mesh ?? '', placeholder: '(procedural)', description: 'glTF/GLB URL such as /api/meshes/{id}/file. Empty uses the procedural model.', commit: (t) => edit('Set mesh of', (pl) => ops.patchAsset(pl, id, { mesh: t.trim() })) },
        ],
      },
      {
        name: 'Parameters', rows: keys.map((k): Row => {
          const { label, unit } = paramLabel(k);
          const rule = paramRule(k);
          const cur = a.params[k];
          const bad = cur !== undefined ? checkParam(k, cur) : REQUIRED_PARAMS[a.kind].includes(k) ? 'required' : null;
          return {
            key: `p.${k}`, label, kind: 'num', unit: unit === 'frac' ? '' : unit, value: cur === undefined ? '' : String(cur),
            placeholder: spec.params[k] !== undefined ? `(default ${spec.params[k]})` : '(unset)', cls: bad ? 'hint-bad' : undefined,
            description: `${k}${rule ? ` — valid range ${rule.hint}` : ''}${REQUIRED_PARAMS[a.kind].includes(k) ? ' — required' : ''}.${bad ? ` Currently invalid: ${bad}.` : ''} Clear the value to remove the parameter.`,
            commit: (t) => {
              if (t.trim() === '') return edit(`Clear ${k} of`, (pl) => ops.setParam(pl, id, k, undefined));
              const v = parseNumeric(t);
              if (v === null) return `${label}: not a number`;
              const why = checkParam(k, v);
              if (why) ed.status(`${id}.${k}: ${why} (kept; the validator will flag it)`, 'error');
              return edit(`Set ${k} of`, (pl) => ops.setParam(pl, id, k, v));
            },
          };
        }),
      },
      {
        name: 'Sensors', rows: [
          { key: 'sensors', label: 'Sensors', kind: 'ro', value: `${nSensors} (${this.sensorsFor(id).map(sensorSuffix).join(', ') || 'none'})`, description: 'Open the Sensors tab to add, remove or edit limits.', ellipsis: () => { this.tabs.activate('sensors'); this.sensorGrid.el.focus(); } },
        ],
      },
    ];
  }

  private multiCats(p: PlantModel, ids: string[]): Cat[] {
    const ed = this.ed;
    const list = ids.map((i) => ed.asset(i)!).filter(Boolean);
    const common = (f: (a: AssetDef) => string | undefined) => { const v = new Set(list.map((a) => f(a) ?? '')); return v.size === 1 ? [...v][0] : '\u0000'; };
    const opts = (l: { id: string; name: string }[] | undefined, cur: string) => {
      const o = this.refOptions(l);
      return cur === '\u0000' ? [{ value: '\u0000', label: '(mixed)' }, ...o] : o;
    };
    const setAll = (field: 'lineId' | 'resourceId' | 'shiftId') => (v: string) => {
      if (v === '\u0000') return;
      return ed.edit(`Set ${field} of ${ids.length} assets`, (pl) => {
        for (const id of ids) {
          const a = pl.assets.find((x) => x.id === id)!;
          if (field === 'resourceId' && v && !RESOURCE_KINDS.includes(a.kind)) continue;
          const r = ops.patchAsset(pl, id, { [field]: v });
          if (r) return r;
        }
      });
    };
    const line = common((a) => a.lineId), res = common((a) => a.resourceId), shift = common((a) => a.shiftId);
    return [
      { name: 'Selection', rows: [
        { key: 'count', label: 'Assets', kind: 'ro', value: String(ids.length) },
        { key: 'ids', label: 'Ids', kind: 'ro', value: ids.join(', '), description: 'R rotates the group, arrows nudge, Ctrl+L connects in selection order.' },
      ] },
      { name: 'Assignment (all selected)', rows: [
        { key: 'line', label: 'Line', kind: 'combo', value: line, options: opts(p.lines, line), commit: setAll('lineId') },
        { key: 'res', label: 'Resource', kind: 'combo', value: res, options: opts(p.resources, res), description: 'Applied to machines, robots and inspection stations only.', commit: setAll('resourceId') },
        { key: 'shift', label: 'Shift', kind: 'combo', value: shift, options: opts(p.calendar?.shifts, shift), commit: setAll('shiftId') },
      ] },
    ];
  }

  private plantCats(p: PlantModel): Cat[] {
    const ed = this.ed;
    const flows = p.assets.reduce((n, a) => n + a.downstream.length, 0);
    return [
      { name: 'Plant', rows: [
        { key: 'pid', label: '(Id)', kind: 'text', value: p.id, description: 'Plant id.', commit: (t) => ed.edit('Set plant id', (pl) => ops.patchPlant(pl, { id: t.trim() })) },
        { key: 'pname', label: 'Name', kind: 'text', value: p.name, description: 'Plant name shown in the console title.', commit: (t) => ed.edit('Set plant name', (pl) => ops.patchPlant(pl, { name: t })) },
        { key: 'seed', label: 'Seed', kind: 'num', value: String(p.seed), description: 'Random seed: the same seed and commands give identical results.', commit: (t) => { const v = parseNumeric(t); return v === null || !Number.isInteger(v) ? 'Seed must be an integer' : ed.edit('Set seed', (pl) => ops.patchPlant(pl, { seed: v })); } },
        { key: 'ver', label: 'Version', kind: 'ro', value: String(p.version) },
      ] },
      { name: 'Contents', rows: [
        { key: 'na', label: 'Assets', kind: 'ro', value: String(p.assets.length) },
        { key: 'ns', label: 'Sensors', kind: 'ro', value: String(p.sensors.length) },
        { key: 'nf', label: 'Flows', kind: 'ro', value: String(flows) },
        ...(p.connections?.length || p.bindings?.length ? [{ key: 'nb', label: 'Connections / bindings', kind: 'ro' as const, value: `${p.connections?.length ?? 0} / ${p.bindings?.length ?? 0}`, description: 'v0.2 OPC UA / MQTT connections are kept as-is.' }] : []),
      ] },
      { name: 'Organisation', rows: [
        { key: 'lines', label: 'Lines', kind: 'ro', value: (p.lines ?? []).map((l) => l.id).join(', ') || '(none)', description: 'Production lines (labelling groups with per-line KPIs).', ellipsis: () => this.hooks.openLines() },
        { key: 'resources', label: 'Resources', kind: 'ro', value: (p.resources ?? []).map((r) => `${r.id}×${r.count}`).join(', ') || '(none)', description: 'Shared operators, AGVs and tools.', ellipsis: () => this.hooks.openResources() },
        { key: 'shifts', label: 'Shifts', kind: 'ro', value: (p.calendar?.shifts ?? []).map((s) => `${s.id} ${s.startHour}–${s.endHour}`).join(', ') || '(none)', description: 'Shift calendar; sim t=0 is startHourOfDay of day 1.', ellipsis: () => this.hooks.openShifts() },
        { key: 'start', label: 'Calendar start hour', kind: 'num', unit: 'h', value: p.calendar ? String(p.calendar.startHourOfDay) : '', placeholder: '(no calendar)', description: 'Hour of day at sim t=0.', commit: (t) => { const v = parseNumeric(t); return v === null ? 'Start hour must be a number' : ed.edit('Set calendar start', (pl) => ops.setCalendarStart(pl, v)); } },
      ] },
    ];
  }
}
