// Plant Builder dialogs: Lines / Resources / Shifts collection editors (DataGrid + Add/Remove with
// in-place editing; every change is an undoable document edit), template and layout pickers,
// Save As, and confirmation boxes.
import type { LayoutSummary, LineDef, PlantModel, ResourceDef, ResourceKind, ShiftDef, TemplateInfo, ValidationIssue } from '../net/contracts';
import { Dialog } from '../widgets/Dialog';
import { DataGrid, type Column } from '../widgets/DataGrid';
import { button } from '../widgets/Button';
import { h, svg } from '../widgets/dom';
import { icons, type IconName } from '../widgets/icons';
import { parseNumeric } from '../widgets/NumericInput';
import type { BuilderEditor } from './editor';
import { attachCellEditing, type CellEditor } from './gridEdit';
import * as ops from './ops';

// ---------------- collection editors ----------------

interface CollectionSpec<T extends { id: string }> {
  title: string;
  icon: IconName;
  intro: string;
  columns: Column<T>[];
  editors: Record<string, CellEditor<T>>;
  rows(p: PlantModel): T[];
  add(p: PlantModel): string;
  remove(p: PlantModel, id: string): ops.OpResult;
  usage(p: PlantModel, id: string): number;
  extra?: (ed: BuilderEditor) => HTMLElement;
}

function collectionDialog<T extends { id: string }>(ed: BuilderEditor, spec: CollectionSpec<T>): Dialog {
  const grid = new DataGrid<T>({ columns: spec.columns, rowId: (r) => r.id, emptyText: '(none — click Add)', framed: true });
  const gridBox = h('div.bld-coll-grid');
  gridBox.append(grid.el);
  const status = h('div.bld-coll-status');
  const cell = attachCellEditing(grid, spec.columns, spec.editors, (id) => spec.rows(ed.plant).find((r) => r.id === id), (m) => { status.textContent = m; status.classList.add('err'); });
  const add = button({ icon: 'plus', text: 'Add', small: true, onClick: () => {
    let id = '';
    ed.doc.edit(`Add to ${spec.title}`, (p) => { id = spec.add(p); });
    refresh();
    grid.select(id);
    cell.edit(id, spec.columns[1]?.key ?? spec.columns[0].key);
  } });
  const remove = button({ icon: 'minus', text: 'Remove', small: true, onClick: () => {
    const id = grid.selection;
    if (!id) { status.textContent = 'Select a row to remove.'; return; }
    const n = spec.usage(ed.plant, id);
    const err = ed.edit(`Remove ${id}`, (p) => spec.remove(p, id));
    status.classList.toggle('err', !!err);
    status.textContent = err ?? (n ? `Removed ${id}; cleared it from ${n} asset${n > 1 ? 's' : ''}.` : `Removed ${id}.`);
    refresh();
  } });
  const tools = h('div.bld-coll-tools', null, add, remove, h('span.grow'), h('span.dim', { text: 'Double-click or F2 edits a cell' }));
  const body = h('div.bld-coll', null, h('p.dlg-note', { text: spec.intro }), tools, gridBox, status);
  if (spec.extra) body.insertBefore(spec.extra(ed), tools);
  const refresh = () => {
    const rows = spec.rows(ed.plant).map((r) => ({ ...r }));
    grid.setRows(rows);
  };
  const offChange = ed.on('change', () => { refresh(); });
  grid.el.addEventListener('keydown', (e) => {
    if (e.key === 'Insert') { e.preventDefault(); e.stopPropagation(); add.click(); }
    if (e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); remove.click(); }
  });
  const dlg = Dialog.open({
    title: spec.title, icon: spec.icon, body, width: 520,
    buttons: [{ id: 'close', text: 'Close', isDefault: true, isCancel: true }],
    onClose: () => { offChange(); grid.dispose(); },
  });
  refresh();
  setTimeout(() => grid.el.focus(), 0);
  return dlg;
}

const textCell = <T>(get: (r: T) => string, set: (r: T, v: string) => string | void): CellEditor<T> => ({ kind: 'text', get, set });

const usageOf = (field: 'lineId' | 'resourceId' | 'shiftId') => (p: PlantModel, id: string) => p.assets.filter((a) => a[field] === id).length;

