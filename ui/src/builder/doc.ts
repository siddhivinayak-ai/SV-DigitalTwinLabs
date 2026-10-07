// Plant Builder document: the working PlantModel plus an exact snapshot-based undo/redo stack.
// Every edit stores the JSON of the plant before and after, so undo/redo restore byte-for-byte.
import type { PlantModel } from '../net/contracts';
import { clonePlant, normalizePlant } from './model';

interface Entry { label: string; before: string; after: string; beforeRev: number; afterRev: number; mergeKey?: string; at: number }

export const UNDO_LIMIT = 200;

export class BuilderDoc {
  private json: string;
  private cur: PlantModel;
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private rev = 0;
  private nextRev = 1;
  private cleanRev = 0;
  private readonly listeners = new Set<(label: string) => void>();
  /** Where the document came from (title bar / status). */
  origin = 'New';
  /** Saved layout id when opened from or saved to /api/layouts. */
  layoutId: string | null = null;
  layoutName: string | null = null;

  constructor(plant: PlantModel, private readonly limit = UNDO_LIMIT, private readonly now: () => number = () => Date.now()) {
    this.cur = normalizePlant(plant);
    this.json = JSON.stringify(this.cur);
  }

  /** The current plant. Treat as read-only; change it only through edit(). */
  get plant(): PlantModel { return this.cur; }

  /** A detached deep copy (for Apply / Save / Export). */
  snapshot(): PlantModel { return clonePlant(this.cur); }

  on(fn: (label: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(label: string): void { this.listeners.forEach((f) => f(label)); }

  /**
   * Apply `fn` to a copy of the plant as one undoable step. If `fn` returns a string, the edit is
   * refused and that string is returned. Consecutive edits with the same mergeKey within 1.5 s
   * coalesce into one step (nudges, drags).
   */
  edit<R>(label: string, fn: (p: PlantModel) => R, mergeKey?: string): R {
    const draft = clonePlant(this.cur);
    const r = fn(draft);
    if (typeof r === 'string') return r;
    const after = JSON.stringify(draft);
    if (after === this.json) return r;
    const t = this.now();
    const top = this.undoStack[this.undoStack.length - 1];
    const rev = this.nextRev++;
    if (mergeKey && top && top.mergeKey === mergeKey && t - top.at < 1500 && !this.redoStack.length && top.afterRev === this.rev) {
      top.after = after;
      top.afterRev = rev;
      top.at = t;
    } else {
      this.undoStack.push({ label, before: this.json, after, beforeRev: this.rev, afterRev: rev, mergeKey, at: t });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.set(after, rev);
    this.emit(label);
    return r;
  }

  /** Replace the whole document (New / Open / Import); clears history. */
  load(plant: PlantModel, origin: string, clean = true): void {
    this.cur = normalizePlant(plant);
    this.json = JSON.stringify(this.cur);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.rev = this.nextRev++;
    this.cleanRev = clean ? this.rev : -1;
    this.origin = origin;
    this.emit('load');
  }

  undo(): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    this.redoStack.push(e);
    this.set(e.before, e.beforeRev);
    this.emit(`Undo ${e.label}`);
    return true;
  }

  redo(): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    this.undoStack.push(e);
    this.set(e.after, e.afterRev);
    this.emit(`Redo ${e.label}`);
    return true;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | null { return this.undoStack[this.undoStack.length - 1]?.label ?? null; }
  get redoLabel(): string | null { return this.redoStack[this.redoStack.length - 1]?.label ?? null; }
  get undoDepth(): number { return this.undoStack.length; }

  get dirty(): boolean { return this.rev !== this.cleanRev; }
  markClean(): void { this.cleanRev = this.rev; this.emit('clean'); }

  private set(json: string, rev: number): void {
    this.json = json;
    this.cur = JSON.parse(json) as PlantModel;
    this.rev = rev;
  }
}
