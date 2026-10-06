// Virtualised, sortable, resizable data grid. A fixed pool of row elements is recycled while
// scrolling; live updates rewrite cell text in place (no per-tick DOM rebuilds).
import { h, svg, setText, storage, clamp } from './dom';
import { icons } from './icons';
import { nextSort, sortRows, visibleRange, type SortDir, type SortValue } from './gridSort';

export interface Column<T> {
  key: string;
  title: string;
  width: number;
  minWidth?: number;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  sortable?: boolean;
  /** Display text (default: String(row[key])). */
  text?: (row: T) => string;
  /** Sort key (default: text). */
  sortKey?: (row: T) => SortValue;
  /** Extra class on the text span (e.g. abnormal colouring). */
  cellClass?: (row: T) => string;
  /** Custom in-place renderer; must fully set the cell's state each call (rows are recycled). */
  render?: (cell: HTMLElement, row: T) => void;
  tooltip?: string;
}

export interface DataGridOptions<T> {
  columns: Column<T>[];
  rowId: (row: T) => string;
  rowClass?: (row: T) => string;
  onSelect?: (row: T | null) => void;
  onActivate?: (row: T) => void;
  emptyText?: string;
  /** Persist column widths in localStorage under this key. */
  storageKey?: string;
  initialSort?: { key: string; dir: SortDir } | null;
  framed?: boolean;
}

interface RowSlot { el: HTMLDivElement; cells: HTMLDivElement[]; spans: (HTMLSpanElement | null)[]; index: number }

const ROW_H = 18;

export class DataGrid<T> {
  readonly el: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly headInner: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly hcells: HTMLDivElement[] = [];
  private readonly slots: RowSlot[] = [];
  private raw: T[] = [];
  private rows: T[] = [];
  private widths: number[];
  private sort: { key: string; dir: SortDir } | null;
  private selectedId: string | null = null;
  private focusIndex = -1;
  private readonly ro: ResizeObserver;
  private raf = 0;