export function openLinesDialog(ed: BuilderEditor): Dialog {
  const patch = (r: LineDef, x: Partial<LineDef>) => ed.edit(`Edit line ${r.id}`, (p) => ops.patchLine(p, r.id, x));
  const used = usageOf('lineId');
  return collectionDialog<LineDef>(ed, {
    title: 'Lines', icon: 'line',
    intro: 'Lines group assets for per-line KPIs. Flows may cross lines. Assign assets in the property grid (Line).',
    columns: [
      { key: 'id', title: 'Id', width: 120, mono: true, sortable: false },
      { key: 'name', title: 'Name', width: 220, sortable: false },
      { key: 'assets', title: 'Assets', width: 70, align: 'right', sortable: false, text: (r) => String(used(ed.plant, r.id)) },
    ],
    editors: {
      id: textCell((r) => r.id, (r, v) => patch(r, { id: v.trim() })),
      name: textCell((r) => r.name, (r, v) => patch(r, { name: v })),
    },
    rows: (p) => p.lines ?? [],
    add: (p) => ops.addLine(p),
    remove: (p, id) => ops.removeLine(p, id),
    usage: used,
  });
}

export function openResourcesDialog(ed: BuilderEditor): Dialog {
  const patch = (r: ResourceDef, x: Partial<ResourceDef>) => ed.edit(`Edit resource ${r.id}`, (p) => ops.patchResource(p, r.id, x));
  const used = usageOf('resourceId');
  return collectionDialog<ResourceDef>(ed, {
    title: 'Resources', icon: 'maintenance',
    intro: 'A machine, robot or inspection asset with a resource needs one free unit for each whole cycle; otherwise it waits (Starved).',
    columns: [
      { key: 'id', title: 'Id', width: 96, mono: true, sortable: false },
      { key: 'name', title: 'Name', width: 160, sortable: false },
      { key: 'kind', title: 'Kind', width: 80, sortable: false },
      { key: 'count', title: 'Count', width: 56, align: 'right', sortable: false },
      { key: 'assets', title: 'Assets', width: 60, align: 'right', sortable: false, text: (r) => String(used(ed.plant, r.id)) },
    ],
    editors: {
      id: textCell((r) => r.id, (r, v) => patch(r, { id: v.trim() })),
      name: textCell((r) => r.name, (r, v) => patch(r, { name: v })),
      kind: { kind: 'enum', options: ['operator', 'agv', 'tool'], get: (r) => r.kind, set: (r, v) => patch(r, { kind: v as ResourceKind }) },
      count: { kind: 'num', get: (r) => String(r.count), set: (r, v) => { const n = parseNumeric(v); return n === null ? 'Count must be a number' : patch(r, { count: n }); } },
    },
    rows: (p) => p.resources ?? [],
    add: (p) => ops.addResource(p),
    remove: (p, id) => ops.removeResource(p, id),
    usage: used,
  });
}

