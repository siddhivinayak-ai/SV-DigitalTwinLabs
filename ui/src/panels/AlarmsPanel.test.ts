import { describe, expect, it } from 'vitest';
import type { Alarm } from '../net/contracts';
import { alarmSummary, sortAlarms } from './AlarmsPanel';
import { eventMatches } from './EventLogPanel';

const al = (id: string, severity: Alarm['severity'], raisedAtMs: number, acknowledged = false): Alarm => ({
  id, severity, raisedAtMs, acknowledged, active: true, source: 'limit', assetId: 'CNC-01', message: id,
});

describe('sortAlarms', () => {
  it('orders by severity, then newest first', () => {
    const list = [al('w-old', 'warning', 100), al('c-old', 'critical', 50), al('i', 'info', 900), al('c-new', 'critical', 700), al('w-new', 'warning', 800)];
    expect(sortAlarms(list).map((a) => a.id)).toEqual(['c-new', 'c-old', 'w-new', 'w-old', 'i']);
  });
});

describe('alarmSummary', () => {
  it('counts active / unacked and finds the top severity', () => {
    const s = alarmSummary([al('a', 'warning', 1), al('b', 'critical', 2, true), al('c', 'warning', 3)]);
    expect(s).toEqual({ active: 3, unacked: 2, top: 'critical', topUnacked: false });
  });
  it('flags an unacknowledged top-severity alarm', () => {
    expect(alarmSummary([al('b', 'critical', 2, true), al('d', 'critical', 4)]).topUnacked).toBe(true);
  });
  it('ignores inactive alarms', () => {
    expect(alarmSummary([{ ...al('x', 'critical', 1), active: false }])).toEqual({ active: 0, unacked: 0, top: null, topUnacked: false });
  });
});

describe('eventMatches', () => {
  const e = { id: 1, timeMs: 0, kind: 'state' as const, severity: 'warning' as const, message: 'CNC-01 vibration high', assetId: 'CNC-01' };
  it('filters by text (case-insensitive) on message, asset and kind', () => {
    expect(eventMatches(e, 'VIBRATION', 'all')).toBe(true);
    expect(eventMatches(e, 'cnc-01', 'all')).toBe(true);
    expect(eventMatches(e, 'state', 'all')).toBe(true);
    expect(eventMatches(e, 'robot', 'all')).toBe(false);
  });
  it('filters by minimum severity', () => {
    expect(eventMatches(e, '', 'warning')).toBe(true);
    expect(eventMatches(e, '', 'critical')).toBe(false);
  });
});