  constructor(private readonly opt: DataGridOptions<T>) {
    this.sort = opt.initialSort ?? null;
    this.widths = this.loadWidths();
    this.el = h('div.dgrid', { tabindex: 0, role: 'grid' });
    if (opt.framed) this.el.classList.add('framed');
    this.head = h('div.dgrid-head');
    this.headInner = h('div.dgrid-head-inner');
    this.head.append(this.headInner);
    this.body = h('div.dgrid-body');
    this.spacer = h('div.dgrid-spacer');
    this.empty = h('div.dgrid-empty', { text: opt.emptyText ?? '(no rows)' });
    this.body.append(this.spacer, this.empty);
    this.el.append(this.head, this.body);
    this.buildHeader();
    this.applyWidths();

    this.body.addEventListener('scroll', () => {
      this.headInner.style.transform = `translateX(${-this.body.scrollLeft}px)`;
      this.schedule();
    }, { passive: true });
    this.body.addEventListener('mousedown', (e) => this.onRowMouse(e));
    this.body.addEventListener('dblclick', (e) => {
      const i = this.rowIndexFromEvent(e);
      if (i >= 0) opt.onActivate?.(this.rows[i]);
    });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.body);
  }

  // ---------- public API ----------

  setRows(rows: T[]): void {
    this.raw = rows;
    this.applySort();
    this.render();
  }

  /** Re-render visible rows (row objects mutated or derived values changed). */
  refresh(): void { this.render(); }

  get rowCount(): number { return this.rows.length; }
  get selection(): string | null { return this.selectedId; }

  select(id: string | null, scrollIntoView = true): void {
    this.selectedId = id;
    const i = id === null ? -1 : this.rows.findIndex((r) => this.opt.rowId(r) === id);
    this.focusIndex = i;
    if (i >= 0 && scrollIntoView) this.ensureVisible(i);
    this.render();
  }

  isAtBottom(): boolean {
    const b = this.body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < ROW_H;
  }

  scrollToBottom(): void {
    this.body.scrollTop = this.body.scrollHeight;
  }

  setSort(key: string | null, dir: SortDir = 'asc'): void {
    this.sort = key ? { key, dir } : null;
    this.applySort();
    this.updateHeaderSort();
    this.render();
  }

  dispose(): void {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }

  // ---------- header ----------

  private buildHeader(): void {
    this.opt.columns.forEach((c, i) => {
      const cell = h(`div.dgrid-hcell.${c.align ?? 'left'}`, { title: c.tooltip ?? c.title });
      if (c.sortable === false) cell.classList.add('nosort');
      const text = h('span.htext', { text: c.title });
      cell.append(text);
      const rz = h('div.resizer');
      rz.addEventListener('mousedown', (e) => this.startResize(e, i));
      rz.addEventListener('click', (e) => e.stopPropagation());
      rz.addEventListener('dblclick', (e) => { e.stopPropagation(); this.setWidth(i, c.width); });
      cell.append(rz);
      cell.addEventListener('click', () => {
        if (c.sortable === false) return;
        this.sort = nextSort(this.sort, c.key);
        this.applySort();
        this.updateHeaderSort();
        this.render();
      });
      this.hcells.push(cell);
      this.headInner.append(cell);
    });
    this.headInner.append(h('div.dgrid-hfill'));
    this.updateHeaderSort();
  }

  private updateHeaderSort(): void {
    this.opt.columns.forEach((c, i) => {
      const cell = this.hcells[i];
      cell.querySelector('svg.sort')?.remove();
      if (this.sort?.key === c.key) {
        const arrow = svg(this.sort.dir === 'asc' ? icons.arrowUp : icons.arrowDown, 'sort');
        if (c.align === 'right') cell.insertBefore(arrow, cell.firstChild);
        else cell.insertBefore(arrow, cell.querySelector('.resizer'));
      }
    });
  }

  private startResize(e: MouseEvent, i: number): void {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = this.widths[i];
    const min = this.opt.columns[i].minWidth ?? 24;
    document.body.classList.add('resizing-col');
    const move = (ev: MouseEvent) => this.setWidth(i, Math.max(min, w0 + ev.clientX - x0), false);
    const up = () => {
      document.body.classList.remove('resizing-col');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.saveWidths();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private setWidth(i: number, w: number, save = true): void {
    this.widths[i] = Math.round(w);
    this.applyWidths();
    if (save) this.saveWidths();
  }

  private applyWidths(): void {
    let total = 0;
    this.widths.forEach((w, i) => {
      this.el.style.setProperty(`--cw${i}`, `${w}px`);
      total += w;
    });
    this.spacer.style.width = `${total}px`;
    this.hcells.forEach((c, i) => (c.style.width = `var(--cw${i})`));
    for (const s of this.slots) s.el.style.width = `${total}px`;
  }

  private loadWidths(): number[] {
    const def = this.opt.columns.map((c) => c.width);
    if (!this.opt.storageKey) return def;
    try {
      const saved = JSON.parse(storage.get(this.opt.storageKey) ?? 'null') as number[] | null;
      if (Array.isArray(saved) && saved.length === def.length && saved.every((n) => typeof n === 'number' && n > 0)) return saved;
    } catch { /* ignore */ }
    return def;
  }

  private saveWidths(): void {
    if (this.opt.storageKey) storage.set(this.opt.storageKey, JSON.stringify(this.widths));
  }

  // ---------- data ----------

  private applySort(): void {
    const col = this.sort ? this.opt.columns.find((c) => c.key === this.sort!.key) : undefined;
    if (!col || !this.sort) this.rows = this.raw.slice();
    else {
      const key = col.sortKey ?? col.text ?? ((r: T) => (r as Record<string, SortValue>)[col.key]);
      this.rows = sortRows(this.raw, key as (r: T) => SortValue, this.sort.dir);
    }
    if (this.selectedId !== null) this.focusIndex = this.rows.findIndex((r) => this.opt.rowId(r) === this.selectedId);
  }

  private cellText(c: Column<T>, row: T): string {
    if (c.text) return c.text(row);
    const v = (row as Record<string, unknown>)[c.key];
    return v === undefined || v === null ? '' : String(v);
  }

  // ---------- rendering ----------

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private render(): void {
    const n = this.rows.length;
    this.spacer.style.height = `${n * ROW_H}px`;
    this.empty.style.display = n ? 'none' : '';
    const { first, last } = visibleRange(this.body.scrollTop, this.body.clientHeight || 200, ROW_H, n);
    const need = last - first;
    while (this.slots.length < need) this.slots.push(this.makeSlot());
    for (let j = 0; j < this.slots.length; j++) {
      const slot = this.slots[j];
      const i = first + j;
      if (j >= need) {
        if (slot.index !== -1) { slot.el.style.display = 'none'; slot.index = -1; }
        continue;
      }
      if (slot.index === -1) slot.el.style.display = '';
      slot.index = i;
      this.fillSlot(slot, this.rows[i], i);
    }
  }

  private makeSlot(): RowSlot {
    const el = h('div.dgrid-row', { role: 'row' });
    const cells: HTMLDivElement[] = [];
    const spans: (HTMLSpanElement | null)[] = [];
    let total = 0;
    this.opt.columns.forEach((c, i) => {
      const cell = h(`div.dgrid-cell.${c.align ?? 'left'}`);
      if (c.mono) cell.classList.add('mono');
      cell.style.width = `var(--cw${i})`;
      let span: HTMLSpanElement | null = null;
      if (!c.render) { span = h('span.ct'); cell.append(span); }
      cells.push(cell);
      spans.push(span);
      el.append(cell);
      total += this.widths[i];
    });
    el.style.width = `${total}px`;
    this.spacer.append(el);
    return { el, cells, spans, index: -1 };
  }

  private fillSlot(slot: RowSlot, row: T, i: number): void {
    const id = this.opt.rowId(row);
    const top = `${i * ROW_H}px`;
    if (slot.el.style.top !== top) slot.el.style.top = top;
    let cls = 'dgrid-row';
    if (i % 2 === 1) cls += ' alt';
    if (id === this.selectedId) cls += ' sel';
    if (i === this.focusIndex) cls += ' focus';
    const extra = this.opt.rowClass?.(row);
    if (extra) cls += ' ' + extra;
    if (slot.el.className !== cls) slot.el.className = cls;
    slot.el.dataset.index = String(i);
    this.opt.columns.forEach((c, k) => {
      if (c.render) { c.render(slot.cells[k], row); return; }
      const span = slot.spans[k]!;
      setText(span, this.cellText(c, row));
      const sc = 'ct' + (c.cellClass ? ' ' + c.cellClass(row) : '');
      if (span.className !== sc) span.className = sc.trim();
    });
  }

  // ---------- interaction ----------

  private rowIndexFromEvent(e: Event): number {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.dgrid-row');
    return rowEl ? Number(rowEl.dataset.index) : -1;
  }

  private onRowMouse(e: MouseEvent): void {
    if (e.button !== 0) return;
    const i = this.rowIndexFromEvent(e);
    if (i < 0 || i >= this.rows.length) return;
    this.selectIndex(i);
  }

  private selectIndex(i: number): void {
    i = clamp(i, 0, this.rows.length - 1);
    if (i < 0) return;
    const row = this.rows[i];
    this.focusIndex = i;
    this.selectedId = this.opt.rowId(row);
    this.ensureVisible(i);
    this.render();
    this.opt.onSelect?.(row);
  }

  private ensureVisible(i: number): void {
    const b = this.body;
    const top = i * ROW_H;
    if (top < b.scrollTop) b.scrollTop = top;
    else if (top + ROW_H > b.scrollTop + b.clientHeight) b.scrollTop = top + ROW_H - b.clientHeight;
  }

  private onKey(e: KeyboardEvent): void {
    const page = Math.max(1, Math.floor(this.body.clientHeight / ROW_H) - 1);
    const cur = this.focusIndex;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown': next = cur + 1; break;
      case 'ArrowUp': next = Math.max(0, cur - 1); break;
      case 'PageDown': next = cur + page; break;
      case 'PageUp': next = Math.max(0, cur - page); break;
      case 'Home': next = 0; break;
      case 'End': next = this.rows.length - 1; break;
      case 'Enter':
        if (cur >= 0 && this.rows[cur]) { this.opt.onActivate?.(this.rows[cur]); e.preventDefault(); }
        return;
      default: return;
    }
    e.preventDefault();
    if (this.rows.length) this.selectIndex(next);
  }
}
