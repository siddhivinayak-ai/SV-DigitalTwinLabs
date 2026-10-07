// Accelerator parsing/matching (pure, unit-tested) and the global shortcut table.

export interface KeyLike { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey?: boolean }
export interface Accel { key: string; ctrl: boolean; shift: boolean; alt: boolean }

/** "Ctrl+Shift+R" → { key:'r', ctrl, shift }. Keys are lower-cased; F-keys keep their name. */
export function parseAccel(text: string): Accel {
  const parts = text.split('+').map((p) => p.trim());
  const key = parts.pop()!.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { key, ctrl: mods.has('ctrl'), shift: mods.has('shift'), alt: mods.has('alt') };
}

export function matchAccel(e: KeyLike, accel: Accel | string): boolean {
  const a = typeof accel === 'string' ? parseAccel(accel) : accel;
  const ctrl = e.ctrlKey || !!e.metaKey;
  return e.key.toLowerCase() === a.key && ctrl === a.ctrl && e.shiftKey === a.shift && e.altKey === a.alt;
}

export type ShortcutCommand = 'start' | 'pause' | 'stop' | 'reset' | 'export' | 'whatIf' | 'injectFault' | 'theme' | 'help';

export const SHORTCUTS: { keys: string; label: string; cmd: ShortcutCommand }[] = [
  { keys: 'F5', label: 'Start / resume simulation', cmd: 'start' },
  { keys: 'F6', label: 'Pause simulation', cmd: 'pause' },
  { keys: 'Shift+F5', label: 'Stop simulation', cmd: 'stop' },
  { keys: 'Ctrl+Shift+R', label: 'Reset simulation', cmd: 'reset' },
  { keys: 'Ctrl+E', label: 'Export sensor history (CSV)', cmd: 'export' },
  { keys: 'Ctrl+W', label: 'What-If scenario…', cmd: 'whatIf' },
  { keys: 'Ctrl+I', label: 'Inject fault…', cmd: 'injectFault' },
  { keys: 'Ctrl+Shift+T', label: 'Toggle Light / Control Room theme', cmd: 'theme' },
  { keys: 'F1', label: 'Keyboard shortcuts', cmd: 'help' },
];

/** Find the shortcut a key event triggers, if any. */
export function shortcutFor(e: KeyLike): ShortcutCommand | null {
  for (const s of SHORTCUTS) if (matchAccel(e, s.keys)) return s.cmd;
  return null;
}

export function accelText(cmd: ShortcutCommand): string | undefined {
  return SHORTCUTS.find((s) => s.cmd === cmd)?.keys;
}