export function openShiftsDialog(ed: BuilderEditor): Dialog {
  const patch = (r: ShiftDef, x: Partial<ShiftDef>) => ed.edit(`Edit shift ${r.id}`, (p) => ops.patchShift(p, r.id, x));
  const used = usageOf('shiftId');
  const hour = (label: string, k: 'startHour' | 'endHour'): CellEditor<ShiftDef> => ({
    kind: 'num', get: (r) => String(r[k]),
    set: (r, v) => { const n = parseNumeric(v); return n === null ? `${label} must be a number` : patch(r, { [k]: n }); },
  });
  const hh = (v: number) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
  return collectionDialog<ShiftDef>(ed, {
    title: 'Shifts', icon: 'reset',
    intro: 'An asset with a shift is Off outside its window (its cycle pauses). A window with end < start wraps midnight (22 → 6).',
    columns: [
      { key: 'id', title: 'Id', width: 86, mono: true, sortable: false },
      { key: 'name', title: 'Name', width: 140, sortable: false },
      { key: 'startHour', title: 'Start h', width: 60, align: 'right', sortable: false },
      { key: 'endHour', title: 'End h', width: 60, align: 'right', sortable: false },
      { key: 'window', title: 'Window', width: 94, sortable: false, mono: true, text: (r) => `${hh(r.startHour)}–${hh(r.endHour)}${r.endHour < r.startHour ? ' +1' : ''}` },
      { key: 'assets', title: 'Assets', width: 52, align: 'right', sortable: false, text: (r) => String(used(ed.plant, r.id)) },
    ],
    editors: {
      id: textCell((r) => r.id, (r, v) => patch(r, { id: v.trim() })),
      name: textCell((r) => r.name, (r, v) => patch(r, { name: v })),
      startHour: hour('Start', 'startHour'),
      endHour: hour('End', 'endHour'),
    },
    rows: (p) => p.calendar?.shifts ?? [],
    add: (p) => ops.addShift(p),
    remove: (p, id) => ops.removeShift(p, id),
    usage: used,
    extra: (e) => {
      const inp = h('input.field.num', { type: 'text', style: 'width:56px', 'aria-label': 'Calendar start hour' });
      const sync = () => { inp.value = e.plant.calendar ? String(e.plant.calendar.startHourOfDay) : ''; inp.placeholder = '6'; };
      sync();
      const commit = () => {
        const v = parseNumeric(inp.value);
        if (v === null) { sync(); return; }
        if (e.plant.calendar?.startHourOfDay !== v) e.edit('Set calendar start', (p) => ops.setCalendarStart(p, v));
        sync();
      };
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); commit(); } });
      inp.addEventListener('blur', commit);
      return h('div.dlg-row.bld-coll-extra', null, h('label', { text: 'Sim t=0 is hour of day' }), inp, h('span.dim', { text: '(calendar.startHourOfDay, 0–24)' }));
    },
  });
}

// ---------------- pickers ----------------

interface PickItem { id: string; title: string; meta: string; detail: string; tags?: string[] }

/** A list dialog with a details pane; resolves with the chosen id or null. */
function pickDialog(title: string, icon: IconName, loading: Promise<PickItem[]>, okText: string, opts: { onDelete?: (id: string) => Promise<void>; empty: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let items: PickItem[] = [];
    let chosen: string | null = null;
    const list = h('div.bld-pick-list', { tabindex: 0, role: 'listbox' });
    const detail = h('div.bld-pick-detail');
    const body = h('div.bld-pick', null, list, detail);
    const paint = () => {
      list.textContent = '';
      if (!items.length) list.append(h('div.bld-pick-empty', { text: opts.empty }));
      for (const it of items) {
        const row = h('div.bld-pick-row', { role: 'option' });
        if (it.id === chosen) row.classList.add('sel');
        row.append(h('div.t', { text: it.title }), h('div.m', { text: it.meta }));
        row.addEventListener('mousedown', () => { chosen = it.id; paint(); });
        row.addEventListener('dblclick', () => { chosen = it.id; dlg.buttons.get('ok')!.click(); });
        list.append(row);
      }
      const it = items.find((x) => x.id === chosen);
      detail.textContent = '';
      if (it) {
        detail.append(h('b', { text: it.title }), h('p', { text: it.detail }));
        if (it.tags?.length) detail.append(h('div.bld-tags', null, ...it.tags.map((t) => h('span', { text: t }))));
      } else detail.append(h('span.dim', { text: 'Select an item.' }));
      const ok = dlg?.buttons.get('ok');
      if (ok) ok.disabled = !it;
      const del = dlg?.buttons.get('del');
      if (del) del.disabled = !it;
    };
    list.addEventListener('keydown', (e) => {
      const i = items.findIndex((x) => x.id === chosen);
      if (e.key === 'ArrowDown') chosen = items[Math.min(items.length - 1, i + 1)]?.id ?? chosen;
      else if (e.key === 'ArrowUp') chosen = items[Math.max(0, i - 1)]?.id ?? chosen;
      else if (e.key === 'Enter' && chosen) { e.preventDefault(); dlg.buttons.get('ok')!.click(); return; }
      else return;
      e.preventDefault();
      paint();
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    });
    const buttons = [
      ...(opts.onDelete ? [{ id: 'del', text: 'Delete', left: true, onClick: async () => {
        if (!chosen) return false;
        const id = chosen;
        try { await opts.onDelete!(id); items = items.filter((x) => x.id !== id); chosen = items[0]?.id ?? null; paint(); }
        catch (e) { detail.textContent = (e as Error).message; }
        return false;
      } }] : []),
      { id: 'ok', text: okText, isDefault: true, onClick: () => { resolve(chosen); } },
      { id: 'cancel', text: 'Cancel', isCancel: true, onClick: () => { resolve(null); } },
    ];
    const dlg = Dialog.open({ title, icon, body, width: 560, buttons });
    paint();
    list.textContent = '';
    list.append(h('div.bld-pick-empty', { text: 'Loading…' }));
    loading.then((r) => { items = r; chosen = items[0]?.id ?? null; paint(); list.focus(); })
      .catch((e: unknown) => {
        list.textContent = '';
        const err = h('div.bld-pick-empty.err');
        err.append(svg(icons.critical), h('span', { text: (e as Error)?.message ?? String(e) }));
        list.append(err);
        detail.textContent = '';
      });
  });
}

