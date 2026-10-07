import { describe, expect, it } from 'vitest';
import type { Alarm, EventRecord, ScenarioSummary } from '../net/contracts';
import {
  HistoryPager, ValueAgeTracker, alarmMatches, connectionLed, connectionsSummary, defaultScenarioName, formatAge, formatHorizon,
  historyEventMatches, modeCommandValue, modeToggleState, scenarioOverrideRows, scenarioRows, sortConnections, toCsv,
} from './logic';

describe('formatAge', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatAge(3200)).toBe('3.2 s ago');
    expect(formatAge(400)).toBe('0.4 s ago');
    expect(formatAge(-5)).toBe('0.0 s ago');
    expect(formatAge(245_000)).toBe('4 min 05 s ago');
    expect(formatAge(2 * 3600_000 + 7 * 60_000)).toBe('2 h 07 min ago');
    expect(formatAge(undefined)).toBe('—');
    expect(formatAge(null)).toBe('—');
    expect(formatAge(NaN)).toBe('—');
  });
});

describe('ValueAgeTracker', () => {
  it('anchors on sim age divided by speed, then ticks in wall time', () => {
    const t = new ValueAgeTracker();
    t.observe({ id: 'plc1', lastValueMs: 10_000 }, { simTimeMs: 30_000, speed: 10 }, 1000);
    expect(t.ageMs('plc1', 1000)).toBe(2000); // 20 s sim at 10× = 2 s wall
    expect(t.ageMs('plc1', 2500)).toBe(3500);
    // same stamp again does not reset the anchor
    t.observe({ id: 'plc1', lastValueMs: 10_000 }, { simTimeMs: 40_000, speed: 10 }, 2500);
    expect(t.ageMs('plc1', 2500)).toBe(3500);
    // fresh stamp resets
    t.observe({ id: 'plc1', lastValueMs: 40_000 }, { simTimeMs: 40_000, speed: 10 }, 3000);
    expect(t.ageMs('plc1', 3100)).toBe(100);
  });
  it('returns null without a value', () => {
    const t = new ValueAgeTracker();
    t.observe({ id: 'x', lastValueMs: undefined }, { simTimeMs: 0, speed: 1 }, 0);
    expect(t.ageMs('x', 100)).toBeNull();
  });
});

describe('connections', () => {
  it('maps status to LEDs', () => {
    expect(connectionLed('connected')).toEqual({ led: 'running', blink: false });
    expect(connectionLed('connecting')).toEqual({ led: 'starved', blink: true });
    expect(connectionLed('error').led).toBe('fault');
    expect(connectionLed('disabled').led).toBe('off');
  });
  it('sorts errors first and summarises', () => {
    const list = [
      { id: 'b', kind: 'mqtt' as const, endpoint: '', status: 'connected' as const, boundTags: 2 },
      { id: 'a', kind: 'opcua' as const, endpoint: '', status: 'error' as const, boundTags: 3, error: 'timeout' },
    ];
    expect(sortConnections(list).map((c) => c.id)).toEqual(['a', 'b']);
    expect(connectionsSummary(list)).toBe('2 connections · 1 connected · 1 in error · 5 bound tags');
    expect(connectionsSummary([])).toBe('No connections');
  });
});

describe('modeToggleState', () => {
  it('reflects simulate mode', () => {
    const s = modeToggleState({ mode: 'simulate' }, true);
    expect(s).toMatchObject({ simulateChecked: true, shadowChecked: false, disabled: false, speedDisabled: false, statusText: 'SIM' });
  });
  it('reflects shadow mode and disables speed', () => {
    const s = modeToggleState({ mode: 'shadow' }, true);
    expect(s).toMatchObject({ simulateChecked: false, shadowChecked: true, speedDisabled: true, statusText: 'SHADOW' });
  });
  it('shows the pending choice and locks while a switch is in flight', () => {
    const s = modeToggleState({ mode: 'simulate' }, true, 'shadow');
    expect(s).toMatchObject({ shadowChecked: true, disabled: true, statusText: 'SIM' });
  });
  it('disables everything offline and maps command values', () => {
    expect(modeToggleState({ mode: 'simulate' }, false)).toMatchObject({ disabled: true, speedDisabled: true });
    expect(modeCommandValue('shadow')).toBe(1);
    expect(modeCommandValue('simulate')).toBe(0);
  });
});

