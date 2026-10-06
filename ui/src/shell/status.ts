// Tiny bus for status-bar messages ("Command sent", errors), so panels and dialogs
// can report without knowing about the shell.
export type StatusKind = 'info' | 'ok' | 'error';
type Fn = (text: string, kind: StatusKind) => void;
const subs = new Set<Fn>();

export function postStatus(text: string, kind: StatusKind = 'info'): void {
  subs.forEach((f) => f(text, kind));
}

export function onStatus(fn: Fn): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
