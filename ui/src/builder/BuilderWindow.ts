// Plant Builder workspace: a maximisable MDI-style child window over the console with its own
// title bar, menu bar, tool strip, Toolbox / Plan View / Properties / Validation panes and status bar.
import type { PanelContext } from '../panels/panel';
import type { PlantModel } from '../net/contracts';
import { h, svg, setText, storage, clamp } from '../widgets/dom';
import { icons } from '../widgets/icons';
import { PopupMenu, parseMnemonic, renderMnemonic, type MenuEntry } from '../widgets/Menu';
import { Dialog, messageBox } from '../widgets/Dialog';
import { setChecked } from '../widgets/Button';
import { BuilderCanvas } from './canvas';
import { BuilderEditor, type Tool } from './editor';
import { Palette } from './palette';
import { PropsPanel } from './props';
import { ValidationPanel } from './validationPanel';
import { BuilderApi, ApplyRejected, errorText, isUnreachable } from './api';
import { bicons, type BIconName } from './icons';
import { newPlant, normalizePlant } from './model';
import { validatePlant } from './validate';
import { ask, openLinesDialog, openResourcesDialog, openShiftsDialog, pickLayout, pickTemplate, promptName, showIssues } from './dialogs';

const LAYOUT_KEY = 'svdtl.builder.layout.v1';
interface PaneSizes { right: number; bottom: number; left: number; maximized: boolean }
const DEFAULT_SIZES: PaneSizes = { right: 320, bottom: 168, left: 150, maximized: true };

function loadSizes(): PaneSizes {
  try {
    const s = JSON.parse(storage.get(LAYOUT_KEY) ?? 'null') as Partial<PaneSizes> | null;
    const ok = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
    return {
      right: ok(s?.right, 220, 900, DEFAULT_SIZES.right),
      bottom: ok(s?.bottom, 80, 700, DEFAULT_SIZES.bottom),
      left: ok(s?.left, 110, 400, DEFAULT_SIZES.left),
      maximized: typeof s?.maximized === 'boolean' ? s.maximized : true,
    };
  } catch { return { ...DEFAULT_SIZES }; }
}

interface TopMenu { label: string; items: () => MenuEntry[] }

export class BuilderWindow {
  readonly el: HTMLDivElement;
  readonly editor: BuilderEditor;
  private readonly canvas: BuilderCanvas;
  private readonly palette: Palette;
  private readonly props: PropsPanel;
  private readonly valid: ValidationPanel;
  private readonly api = new BuilderApi();
  private readonly titleText: HTMLSpanElement;
  private readonly menuHeads: HTMLDivElement[] = [];
  private readonly menus: TopMenu[];
  private popup: PopupMenu | null = null;
  private readonly tb = new Map<string, HTMLButtonElement>();
  private readonly sb: Record<'msg' | 'pos' | 'zoom' | 'sel' | 'count' | 'valid' | 'snap', HTMLDivElement>;
  private sizes = loadSizes();
  private vTimer = 0;
  private vSeq = 0;
  private serverDownAt = 0;
  private closed = false;
  private readonly offs: (() => void)[] = [];
  private readonly docKey = (e: KeyboardEvent) => this.onDocKey(e);
  onClosed: (() => void) | null = null;

