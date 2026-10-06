import { describe, expect, it } from 'vitest';
import { matchAccel, parseAccel, shortcutFor } from './keyboard';
import { historyToCsv } from './exportCsv';
import { DEFAULT_LAYOUT, restoreLayout } from './DockLayout';
import { connectionLabel } from './StatusBar';
import { parseMnemonic } from '../widgets/Menu';
import { parseNumeric } from '../widgets/NumericInput';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe('keyboard shortcuts', () => {
  it('parses accelerators', () => {
    expect(parseAccel('Ctrl+Shift+R')).toEqual({ key: 'r', ctrl: true, shift: true, alt: false });
    expect(parseAccel('F5')).toEqual({ key: 'f5', ctrl: false, shift: false, alt: false });
  });
  it('matches modifiers exactly', () => {
    expect(matchAccel(key('F5'), 'F5')).toBe(true);
    expect(matchAccel(key('F5', { shiftKey: true }), 'F5')).toBe(false);
    expect(matchAccel(key('R', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+R')).toBe(true);
  });
  it('maps the spec shortcuts', () => {
    expect(shortcutFor(key('F5'))).toBe('start');
    expect(shortcutFor(key('F6'))).toBe('pause');
    expect(shortcutFor(key('F5', { shiftKey: true }))).toBe('stop');
    expect(shortcutFor(key('R', { ctrlKey: true, shiftKey: true }))).toBe('reset');
    expect(shortcutFor(key('e', { ctrlKey: true }))).toBe('export');
    expect(shortcutFor(key('w', { ctrlKey: true }))).toBe('whatIf');
    expect(shortcutFor(key('a'))).toBeNull();
  });
});

describe('historyToCsv', () => {
  it('aligns series on the union of sample times', () => {
    const data: Record<string, { t: number[]; v: number[] }> = {
      'A.temp': { t: [0.2, 0.4, 0.6], v: [20, 21, 22] },
      'B.vib': { t: [0.4, 0.6], v: [1.5, 1.6] },
    };
    expect(historyToCsv(['A.temp', 'B.vib'], (id) => data[id])).toBe(
      'simTimeMs,A.temp,B.vib\n200,20,\n400,21,1.5\n600,22,1.6\n');
    expect(historyToCsv(['A.temp'], (id) => data[id], 0.4)).toBe('simTimeMs,A.temp\n400,21\n600,22\n');
  });
});

describe('layout persistence', () => {
  it('restores defaults for missing or malformed state', () => {
    expect(restoreLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(restoreLayout('{oops')).toEqual(DEFAULT_LAYOUT);
  });
  it('keeps valid values and drops invalid ones', () => {
    const r = restoreLayout(JSON.stringify({ sizes: { left: 300, right: -5, bottom: 'x' }, visible: { left: false, kpi: 1 }, bottomTab: 'alarms' }));
    expect(r.sizes).toEqual({ ...DEFAULT_LAYOUT.sizes, left: 300 });
    expect(r.visible).toEqual({ ...DEFAULT_LAYOUT.visible, left: false });
    expect(r.bottomTab).toBe('alarms');
  });
});

describe('misc widgets logic', () => {
  it('connection labels', () => {
    expect(connectionLabel('connected').text).toBe('CONNECTED');
    expect(connectionLabel('connecting').text).toBe('CONNECTING');
    expect(connectionLabel('disconnected').text).toBe('OFFLINE');
    expect(connectionLabel('mock').text).toBe('DEMO');
  });
  it('menu mnemonics', () => {
    expect(parseMnemonic('&File')).toEqual({ text: 'File', mnemonic: 'f', idx: 0 });
    expect(parseMnemonic('Spee&d')).toEqual({ text: 'Speed', mnemonic: 'd', idx: 4 });
    expect(parseMnemonic('Plain').mnemonic).toBeNull();
  });
  it('numeric parsing with bounds', () => {
    expect(parseNumeric(' 1,200.5 ')).toBe(1200.5);
    expect(parseNumeric('1e3')).toBe(1000);
    expect(parseNumeric('abc')).toBeNull();
    expect(parseNumeric('-1', 0)).toBeNull();
    expect(parseNumeric('')).toBeNull();
  });
});