export function pickTemplate(loading: Promise<TemplateInfo[]>): Promise<string | null> {
  return pickDialog('Open Template', 'line', loading.then((ts) => ts.map((t) => ({
    id: t.id, title: t.name, meta: `${t.assetCount} assets · ${t.id}`, detail: t.description || '(no description)', tags: t.tags,
  }))), 'Open', { empty: 'No templates on the server.' });
}

export function pickLayout(loading: Promise<LayoutSummary[]>, onDelete: (id: string) => Promise<void>): Promise<string | null> {
  return pickDialog('Open Layout', 'folderOpen', loading.then((ls) => ls.map((l) => ({
    id: l.id, title: l.name, meta: `${l.assetCount} assets · saved ${fmtDate(l.updatedAtUtc)}`, detail: `Layout ${l.id}, ${l.assetCount} assets, last saved ${fmtDate(l.updatedAtUtc)}.`,
  }))), 'Open', { onDelete, empty: 'No saved layouts yet. Use File → Save Layout As…' });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Prompt for a layout name. */
export function promptName(title: string, label: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const inp = h('input.field', { type: 'text', style: 'width:280px', spellcheck: 'false' });
    inp.value = initial;
    const body = h('div.form-grid', null, h('label', { text: label }), inp);
    Dialog.open({
      title, icon: 'export', body,
      buttons: [
        { id: 'ok', text: 'Save', isDefault: true, onClick: () => { const v = inp.value.trim(); if (!v) { inp.focus(); return false; } resolve(v); } },
        { id: 'cancel', text: 'Cancel', isCancel: true, onClick: () => { resolve(null); } },
      ],
    });
    inp.select();
  });
}

/** Yes / No / Cancel style question. Resolves with the chosen button id. */
export function ask(title: string, text: string, buttons: { id: string; text: string; isDefault?: boolean; isCancel?: boolean }[], icon: IconName = 'warning'): Promise<string> {
  return new Promise((resolve) => {
    const body = h('div.bld-ask');
    body.append(svg(icons[icon]), h('div', { text }));
    Dialog.open({ title, icon: 'about', body, buttons: buttons.map((b) => ({ ...b, onClick: () => { resolve(b.id); } })) });
  });
}

/** Issues returned by a rejected Apply (422). */
export function showIssues(title: string, text: string, issues: ValidationIssue[]): void {
  const crit = issues.filter((i) => i.severity === 'critical');
  const tbody = h('tbody');
  for (const i of issues.slice(0, 40)) {
    tbody.append(h('tr', null,
      h('td', null, svg(icons[i.severity === 'critical' ? 'critical' : i.severity === 'warning' ? 'warning' : 'info'])),
      h('td.mono', { text: i.code }), h('td.mono', { text: i.assetId ?? '' }), h('td', { text: i.message, title: i.message })));
  }
  const table = h('table.sgrid.bld-issue-table', null, h('thead', null, h('tr', null, h('th', { style: 'width:22px' }), h('th', { text: 'Code', style: 'width:150px' }), h('th', { text: 'Asset', style: 'width:72px' }), h('th', { text: 'Message' }))), tbody);
  const body = h('div', null, h('div.bld-ask', null, svg(icons.critical), h('div', { text: `${text} ${crit.length} critical issue${crit.length === 1 ? '' : 's'} must be fixed before the plant can be applied.` })), h('div.bld-issue-box', null, table));
  Dialog.open({ title, icon: 'critical', body, width: 620, buttons: [{ id: 'ok', text: 'OK', isDefault: true, isCancel: true }] });
}
