// Plant Builder controller: document + selection + tool + validation state, shared by the canvas,
// palette, property grid and validation panel. No DOM.
import type { AssetKind, PlantModel, ValidationIssue } from '../net/contracts';
import { BuilderDoc } from './doc';
import * as ops from './ops';
import { issuesByAsset } from './validate';

export type Tool = 'select' | 'connect' | 'pan';
export interface Edge { from: string; to: string }
export type ValidationSource = 'server' | 'local' | 'pending' | 'none';

export interface EditorEvents {
  change: string;
  selection: void;
  tool: void;
  issues: void;
  status: { text: string; kind: 'info' | 'ok' | 'error' };
  /** Ask the canvas to centre on an asset (validation row click). */
  reveal: string;
  /** Ask the window to focus the property grid (Enter / double-click). */
  activate: string;
  fit: void;
}

type Fn<T> = (v: T) => void;

export class BuilderEditor {
  readonly doc: BuilderDoc;
  selection: string[] = [];
  edge: Edge | null = null;
  tool: Tool = 'select';
  placeKind: AssetKind | null = null;
  snapOn = true;
  gridOn = true;
  issues: ValidationIssue[] = [];
  issueMap = new Map<string, 'critical' | 'warning'>();
  validationSource: ValidationSource = 'none';
  validationNote = '';
  private clip: ops.Clip | null = null;
  private pasteN = 0;
  private readonly subs = new Map<string, Set<Fn<never>>>();

  constructor(plant: PlantModel) {
    this.doc = new BuilderDoc(plant);
    this.doc.on((label) => {
      this.prune();
      this.emit('change', label);
    });
  }

  on<K extends keyof EditorEvents>(k: K, fn: Fn<EditorEvents[K]>): () => void {
    let s = this.subs.get(k);
    if (!s) this.subs.set(k, (s = new Set()));
    s.add(fn as Fn<never>);
    return () => s!.delete(fn as Fn<never>);
  }

  emit<K extends keyof EditorEvents>(k: K, v: EditorEvents[K]): void {
    this.subs.get(k)?.forEach((f) => (f as Fn<EditorEvents[K]>)(v));
  }

  status(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void { this.emit('status', { text, kind }); }

  get plant(): PlantModel { return this.doc.plant; }
  get primary(): string | null { return this.selection[this.selection.length - 1] ?? null; }
  asset(id: string | null) { return id ? this.plant.assets.find((a) => a.id === id) : undefined; }

  // ---------- selection ----------

  select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    let next: string[];
    if (mode === 'replace') next = [...new Set(ids)];
    else if (mode === 'add') next = [...this.selection.filter((x) => !ids.includes(x)), ...ids];
    else {
      next = [...this.selection];
      for (const id of ids) {
        const i = next.indexOf(id);
        if (i >= 0) next.splice(i, 1); else next.push(id);
      }
    }
    const same = next.length === this.selection.length && next.every((x, i) => x === this.selection[i]);
    if (same && !this.edge) return;
    this.selection = next;
    this.edge = null;
    this.emit('selection', undefined);
  }

  selectEdge(e: Edge | null): void {
    this.selection = [];
    this.edge = e;
    this.emit('selection', undefined);
  }

  selectAll(): void { this.select(this.plant.assets.map((a) => a.id)); }

  /** Cycle the single selection through assets (Tab / Shift+Tab). */
  cycle(dir: 1 | -1): void {
    const ids = this.plant.assets.map((a) => a.id);
    if (!ids.length) return;
    const i = this.primary ? ids.indexOf(this.primary) : -1;
    const n = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : (i + dir + ids.length) % ids.length;
    this.select([ids[n]]);
    this.emit('reveal', ids[n]);
  }

  private prune(): void {
    const ids = new Set(this.plant.assets.map((a) => a.id));
    const keep = this.selection.filter((x) => ids.has(x));
    let edgeOk = !this.edge;
    if (this.edge) edgeOk = !!this.asset(this.edge.from)?.downstream.includes(this.edge.to);
    if (keep.length !== this.selection.length || !edgeOk) {
      this.selection = keep;
      if (!edgeOk) this.edge = null;
      this.emit('selection', undefined);
    }
  }

  setTool(t: Tool): void {
    if (this.tool === t && !this.placeKind) return;
    this.tool = t;
    this.placeKind = null;
    this.emit('tool', undefined);
  }

  arm(kind: AssetKind | null): void {
    this.placeKind = kind;
    if (kind) this.tool = 'select';
    this.emit('tool', undefined);
    if (kind) this.status(`Click in the plan to place a ${kind}. Esc cancels.`);
  }

  // ---------- validation ----------

  setIssues(issues: ValidationIssue[], source: ValidationSource, note = ''): void {
    this.issues = issues;
    this.issueMap = issuesByAsset(issues);
    this.validationSource = source;
    this.validationNote = note;
    this.emit('issues', undefined);
  }