describe('scenarios', () => {
  const list: ScenarioSummary[] = [
    { id: 'a', name: 'Old', createdAtUtc: '2026-10-01T08:00:00Z', durationS: 3600, overrides: 1 },
    { id: 'b', name: '', createdAtUtc: '2026-10-07T09:30:00Z', durationS: 28800, overrides: 2 },
    { id: 'c', name: 'Half', createdAtUtc: 'garbage', durationS: 1800, overrides: 0 },
  ];
  it('maps summaries to rows, newest first', () => {
    const rows = scenarioRows(list);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(rows[0]).toMatchObject({ name: '(unnamed)', duration: '8 h', overrides: 2 });
    expect(rows[0].created).toMatch(/^2026-10-0[67] \d\d:\d\d$/);
    expect(rows[2]).toMatchObject({ created: 'garbage', duration: '30 min' });
    expect(formatHorizon(5400)).toBe('1.5 h');
  });
  it('flattens overrides for the editor and names defaults', () => {
    const rows = scenarioOverrideRows({ request: { durationS: 1, overrides: [{ assetId: 'CNC-01', params: { cycleTimeS: 18, mttrS: 200 } }, { assetId: 'BUF-01', params: { capacity: 30 } }] } });
    expect(rows).toEqual([
      { assetId: 'CNC-01', param: 'cycleTimeS', value: 18 },
      { assetId: 'CNC-01', param: 'mttrS', value: 200 },
      { assetId: 'BUF-01', param: 'capacity', value: 30 },
    ]);
    expect(defaultScenarioName(rows)).toBe('CNC-01 cycleTimeS=18, CNC-01 mttrS=200 (+1)');
    expect(defaultScenarioName([])).toBe('Baseline');
  });
});

describe('HistoryPager', () => {
  const all = Array.from({ length: 450 }, (_, i) => ({ id: i + 1 })); // ids 1..450
  const fetcher = (calls: (number | undefined)[]) => async (limit: number, beforeId?: number) => {
    calls.push(beforeId);
    return all.filter((r) => beforeId === undefined || r.id < beforeId).sort((a, b) => b.id - a.id).slice(0, limit);
  };
  it('pages with beforeId until exhausted', async () => {
    const calls: (number | undefined)[] = [];
    const p = new HistoryPager(fetcher(calls), 200);
    await p.reload();
    expect(p.rows).toHaveLength(200);
    expect(p.rows[0].id).toBe(450);
    expect(p.oldestId).toBe(251);
    expect(p.done).toBe(false);
    await p.loadMore();
    expect(p.oldestId).toBe(51);
    await p.loadMore();
    expect(p.rows).toHaveLength(450);
    expect(p.done).toBe(true);
    expect(await p.loadMore()).toEqual([]);
    expect(calls).toEqual([undefined, 251, 51]);
  });
  it('dedupes overlapping pages and reload starts over', async () => {
    let n = 0;
    const p = new HistoryPager(async () => (n++ === 0 ? [{ id: 3 }, { id: 2 }] : [{ id: 2 }]), 2);
    await p.reload();
    await p.loadMore();
    expect(p.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(p.done).toBe(true);
    n = 0;
    await p.reload();
    expect(p.done).toBe(false);
  });
});

describe('filters and CSV', () => {
  const ev: EventRecord = { id: 1, timeMs: 0, kind: 'alarm', severity: 'warning', message: 'CNC-01.temp deviates', assetId: 'CNC-01' };
  const al: Alarm = { id: 'ALM-CNC-01.temp-deviation', source: 'deviation', severity: 'warning', assetId: 'CNC-01', message: 'x', raisedAtMs: 0, active: true, acknowledged: false, sensorId: 'CNC-01.temp' };
  it('filters events and alarms', () => {
    expect(historyEventMatches(ev, 'cnc', 'all', 'all')).toBe(true);
    expect(historyEventMatches(ev, '', 'critical', 'all')).toBe(false);
    expect(historyEventMatches(ev, '', 'all', 'state')).toBe(false);
    expect(alarmMatches(al, '', 'deviation')).toBe(true);
    expect(alarmMatches(al, '', 'fault')).toBe(false);
    expect(alarmMatches(al, 'temp', 'all')).toBe(true);
  });
  it('quotes CSV cells', () => {
    const csv = toCsv([{ title: 'a', value: (r: { a: string }) => r.a }, { title: 'n', value: () => undefined }], [{ a: 'x,"y"' }]);
    expect(csv).toBe('a,n\r\n"x,""y""",\r\n');
  });
});