  constructor(private readonly ctx: PanelContext, plant: PlantModel, origin: string) {
    this.editor = new BuilderEditor(plant);
    this.editor.doc.origin = origin;
    const ed = this.editor;
    this.el = h('div.bld-window', { role: 'dialog', 'aria-label': 'Plant Builder' });

    // ---- title bar
    const title = h('div.bld-title');
    title.append(svg(bicons.builder, 'dt-icon'));
    this.titleText = h('span.dt-text');
    title.append(this.titleText);
    const maxBtn = h('button.title-btn', { type: 'button', title: 'Maximise / Restore', tabindex: -1 });
    maxBtn.addEventListener('click', () => this.setMaximized(!this.sizes.maximized));
    const closeBtn = h('button.title-btn', { type: 'button', title: 'Close (Ctrl+F4)', tabindex: -1 });
    closeBtn.append(svg(icons.close));
    closeBtn.addEventListener('click', () => void this.close());
    title.append(maxBtn, closeBtn);
    title.addEventListener('dblclick', (e) => { if (!(e.target as HTMLElement).closest('button')) this.setMaximized(!this.sizes.maximized); });
    this.enableDrag(title);

    // ---- menu bar
    this.menus = this.buildMenus();
    const menubar = h('div.menubar.bld-menubar', { role: 'menubar' });
    this.menus.forEach((m, i) => {
      const head = h('div.menubar-item', { role: 'menuitem' });
      head.append(renderMnemonic(m.label));
      head.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); if (this.popup) this.closeMenu(); else this.openMenu(i, false); });
      head.addEventListener('mouseenter', () => { if (this.popup) this.openMenu(i, false); });
      this.menuHeads.push(head);
      menubar.append(head);
    });
    menubar.append(h('span.brand', null, h('b', { text: 'Plant Builder' }), ` · ${ctx.source.kind === 'mock' ? 'Demo (local validation)' : 'Live server'}`));

    // ---- tool strip
    const tool = h('div.toolstrip.bld-toolstrip', { role: 'toolbar' });
    const tbtn = (id: string, icon: BIconName | null, title: string, onClick: () => void, text?: string, iconMarkup?: string) => {
      const b = h('button.tool-btn', { type: 'button', title, 'aria-label': title });
      if (icon || iconMarkup) b.append(svg(iconMarkup ?? bicons[icon!]));
      if (text) b.append(h('span.tb-text', { text }));
      b.addEventListener('click', onClick);
      this.tb.set(id, b);
      return b;
    };
    const sep = () => h('span.sep');
    tool.append(
      h('span.grip'),
      tbtn('new', 'newDoc', 'New plant (Ctrl+N)', () => void this.cmdNew()),
      tbtn('tpl', 'template', 'Open template… (Ctrl+Shift+O)', () => void this.cmdOpenTemplate()),
      tbtn('open', 'open', 'Open layout… (Ctrl+O)', () => void this.cmdOpenLayout()),
      tbtn('save', 'save', 'Save layout (Ctrl+S)', () => void this.cmdSave(false)),
      sep(),
      tbtn('import', 'importJson', 'Import JSON…', () => this.cmdImport()),
      tbtn('export', 'exportJson', 'Export JSON (Ctrl+E)', () => this.cmdExport()),
      sep(),
      tbtn('undo', 'undo', 'Undo (Ctrl+Z)', () => ed.undo()),
      tbtn('redo', 'redo', 'Redo (Ctrl+Y)', () => ed.redo()),
      sep(),
      tbtn('copy', 'copy', 'Copy (Ctrl+C)', () => ed.copy()),
      tbtn('paste', 'paste', 'Paste (Ctrl+V)', () => ed.paste()),
      tbtn('delete', 'remove', 'Delete (Del)', () => ed.deleteSelection()),
      tbtn('rotate', 'rotate', 'Rotate 90° (R)', () => ed.rotate(90)),
      sep(),
      tbtn('select', 'pointer', 'Select / Move tool (V)', () => ed.setTool('select')),
      tbtn('connect', 'connect', 'Connect tool (C): drag from one asset to another; click an arrow to remove it', () => ed.setTool('connect')),
      tbtn('pan', 'pan', 'Pan tool (H). Also middle-drag or Space+drag', () => ed.setTool('pan')),
      sep(),
      tbtn('fit', 'zoomFit', 'Zoom to fit (Ctrl+0)', () => this.canvas.zoomToFit()),
      tbtn('zin', 'zoomIn', 'Zoom in (+)', () => this.canvas.zoomBy(1.25)),
      tbtn('zout', 'zoomOut', 'Zoom out (−)', () => this.canvas.zoomBy(0.8)),
      tbtn('grid', 'grid', 'Show grid', () => { ed.gridOn = !ed.gridOn; this.canvas.invalidate(); this.update(); }),
      tbtn('snap', 'snap', 'Snap to 0.5 m grid (hold Alt to disable while dragging)', () => { ed.snapOn = !ed.snapOn; this.update(); }),
      h('span.grow'),
      tbtn('live', 'loadLive', 'Load the plant currently running in the twin', () => void this.cmdLoadCurrent(), 'Load Current'),
      tbtn('validate', 'validate', 'Validate now (F7)', () => this.validateNow(), 'Validate'),
      sep(),
      tbtn('apply', 'apply', 'Apply to Twin: PUT /api/plant (Ctrl+Enter)', () => void this.cmdApply(), 'Apply to Twin'),
    );
    this.tb.get('apply')!.classList.add('bld-apply');

    // ---- panes
    this.canvas = new BuilderCanvas(ed);
    this.palette = new Palette(ed, this.canvas);
    this.props = new PropsPanel(ed, {
      openLines: () => openLinesDialog(ed),
      openResources: () => openResourcesDialog(ed),
      openShifts: () => openShiftsDialog(ed),
    });
    this.valid = new ValidationPanel(ed, () => this.validateNow());

    const pane = (cls: string, titleTxt: string, icon: string, content: HTMLElement) => {
      const p = h(`div.pane.${cls}`);
      const t = h('div.pane-title');
      t.append(svg(icon, 'pt-icon'), h('span.pt-text', { text: titleTxt }));
      const b = h('div.pane-body');
      b.append(content);
      p.append(t, b);
      p.addEventListener('focusin', () => this.setActivePane(p));
      p.addEventListener('mousedown', () => this.setActivePane(p));
      return p;
    };
    const leftPane = pane('bld-left', 'Toolbox', icons.layout, this.palette.el);
    const planPane = pane('bld-plan', 'Plan View', bicons.grid, this.canvas.el);
    const bottomPane = pane('bld-bottom', 'Validation', icons.warning, this.valid.el);
    const rightPane = pane('bld-right', 'Properties', icons.layout, this.props.el);
    const splitL = h('div.splitter.v', { title: 'Drag to resize' });
    const splitR = h('div.splitter.v', { title: 'Drag to resize' });
    const splitB = h('div.splitter.h', { title: 'Drag to resize' });
    const centre = h('div.bld-centre', null, planPane, splitB, bottomPane);
    const body = h('div.bld-body', null, leftPane, splitL, centre, splitR, rightPane);
    this.splitter(splitL, 'x', () => this.sizes.left, (v) => (this.sizes.left = clamp(v, 110, 400)), 1);
    this.splitter(splitR, 'x', () => this.sizes.right, (v) => (this.sizes.right = clamp(v, 220, 900)), -1);
    this.splitter(splitB, 'y', () => this.sizes.bottom, (v) => (this.sizes.bottom = clamp(v, 80, 700)), -1);
    this.setActivePane(planPane);

    // ---- status bar
    const seg = (cls: string, title?: string) => h(`div.sb-seg.${cls}`, { title });
    this.sb = {
      msg: seg('grow.msg'), pos: seg('mono.pos', 'Cursor position (world metres)'), zoom: seg('mono.zoom', 'Zoom (100 % = 40 px/m)'),
      sel: seg('sel', 'Selection'), count: seg('count', 'Assets / sensors / flows'), valid: seg('valid', 'Validation'), snap: seg('snap', 'Snap'),
    };
    const status = h('div.statusbar.bld-status');
    status.append(this.sb.msg, this.sb.valid, this.sb.sel, this.sb.count, this.sb.pos, this.sb.zoom, this.sb.snap, h('div.sb-grip'));

    this.el.append(title, menubar, tool, body, status);
    this.applySizes();

    // ---- wiring
    this.canvas.onCursor = (p) => setText(this.sb.pos, p ? `X ${p.x.toFixed(2)}  Z ${p.z.toFixed(2)} m` : '');
    this.canvas.onView = () => setText(this.sb.zoom, `${this.canvas.zoomPct} %`);
    this.offs.push(
      ed.on('change', () => { this.update(); this.scheduleValidate(); }),
      ed.on('selection', () => this.update()),
      ed.on('tool', () => this.update()),
      ed.on('issues', () => this.update()),
      ed.on('status', (s) => { setText(this.sb.msg, s.text); this.sb.msg.classList.toggle('error', s.kind === 'error'); }),
      ed.on('activate', () => this.props.activate('name')),
    );
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
    document.addEventListener('keydown', this.docKey, true);
    this.el.addEventListener('mousedown', () => { if (this.popup) this.closeMenu(); }, true);
  }

  // ---------- lifecycle ----------

  mount(parent: HTMLElement = document.body): void {
    parent.append(this.el);
    this.setMaximized(this.sizes.maximized);
    this.update();
    setText(this.sb.zoom, `${this.canvas.zoomPct} %`);
    setText(this.sb.msg, 'Ready. Drag assets from the Toolbox; C = connect tool; F1 lists the keys.');
    this.validateNow();
    requestAnimationFrame(() => this.canvas.focus());
  }

  focus(): void { this.canvas.focus(); }

  get isOpen(): boolean { return !this.closed; }

  /** Close, asking about unsaved changes. Resolves false when the user cancels. */
  async close(force = false): Promise<boolean> {
    if (this.closed) return true;
    if (!force && this.editor.doc.dirty) {
      const mock = this.ctx.source.kind === 'mock';
      const r = await ask('Plant Builder', `The plant "${this.editor.plant.name}" has unsaved changes. ${mock ? 'Export them as JSON before closing?' : 'Save them as a layout before closing?'}`, [
        { id: 'save', text: mock ? 'Export JSON' : 'Save Layout', isDefault: true },
        { id: 'discard', text: 'Discard' },
        { id: 'cancel', text: 'Cancel', isCancel: true },
      ]);
      if (r === 'cancel') return false;
      if (r === 'save') {
        if (mock) this.cmdExport();
        else if (!(await this.cmdSave(false))) return false;
      }
    }
    this.closed = true;
    clearTimeout(this.vTimer);
    this.popup?.close('dismiss');
    document.removeEventListener('keydown', this.docKey, true);
    this.offs.forEach((f) => f());
    this.canvas.dispose();
    this.props.dispose();
    this.valid.dispose();
    this.el.remove();
    this.onClosed?.();
    return true;
  }

  private setMaximized(on: boolean): void {
    this.sizes.maximized = on;
    this.el.classList.toggle('maximized', on);
    const btn = this.el.querySelector<HTMLButtonElement>('.bld-title .title-btn');
    if (btn) { btn.textContent = ''; btn.append(svg(on ? bicons.restore : bicons.maximize)); btn.title = on ? 'Restore' : 'Maximise'; }
    if (!on && !this.el.style.left) {
      this.el.style.left = '48px'; this.el.style.top = '56px';
      this.el.style.width = `${Math.max(760, window.innerWidth - 96)}px`;
      this.el.style.height = `${Math.max(480, window.innerHeight - 112)}px`;
    }
    this.saveSizes();
  }

  private saveSizes(): void { storage.set(LAYOUT_KEY, JSON.stringify(this.sizes)); }

  private applySizes(): void {
    this.el.style.setProperty('--bld-right', `${this.sizes.right}px`);
    this.el.style.setProperty('--bld-bottom', `${this.sizes.bottom}px`);
    this.el.style.setProperty('--bld-left', `${this.sizes.left}px`);
  }

  private splitter(el: HTMLElement, axis: 'x' | 'y', get: () => number, set: (v: number) => void, dir: 1 | -1): void {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const p0 = axis === 'x' ? e.clientX : e.clientY;
      const v0 = get();
      el.classList.add('dragging');
      document.body.classList.add(axis === 'x' ? 'resizing-col' : 'resizing-row');
      const move = (ev: MouseEvent) => { set(v0 + dir * ((axis === 'x' ? ev.clientX : ev.clientY) - p0)); this.applySizes(); };
      const up = () => {
        el.classList.remove('dragging');
        document.body.classList.remove('resizing-col', 'resizing-row');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.saveSizes();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  private enableDrag(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this.sizes.maximized || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev: MouseEvent) => {
        this.el.style.left = `${clamp(ev.clientX - dx, -r.width + 80, window.innerWidth - 80)}px`;
        this.el.style.top = `${clamp(ev.clientY - dy, 0, window.innerHeight - 24)}px`;
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  private setActivePane(p: HTMLElement): void {
    this.el.querySelectorAll('.bld-body > .pane, .bld-centre > .pane').forEach((x) => x.classList.toggle('active', x === p));
  }

  // ---------- state → chrome ----------

  private update(): void {
    if (this.closed) return;
    const ed = this.editor;
    const d = ed.doc;
    const p = ed.plant;
    setText(this.titleText, `Plant Builder — ${p.name}${d.dirty ? ' *' : ''}   [${d.layoutName ? `Layout: ${d.layoutName}` : d.origin}]`);
    const t = this.tb;
    t.get('undo')!.disabled = !d.canUndo;
    t.get('undo')!.title = d.canUndo ? `Undo ${d.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    t.get('redo')!.disabled = !d.canRedo;
    t.get('redo')!.title = d.canRedo ? `Redo ${d.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    const has = ed.selection.length > 0;
    t.get('copy')!.disabled = !has;
    t.get('paste')!.disabled = !ed.canPaste;
    t.get('delete')!.disabled = !has && !ed.edge;
    t.get('rotate')!.disabled = !has;
    t.get('live')!.disabled = !this.ctx.store.plant;
    for (const k of ['select', 'connect', 'pan'] as Tool[]) setChecked(t.get(k)!, ed.tool === k && !ed.placeKind);
    setChecked(t.get('grid')!, ed.gridOn);
    setChecked(t.get('snap')!, ed.snapOn);
    const flows = p.assets.reduce((n, a) => n + a.downstream.length, 0);
    setText(this.sb.count, `${p.assets.length} assets · ${p.sensors.length} sensors · ${flows} flows`);
    setText(this.sb.sel, ed.edge ? `Flow ${ed.edge.from} → ${ed.edge.to}` : ed.selection.length === 1 ? `Selected ${ed.selection[0]}` : ed.selection.length ? `${ed.selection.length} selected` : 'No selection');
    setText(this.sb.snap, ed.snapOn ? 'SNAP 0.5 m' : 'SNAP OFF');
    const c = ed.issues.filter((i) => i.severity === 'critical').length, w = ed.issues.filter((i) => i.severity === 'warning').length;
    this.sb.valid.textContent = '';
    this.sb.valid.append(svg(icons[c ? 'critical' : w ? 'warning' : 'ack']), h('span', { text: c || w ? `${c} errors, ${w} warnings` : 'Valid' }));
    this.sb.valid.classList.toggle('bad', c > 0);
  }

  // ---------- validation ----------

  private scheduleValidate(): void {
    clearTimeout(this.vTimer);
    this.vTimer = window.setTimeout(() => void this.validate(), 400);
  }

  validateNow(): void { clearTimeout(this.vTimer); void this.validate(); }

  private async validate(): Promise<void> {
    const seq = ++this.vSeq;
    const plant = this.editor.doc.snapshot();
    const local = (note: string) => { const r = validatePlant(plant); if (seq === this.vSeq && !this.closed) this.editor.setIssues(r.issues, 'local', note); };
    if (this.ctx.source.kind === 'mock') { local('demo mode'); return; }
    if (this.serverDownAt && Date.now() - this.serverDownAt < 15_000) { local('server unreachable'); return; }
    try {
      const r = await this.api.validate(plant);
      this.serverDownAt = 0;
      if (seq === this.vSeq && !this.closed) this.editor.setIssues(r.issues ?? [], 'server');
    } catch (e) {
      if (isUnreachable(e)) this.serverDownAt = Date.now();
      local(isUnreachable(e) ? 'server unreachable' : `server error: ${errorText(e)}`);
    }
  }

  // ---------- commands ----------

  private async confirmDiscard(what: string): Promise<boolean> {
    if (!this.editor.doc.dirty) return true;
    const r = await ask('Plant Builder', `Discard unsaved changes to "${this.editor.plant.name}" and ${what}?`, [
      { id: 'yes', text: 'Discard', isDefault: true }, { id: 'no', text: 'Cancel', isCancel: true },
    ]);
    return r === 'yes';
  }

  private loadDoc(p: PlantModel, origin: string, layout?: { id: string; name: string }): void {
    this.editor.load(p, origin);
    this.editor.doc.layoutId = layout?.id ?? null;
    this.editor.doc.layoutName = layout?.name ?? null;
    this.update();
    this.validateNow();
    this.editor.status(`Opened ${origin}: ${p.assets.length} assets`, 'ok');
  }

  async cmdNew(): Promise<void> {
    if (!(await this.confirmDiscard('start a new plant'))) return;
    this.loadDoc(newPlant(), 'New');
    this.canvas.focus();
  }

  async cmdOpenTemplate(): Promise<void> {
    if (!(await this.confirmDiscard('open a template'))) return;
    const id = await pickTemplate(this.api.templates());
    if (!id) return;
    try {
      const p = await this.api.template(id);
      this.loadDoc(p, `Template ${id}`);
    } catch (e) { messageBox('Open Template', `Could not load template ${id}: ${errorText(e)}`, 'critical'); }
  }

  async cmdOpenLayout(): Promise<void> {
    if (!(await this.confirmDiscard('open a layout'))) return;
    const id = await pickLayout(this.api.layouts(), (lid) => this.api.deleteLayout(lid));
    if (!id) return;
    try {
      const l = await this.api.layout(id);
      this.loadDoc(l.plant, `Layout ${l.name}`, { id: l.id, name: l.name });
    } catch (e) { messageBox('Open Layout', `Could not load layout: ${errorText(e)}`, 'critical'); }
  }

  /** Save to the current layout (or Save As). Resolves true when saved. */
  async cmdSave(saveAs: boolean): Promise<boolean> {
    const d = this.editor.doc;
    let id = saveAs ? null : d.layoutId;
    let name = d.layoutName ?? this.editor.plant.name;
    if (!id) {
      const n = await promptName(saveAs ? 'Save Layout As' : 'Save Layout', 'Layout name:', name);
      if (!n) return false;
      name = n;
    }
    try {
      const req = { name, plant: d.snapshot() };
      const l = id ? await this.api.updateLayout(id, req) : await this.api.createLayout(req);
      id = l.id;
      d.layoutId = l.id;
      d.layoutName = l.name;
      d.markClean();
      this.update();
      this.editor.status(`Saved layout "${l.name}" (${l.id})`, 'ok');
      return true;
    } catch (e) {
      const mock = this.ctx.source.kind === 'mock';
      messageBox('Save Layout', mock || isUnreachable(e)
        ? `Layouts are stored by the twin server, which is not reachable${mock ? ' in demo mode' : ''}. Use File → Export JSON to keep a copy. (${errorText(e)})`
        : `Could not save the layout: ${errorText(e)}`, 'critical');
      return false;
    }
  }

  cmdImport(): void {
    const inp = h('input', { type: 'file', accept: '.json,application/json' });
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const plant = normalizePlant(JSON.parse(await f.text()));
        if (!(await this.confirmDiscard(`import ${f.name}`))) return;
        this.loadDoc(plant, f.name);
      } catch (e) { messageBox('Import JSON', `${f.name} is not a valid PlantModel: ${errorText(e)}`, 'critical'); }
    });
    inp.click();
  }

  cmdExport(): void {
    const p = this.editor.doc.snapshot();
    const blob = new Blob([JSON.stringify(p, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${p.id || 'plant'}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.editor.status(`Exported ${p.id}.json (${p.assets.length} assets)`, 'ok');
  }

  async cmdLoadCurrent(): Promise<void> {
    const p = this.ctx.store.plant;
    if (!p) { this.editor.status('No live plant yet (not connected)', 'error'); return; }
    if (!(await this.confirmDiscard('load the current plant'))) return;
    this.loadDoc(JSON.parse(JSON.stringify(p)) as PlantModel, 'Current plant');
  }

  async cmdApply(): Promise<void> {
    const ed = this.editor;
    if (this.ctx.source.kind === 'mock') {
      messageBox('Apply to Twin', 'Demo mode runs an in-browser mock simulation with no twin server, so the plant cannot be applied here. '
        + 'Export JSON (or switch to Live via Tools → Data Source) and apply it to a running server.', 'info');
      return;
    }
    const local = validatePlant(ed.plant);
    if (!local.ok && ed.validationSource !== 'server') ed.setIssues(local.issues, 'local', 'checked before apply');
    this.tb.get('apply')!.disabled = true;
    ed.status('Applying plant to the twin…');
    try {
      const snap = await this.api.apply(ed.doc.snapshot());
      ed.doc.markClean();
      this.update();
      ed.status(`Applied "${snap.plant.name}" (${snap.plant.assets.length} assets). The twin was reset to t = 0.`, 'ok');
      const r = await ask('Apply to Twin', `"${snap.plant.name}" is now the live plant (${snap.plant.assets.length} assets). The simulation was reset to t = 0 and every client received a new snapshot.`, [
        { id: 'close', text: 'Close Builder', isDefault: true }, { id: 'keep', text: 'Keep Editing', isCancel: true },
      ], 'info');
      if (r === 'close') await this.close(true);
    } catch (e) {
      if (e instanceof ApplyRejected) {
        ed.setIssues(e.issues, 'server');
        showIssues('Apply to Twin — rejected', 'The server rejected the plant (HTTP 422).', e.issues);
        ed.status('Apply rejected: fix the critical issues in the Validation pane', 'error');
      } else {
        messageBox('Apply to Twin', `Could not apply the plant: ${errorText(e)}`, 'critical');
        ed.status(`Apply failed: ${errorText(e)}`, 'error');
      }
    } finally {
      if (!this.closed) this.tb.get('apply')!.disabled = false;
    }
  }

  // ---------- menus ----------

  private buildMenus(): TopMenu[] {
    const ed = () => this.editor;
    const has = () => this.editor.selection.length > 0;
    const tool = (label: string, t: Tool, accel: string): MenuEntry => ({ label, accel, radio: true, checked: () => ed().tool === t && !ed().placeKind, action: () => ed().setTool(t) });
    return [
      { label: '&File', items: () => [
        { label: '&New Plant', accel: 'Ctrl+N', action: () => void this.cmdNew() },
        { label: 'Open &Template…', accel: 'Ctrl+Shift+O', action: () => void this.cmdOpenTemplate() },
        { label: '&Open Layout…', accel: 'Ctrl+O', action: () => void this.cmdOpenLayout() },
        'sep',
        { label: '&Save Layout', accel: 'Ctrl+S', action: () => void this.cmdSave(false) },
        { label: 'Save Layout &As…', accel: 'Ctrl+Shift+S', action: () => void this.cmdSave(true) },
        'sep',
        { label: '&Import JSON…', action: () => this.cmdImport() },
        { label: '&Export JSON', accel: 'Ctrl+E', action: () => this.cmdExport() },
        { label: '&Load Current Plant', disabled: () => !this.ctx.store.plant, action: () => void this.cmdLoadCurrent() },
        'sep',
        { label: 'A&pply to Twin', accel: 'Ctrl+Enter', action: () => void this.cmdApply() },
        'sep',
        { label: '&Close Builder', accel: 'Ctrl+F4', action: () => void this.close() },
      ] },
      { label: '&Edit', items: () => [
        { label: ed().doc.canUndo ? `&Undo ${ed().doc.undoLabel}` : '&Undo', accel: 'Ctrl+Z', disabled: () => !ed().doc.canUndo, action: () => ed().undo() },
        { label: ed().doc.canRedo ? `&Redo ${ed().doc.redoLabel}` : '&Redo', accel: 'Ctrl+Y', disabled: () => !ed().doc.canRedo, action: () => ed().redo() },
        'sep',
        { label: 'Cu&t', accel: 'Ctrl+X', disabled: () => !has(), action: () => ed().cut() },
        { label: '&Copy', accel: 'Ctrl+C', disabled: () => !has(), action: () => ed().copy() },
        { label: '&Paste', accel: 'Ctrl+V', disabled: () => !ed().canPaste, action: () => ed().paste() },
        { label: 'D&uplicate', accel: 'Ctrl+D', disabled: () => !has(), action: () => ed().duplicate() },
        { label: '&Delete', accel: 'Del', disabled: () => !has() && !ed().edge, action: () => ed().deleteSelection() },
        'sep',
        { label: 'Select &All', accel: 'Ctrl+A', action: () => ed().selectAll() },
        { label: 'Rotate &Right 90°', accel: 'R', disabled: () => !has(), action: () => ed().rotate(90) },
        { label: 'Rotate &Left 90°', accel: 'Shift+R', disabled: () => !has(), action: () => ed().rotate(-90) },
        { label: 'Co&nnect in Selection Order', accel: 'Ctrl+L', disabled: () => ed().selection.length < 2, action: () => ed().chainSelection() },
        'sep',
        { label: 'L&ines…', action: () => openLinesDialog(ed()) },
        { label: 'R&esources…', action: () => openResourcesDialog(ed()) },
        { label: 'S&hifts…', action: () => openShiftsDialog(ed()) },
      ] },
      { label: '&View', items: () => [
        { label: 'Zoom to &Fit', accel: 'Ctrl+0', action: () => this.canvas.zoomToFit() },
        { label: 'Zoom &In', accel: '+', action: () => this.canvas.zoomBy(1.25) },
        { label: 'Zoom &Out', accel: '−', action: () => this.canvas.zoomBy(0.8) },
        { label: 'Zoom &100 %', action: () => this.canvas.zoom100() },
        'sep',
        { label: 'Show &Grid', checked: () => ed().gridOn, action: () => { ed().gridOn = !ed().gridOn; this.canvas.invalidate(); this.update(); } },
        { label: '&Snap to Grid (0.5 m)', checked: () => ed().snapOn, action: () => { ed().snapOn = !ed().snapOn; this.update(); } },
        'sep',
        { label: this.sizes.maximized ? '&Restore Window' : '&Maximise Window', action: () => this.setMaximized(!this.sizes.maximized) },
      ] },
      { label: '&Tools', items: () => [
        tool('&Select / Move', 'select', 'V'),
        tool('&Connect', 'connect', 'C'),
        tool('&Pan', 'pan', 'H'),
        'sep',
        { label: '&Validate Now', accel: 'F7', action: () => this.validateNow() },
        { label: '&Keyboard Reference', accel: 'F1', action: () => this.showKeys() },
      ] },
    ];
  }

  private openMenu(i: number, kbd: boolean): void {
    this.popup?.close('dismiss');
    this.menuHeads.forEach((hd, k) => hd.classList.toggle('open', k === i));
    const r = this.menuHeads[i].getBoundingClientRect();
    const popup = new PopupMenu(this.menus[i].items(), Math.round(r.left), Math.round(r.bottom), {
      showMnemonics: kbd,
      onHorizontal: (dir) => this.openMenu((i + dir + this.menus.length) % this.menus.length, true),
      onClose: () => {
        if (this.popup !== popup) return;
        this.popup = null;
        this.menuHeads.forEach((hd) => hd.classList.remove('open'));
      },
    });
    this.popup = popup;
    if (kbd) popup.hotFirst();
  }

  private closeMenu(): void { this.popup?.close('dismiss'); }

  private showKeys(): void {
    const rows: [string, string][] = [
      ['V / C / H', 'Select, Connect, Pan tool'], ['Space+drag, middle-drag', 'Pan'], ['Wheel', 'Zoom at the cursor'], ['Ctrl+0 / Home', 'Zoom to fit'],
      ['Alt (while dragging)', 'Disable snapping'], ['Arrows / Shift / Alt', 'Nudge 0.5 m / 1 m / 0.1 m'], ['R / Shift+R', 'Rotate ±90°'],
      ['Del', 'Delete selection or flow'], ['Ctrl+C / X / V / D', 'Copy, cut, paste, duplicate'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Ctrl+A', 'Select all'], ['Ctrl+L', 'Connect selection in order'], ['Tab / Shift+Tab', 'Cycle selection (plan focused)'],
      ['Enter', 'Edit the selected asset\'s properties'], ['F6 / Shift+F6', 'Next / previous pane'], ['F7', 'Validate now'],
      ['Ctrl+S / Ctrl+Shift+S', 'Save layout / Save as'], ['Ctrl+O / Ctrl+Shift+O', 'Open layout / template'], ['Ctrl+E', 'Export JSON'],
      ['Ctrl+Enter', 'Apply to Twin'], ['Ctrl+F4', 'Close the builder'], ['Alt+F / E / V / T', 'Open a menu'],
      ['Toolbox: Enter / Space', 'Add at view centre / arm for click-placing'],
    ];
    const tbody = h('tbody');
    for (const [k, d] of rows) tbody.append(h('tr', null, h('td', { text: k }), h('td', { text: d })));
    const body = h('div', null, h('table.kbd-table', null, tbody));
    Dialog.open({ title: 'Plant Builder Keys', icon: 'keyboard', body, buttons: [{ id: 'ok', text: 'OK', isDefault: true, isCancel: true }] });
  }

  // ---------- keyboard ----------

  /** Keys whose target is outside the window (body after a click on chrome): route here, keep from the shell. */
  private onDocKey(e: KeyboardEvent): void {
    if (this.closed || PopupMenu.isOpen) return;
    const t = e.target as HTMLElement;
    if (this.el.contains(t) || t.closest?.('.dialog, .listbox, .menu-popup, .bld-cell-edit') || document.querySelector('.dialog')) return;
    this.onKey(e);
    e.stopPropagation();
  }

  private onKey(e: KeyboardEvent): void {
    // Everything inside the builder stays inside it: the console shell must not react.
    e.stopPropagation();
    if (PopupMenu.isOpen || document.querySelector('.dialog')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
    const k = e.key.toLowerCase();
    const run = (fn: () => void) => { e.preventDefault(); fn(); };

    if (e.altKey && !ctrl && e.key.length === 1) {
      const i = this.menus.findIndex((m) => parseMnemonic(m.label).mnemonic === k);
      if (i >= 0) run(() => this.openMenu(i, true));
      return;
    }
    if (e.key === 'F10' && !e.shiftKey) return run(() => this.openMenu(0, true));
    if (e.key === 'F1') return run(() => this.showKeys());
    if (e.key === 'F7') return run(() => this.validateNow());
    if (e.key === 'F6') return run(() => this.cyclePane(e.shiftKey ? -1 : 1));
    if (ctrl && e.key === 'F4') return run(() => void this.close());
    if (ctrl && e.key === 'Enter') return run(() => void this.cmdApply());
    if (ctrl && k === 'n') return run(() => void this.cmdNew());
    if (ctrl && k === 'o') return run(() => void (e.shiftKey ? this.cmdOpenTemplate() : this.cmdOpenLayout()));
    if (ctrl && k === 's') return run(() => void this.cmdSave(e.shiftKey));
    if (ctrl && k === 'e') return run(() => this.cmdExport());
    if (typing) return;
    if (ctrl && !e.shiftKey && k === 'z') return run(() => this.editor.undo());
    if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) return run(() => this.editor.redo());
    if (e.key === 'Escape' && this.editor.placeKind) return run(() => this.editor.arm(null));
  }

  private cyclePane(dir: 1 | -1): void {
    const stops: (() => void)[] = [
      () => this.palette.el.focus(),
      () => this.canvas.focus(),
      () => this.props.focusFirst(),
      () => this.valid.grid.el.focus(),
    ];
    const a = document.activeElement as HTMLElement | null;
    let i = 1;
    if (a && this.palette.el.contains(a)) i = 0;
    else if (a === this.canvas.canvas) i = 1;
    else if (a && this.props.el.contains(a)) i = 2;
    else if (a && this.valid.el.contains(a)) i = 3;
    stops[(i + dir + stops.length) % stops.length]();
  }
}