  // ---------- edits ----------

  /** Run an undoable op; refusal text goes to the status bar and is returned. */
  edit(label: string, fn: (p: PlantModel) => ops.OpResult, mergeKey?: string): string | undefined {
    const r = this.doc.edit(label, fn, mergeKey);
    if (typeof r === 'string') { this.status(r, 'error'); return r; }
    return undefined;
  }

  add(kind: AssetKind, x: number, z: number): string {
    let id = '';
    this.doc.edit(`Add ${kind}`, (p) => { id = ops.addAsset(p, kind, x, z); });
    this.select([id]);
    this.status(`Added ${id}`, 'ok');
    return id;
  }

  deleteSelection(): void {
    if (this.edge) { this.disconnect(this.edge); return; }
    const ids = [...this.selection];
    if (!ids.length) return;
    if (!this.edit(ids.length === 1 ? `Delete ${ids[0]}` : `Delete ${ids.length} assets`, (p) => ops.deleteAssets(p, ids))) {
      this.status(`Deleted ${ids.join(', ')}`, 'ok');
    }
  }

  connect(from: string, to: string): boolean {
    if (this.edit(`Connect ${from} → ${to}`, (p) => ops.connect(p, from, to))) return false;
    this.status(`Connected ${from} → ${to}`, 'ok');
    return true;
  }

  disconnect(e: Edge): void {
    if (!this.edit(`Disconnect ${e.from} → ${e.to}`, (p) => ops.disconnect(p, e.from, e.to))) {
      this.edge = null;
      this.status(`Removed flow ${e.from} → ${e.to}`, 'ok');
      this.emit('selection', undefined);
    }
  }

  /** Connect the selection in selection order: A → B → C. */
  chainSelection(): void {
    const ids = this.selection;
    if (ids.length < 2) { this.status('Select two or more assets in flow order to connect them', 'error'); return; }
    this.edit(`Connect ${ids.join(' → ')}`, (p) => {
      for (let i = 0; i + 1 < ids.length; i++) {
        const why = ops.canConnect(p, ids[i], ids[i + 1]);
        if (why && !/already/.test(why)) return why;
        if (!why) ops.connect(p, ids[i], ids[i + 1]);
      }
    });
  }

  move(dx: number, dz: number, label = 'Move', mergeKey?: string): void {
    if (!this.selection.length || (dx === 0 && dz === 0)) return;
    const ids = [...this.selection];
    this.edit(ids.length === 1 ? `${label} ${ids[0]}` : `${label} ${ids.length} assets`, (p) => ops.moveAssets(p, ids, dx, dz), mergeKey);
  }

  rotate(deg: number): void {
    const ids = [...this.selection];
    if (!ids.length) { this.status('Select an asset to rotate', 'error'); return; }
    this.edit(`Rotate ${deg > 0 ? '+' : ''}${deg}°`, (p) => ops.rotateAssets(p, ids, deg, this.snapOn ? 0.5 : 0.001));
  }

  copy(): boolean {
    const c = ops.copyAssets(this.plant, this.selection);
    if (!c) { this.status('Nothing selected to copy', 'error'); return false; }
    this.clip = c;
    this.pasteN = 0;
    this.status(`Copied ${c.assets.length} asset${c.assets.length > 1 ? 's' : ''}`);
    return true;
  }

  cut(): void { if (this.copy()) this.deleteSelection(); }

  get canPaste(): boolean { return !!this.clip; }

  paste(): void {
    if (!this.clip) { this.status('Clipboard is empty', 'error'); return; }
    const clip = this.clip;
    const k = ++this.pasteN;
    let ids: string[] = [];
    this.doc.edit(`Paste ${clip.assets.length}`, (p) => { ids = ops.pasteAssets(p, clip, 1 * k, 1 * k); });
    this.select(ids);
    this.status(`Pasted ${ids.join(', ')}`, 'ok');
  }

  duplicate(): void { if (this.copy()) this.paste(); }

  undo(): void { if (!this.doc.undo()) this.status('Nothing to undo'); }
  redo(): void { if (!this.doc.redo()) this.status('Nothing to redo'); }

  /** Rename and keep the selection on the renamed asset. */
  rename(oldId: string, newId: string): string | undefined {
    const err = this.edit(`Rename ${oldId} → ${newId}`, (p) => ops.renameAsset(p, oldId, newId));
    if (!err) this.select(this.selection.map((x) => (x === oldId ? newId.trim() : x)).concat(this.selection.includes(oldId) ? [] : [newId.trim()]));
    return err;
  }

  load(plant: PlantModel, origin: string, clean = true): void {
    this.selection = [];
    this.edge = null;
    this.placeKind = null;
    this.doc.load(plant, origin, clean);
    this.emit('selection', undefined);
    this.emit('fit', undefined);
  }
}
