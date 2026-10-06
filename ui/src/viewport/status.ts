import type { AssetStateKind } from '../net/contracts';

/**
 * ISA-101 status colour mapping (docs/V1-Spec.md §4). Grey is normal; colour only for
 * active/abnormal states. Colours come from the --s-* tokens; these are the light-theme fallbacks.
 */
export const STATE_FALLBACK: Record<AssetStateKind, string> = {
  off: '#a0a0a0',
  idle: '#a0a0a0',
  running: '#76b900',
  starved: '#e8a317',
  blocked: '#e8a317',
  fault: '#d0021b',
  maintenance: '#4a90d9',
};

export const STATE_LABEL: Record<AssetStateKind, string> = {
  off: 'Off', idle: 'Idle', running: 'Running', starved: 'Starved', blocked: 'Blocked', fault: 'Fault', maintenance: 'Maintenance',
};

/** CSS custom property that holds the colour for a state. */
export function stateVar(state: AssetStateKind): string {
  return `--s-${state}`;
}

/** Resolve a state colour through a token reader (e.g. cssVar), falling back to the spec value. */
export function stateColor(state: AssetStateKind | undefined, read?: (name: string, fallback: string) => string): string {
  const s: AssetStateKind = state && state in STATE_FALLBACK ? state : 'idle';
  return read ? read(stateVar(s), STATE_FALLBACK[s]) : STATE_FALLBACK[s];
}

/** Stack-light lens that is lit for a state (top→bottom: red, amber, green, blue), or null when all are dark. */
export type Lens = 'red' | 'amber' | 'green' | 'blue';
export function litLens(state: AssetStateKind | undefined): Lens | null {
  switch (state) {
    case 'running': return 'green';
    case 'starved':
    case 'blocked': return 'amber';
    case 'fault': return 'red';
    case 'maintenance': return 'blue';
    default: return null;
  }
}

/** Whether the lit lens should be on at time `tSec` (fault blinks at 2 Hz, 50 % duty). */
export function lensOn(state: AssetStateKind | undefined, tSec: number): boolean {
  if (state !== 'fault') return true;
  return Math.floor(tSec * 4) % 2 === 0;
}

/**
 * States that also get the emissive status outline. Running/Idle/Off stay quiet (ISA-101); Starved is
 * shown on the beacon only, since it is the normal waiting state of most stations on a balanced line.
 */
export function isAbnormal(state: AssetStateKind | undefined): boolean {
  return state === 'blocked' || state === 'fault' || state === 'maintenance';
}
