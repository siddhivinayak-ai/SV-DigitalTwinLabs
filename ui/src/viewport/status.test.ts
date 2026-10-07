import { describe, expect, it } from 'vitest';
import { ASSET_STATES } from '../net/contracts';
import { isAbnormal, lensOn, litLens, stateColor, stateVar, STATE_FALLBACK } from './status';

describe('state → colour (ISA-101)', () => {
  it('matches the spec colours', () => {
    expect(stateColor('running')).toBe('#76b900');
    expect(stateColor('starved')).toBe('#e8a317');
    expect(stateColor('blocked')).toBe('#e8a317');
    expect(stateColor('fault')).toBe('#d0021b');
    expect(stateColor('maintenance')).toBe('#4a90d9');
    expect(stateColor('idle')).toBe('#a0a0a0');
    expect(stateColor('off')).toBe('#a0a0a0');
  });

  it('covers every state and falls back to idle grey for unknown input', () => {
    for (const s of ASSET_STATES) expect(STATE_FALLBACK[s]).toMatch(/^#[0-9a-f]{6}$/);
    expect(stateColor(undefined)).toBe('#a0a0a0');
    expect(stateColor('bogus' as never)).toBe('#a0a0a0');
  });

  it('reads the --s-* token through the supplied reader', () => {
    const seen: string[] = [];
    const c = stateColor('fault', (name, fb) => { seen.push(name); return name === '--s-fault' ? '#ff0000' : fb; });
    expect(c).toBe('#ff0000');
    expect(seen).toEqual([stateVar('fault')]);
  });

  it('lights one lens per active state and none when normal-idle', () => {
    expect(litLens('running')).toBe('green');
    expect(litLens('starved')).toBe('amber');
    expect(litLens('blocked')).toBe('amber');
    expect(litLens('fault')).toBe('red');
    expect(litLens('maintenance')).toBe('blue');
    expect(litLens('idle')).toBeNull();
    expect(litLens('off')).toBeNull();
  });

  it('blinks only on fault', () => {
    expect(lensOn('running', 0.3)).toBe(true);
    const samples = [0, 0.125, 0.25, 0.375, 0.5, 0.625].map((t) => lensOn('fault', t + 0.01));
    expect(samples).toEqual([true, true, false, false, true, true].map((_, i) => Math.floor((i * 0.125 + 0.01) * 4) % 2 === 0));
    expect(samples.includes(true) && samples.includes(false)).toBe(true);
  });

  it('flags abnormal states for the status outline', () => {
    expect(ASSET_STATES.filter(isAbnormal)).toEqual(['blocked', 'fault', 'maintenance']);
  });
});
