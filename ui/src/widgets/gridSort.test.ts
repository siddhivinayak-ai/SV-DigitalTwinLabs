import { describe, expect, it } from 'vitest';
import { compareValues, nextSort, sortRows, visibleRange } from './gridSort';

interface R { id: string; v?: number; name: string }
const rows: R[] = [
  { id: 'a', v: 3, name: 'CNC-10' },
  { id: 'b', v: 1, name: 'cnc-2' },
  { id: 'c', name: 'Buf-01' },
  { id: 'd', v: 3, name: 'Robot' },
  { id: 'e', v: -2, name: '' },
];

describe('DataGrid sorting', () => {
  it('sorts numbers ascending, empties last, stable for ties', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.id)).toEqual(['e', 'b', 'a', 'd', 'c']);
  });
  it('sorts descending but keeps empties at the bottom and ties stable', () => {
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.id)).toEqual(['a', 'd', 'b', 'e', 'c']);
  });
  it('uses natural, case-insensitive string order', () => {
    expect(sortRows(rows, (r) => r.name, 'asc').map((r) => r.name)).toEqual(['Buf-01', 'cnc-2', 'CNC-10', 'Robot', '']);
  });
  it('does not mutate the input', () => {
    const copy = rows.slice();
    sortRows(rows, (r) => r.v, 'desc');
    expect(rows).toEqual(copy);
  });
  it('compareValues treats NaN/null as empty', () => {
    expect(compareValues(Number.NaN, 1)).toBeGreaterThan(0);
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(2, 10)).toBeLessThan(0);
  });
  it('header click cycles asc → desc and restarts on a new column', () => {
    let s = nextSort(null, 'wear');
    expect(s).toEqual({ key: 'wear', dir: 'asc' });
    s = nextSort(s, 'wear');
    expect(s).toEqual({ key: 'wear', dir: 'desc' });
    s = nextSort(s, 'wear');
    expect(s.dir).toBe('asc');
    expect(nextSort(s, 'oee')).toEqual({ key: 'oee', dir: 'asc' });
  });
});

describe('virtualisation window', () => {
  it('covers the viewport plus overscan, clamped to the data', () => {
    expect(visibleRange(0, 180, 18, 1000, 4)).toEqual({ first: 0, last: 14 });
    expect(visibleRange(1800, 180, 18, 1000, 4)).toEqual({ first: 96, last: 114 });
    expect(visibleRange(17_900, 180, 18, 1000, 4)).toEqual({ first: 990, last: 1000 });
    expect(visibleRange(0, 180, 18, 0)).toEqual({ first: 0, last: 0 });
  });
});
