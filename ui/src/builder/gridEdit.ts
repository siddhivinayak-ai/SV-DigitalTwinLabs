// In-place cell editing for the shared DataGrid (WinForms DataGridView style): double-click or F2
// opens an editor over the cell; Enter/Tab commit, Esc cancels, Tab moves to the next editable column.
import type { Column, DataGrid } from '../widgets/DataGrid';
import { h } from '../widgets/dom';

export interface CellEditor<T> {
  kind: 'text' | 'num' | 'enum';
  options?: string[] | ((row: T) => string[]);
  /** Current editable text. */
  get(row: T): string;
  /** Commit text; return an error string to refuse. */
  set(row: T, text: string): string | void;
}

export function attachCellEditing<T>(
  grid: DataGrid<T>,
  columns: Column<T>[],
  editors: Record<string, CellEditor<T>>,
  rowById: (id: string) => T | undefined,
  onError: (msg: string) => void,
): { edit(rowId: string, key?: string): void } {
  let open: { el: HTMLInputElement | HTMLSelectElement; done: (commit: boolean, move?: 1 | -1) => void } | null = null;
  const editable = columns.map((c) => c.key).filter((k) => editors[k]);

  const cellFor = (rowId: string, key: string): HTMLElement | null => {
    const ci = columns.findIndex((c) => c.key === key);
    grid.select(rowId);
    const row = grid.el.querySelector<HTMLElement>('.dgrid-row.sel');
    return (row?.children[ci] as HTMLElement | undefined) ?? null;
  };

  const edit = (rowId: string, key = editable[0]): void => {
    open?.done(true);
    const row = rowById(rowId);
    const ed = key ? editors[key] : undefined;
    if (!row || !ed) return;
    const cell = cellFor(rowId, key);
    if (!cell) return;
    const r = cell.getBoundingClientRect();
    let el: HTMLInputElement | HTMLSelectElement;
    if (ed.kind === 'enum') {
      const sel = h('select.bld-cell-edit');
      const opts = typeof ed.options === 'function' ? ed.options(row) : ed.options ?? [];
      for (const o of opts) sel.append(h('option', { value: o, text: o === '' ? '(none)' : o }));
      sel.value = ed.get(row);
      el = sel;
    } else {
      const inp = h('input.bld-cell-edit', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
      inp.value = ed.get(row);
      if (ed.kind === 'num') inp.classList.add('num');
      el = inp;
    }
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${Math.max(40, r.width)}px`;
    el.style.height = `${r.height}px`;
    document.body.append(el);
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
    let closed = false;
    const done = (commit: boolean, move?: 1 | -1) => {
      if (closed) return;
      closed = true;
      open = null;
      const value = el.value;
      el.remove();
      if (commit && value !== ed.get(row)) {
        const err = ed.set(row, value);
        if (err) onError(err);
      }
      if (move) {
        const i = editable.indexOf(key) + move;
        if (i >= 0 && i < editable.length) { edit(rowId, editable[i]); return; }
      }
      grid.el.focus();
    };
    open = { el, done };
    el.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      ke.stopPropagation();
      if (ke.key === 'Enter') { ke.preventDefault(); done(true); }
      else if (ke.key === 'Escape') { ke.preventDefault(); done(false); }
      else if (ke.key === 'Tab') { ke.preventDefault(); done(true, ke.shiftKey ? -1 : 1); }
    });
    if (el instanceof HTMLSelectElement) el.addEventListener('change', () => done(true));
    el.addEventListener('blur', () => setTimeout(() => done(true), 0));
  };

  grid.el.addEventListener('dblclick', (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.dgrid-cell');
    const rowEl = cell?.parentElement;
    if (!cell || !rowEl) return;
    const ci = [...rowEl.children].indexOf(cell);
    const key = columns[ci]?.key;
    const id = grid.selection;
    if (id && key && editors[key]) edit(id, key);
  });
  grid.el.addEventListener('keydown', (e) => {
    if (e.key === 'F2' && grid.selection) { e.preventDefault(); e.stopPropagation(); edit(grid.selection); }
  });
  grid.el.querySelector('.dgrid-body')?.addEventListener('scroll', () => open?.done(true), { passive: true });
  return { edit };
}
