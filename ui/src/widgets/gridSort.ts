// Pure sorting used by DataGrid (unit-tested, DOM-free).

export type SortDir = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;

/** Compare two sort keys: numbers numerically, strings with natural (numeric-aware) order, empties last. */
export function compareValues(a: SortValue, b: SortValue): number {
  const ae = a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a)) || a === '';
  const be = b === null || b === undefined || (typeof b === 'number' && Number.isNaN(b)) || b === '';
  if (ae || be) return ae === be ? 0 : ae ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Stable sort of `rows` by `key(row)`. Empty values always sort to the bottom regardless of direction.
 * Returns a new array; the input is untouched.
 */
export function sortRows<T>(rows: readonly T[], key: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const decorated = rows.map((row, i) => ({ row, i, k: key(row) }));
  decorated.sort((x, y) => {
    const xe = x.k === null || x.k === undefined || x.k === '';
    const ye = y.k === null || y.k === undefined || y.k === '';
    if (xe || ye) return xe === ye ? x.i - y.i : xe ? 1 : -1;
    return compareValues(x.k, y.k) * sign || x.i - y.i;
  });
  return decorated.map((d) => d.row);
}

/** Header click cycle: unsorted → asc → desc → asc… ; clicking another column starts at asc. */
export function nextSort(
  current: { key: string; dir: SortDir } | null,
  clicked: string,
): { key: string; dir: SortDir } {
  if (!current || current.key !== clicked) return { key: clicked, dir: 'asc' };
  return { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/** Visible row window for virtualisation. */
export function visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 4) {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + overscan);
  return { first, last };
}
