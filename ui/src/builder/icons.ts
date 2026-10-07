// 16×16 toolbar icons for the Plant Builder, in the same pixel style as widgets/icons.ts.
// Kind icons are reused from the shared set.
import { icons as shared, type IconName } from '../widgets/icons';
import type { AssetKind } from '../net/contracts';

const S = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges">${body}</svg>`;
const SA = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${body}</svg>`;

export const bicons = {
  builder: S('<rect x="0.5" y="0.5" width="15" height="15" style="fill:var(--c-field)" stroke="currentColor"/><path d="M4 1v14M8 1v14M12 1v14M1 4h14M1 8h14M1 12h14" stroke="currentColor" opacity=".18"/><rect x="2.5" y="5.5" width="4" height="3" fill="#4dbeee" stroke="currentColor"/><rect x="9.5" y="9.5" width="4" height="3" fill="#d9b67a" stroke="#6b4e1f"/><path d="M6.5 7h2v3.5h1" fill="none" stroke="#0f62fe"/>'),
  newDoc: S('<path d="M3.5 1.5h6l3 3v10h-9z" style="fill:var(--c-field)" stroke="currentColor"/><path d="M9.5 1.5v3h3" fill="none" stroke="currentColor"/><path d="M11 9v5M8.5 11.5h5" stroke="#77ac30" stroke-width="1.6"/>'),
  open: S('<path d="M1.5 3.5h5l1 1.5h6v2" fill="#edc95a" stroke="#8a6a12"/><path d="M1.5 13.5V3.5M1.5 13.5h11l3-6.5h-11z" fill="#f6dc85" stroke="#8a6a12"/>'),
  template: S('<rect x="1.5" y="1.5" width="13" height="13" style="fill:var(--c-field)" stroke="currentColor"/><rect x="1.5" y="1.5" width="13" height="3" fill="#3a6ea5" stroke="currentColor"/><rect x="3.5" y="6.5" width="4" height="3" fill="#4dbeee" stroke="currentColor"/><rect x="9.5" y="6.5" width="3" height="6" fill="#d9b67a" stroke="#6b4e1f"/><rect x="3.5" y="11" width="4" height="1" fill="currentColor"/>'),
  save: S('<path d="M1.5 1.5h11l2 2v11h-13z" fill="#3a6ea5" stroke="#0a246a"/><rect x="4" y="2" width="8" height="5" fill="#fff"/><rect x="9" y="3" width="2" height="3" fill="#3a6ea5"/><rect x="3.5" y="9.5" width="9" height="5" style="fill:var(--c-field)" stroke="#0a246a"/>'),
  importJson: SA('<path d="M3.5 1.5h6l3 3v10h-9z" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5.6 7.5c-.8 0-.8.6-.8 1.2s0 1.2-.8 1.3c.8.1.8.7.8 1.3s0 1.2.8 1.2M10.4 7.5c.8 0 .8.6.8 1.2s0 1.2.8 1.3c-.8.1-.8.7-.8 1.3s0 1.2-.8 1.2" fill="none" stroke="#0072bd"/><path d="M8 1v5M6 4l2 2 2-2" fill="none" stroke="#77ac30" stroke-width="1.4"/>'),
  exportJson: SA('<path d="M3.5 1.5h6l3 3v10h-9z" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5.6 7.5c-.8 0-.8.6-.8 1.2s0 1.2-.8 1.3c.8.1.8.7.8 1.3s0 1.2.8 1.2M10.4 7.5c.8 0 .8.6.8 1.2s0 1.2.8 1.3c-.8.1-.8.7-.8 1.3s0 1.2-.8 1.2" fill="none" stroke="#0072bd"/><path d="M8 6V1M6 3l2-2 2 2" fill="none" stroke="#d95319" stroke-width="1.4"/>'),
  undo: SA('<path d="M5 4.5h5a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M1.5 4.5L5.5 1v7z" fill="#3a6ea5"/>'),
  redo: SA('<path d="M11 4.5H6a3.5 3.5 0 0 0 0 7h4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14.5 4.5L10.5 1v7z" fill="#3a6ea5"/>'),
  pointer: SA('<path d="M3.5 1.5v11l3-2.6 2 4.6 2-.9-2-4.5h4z" style="fill:var(--c-field)" stroke="currentColor" stroke-linejoin="round"/>'),
  connect: SA('<rect x="0.5" y="2.5" width="5" height="4" fill="#4dbeee" stroke="currentColor"/><rect x="10.5" y="9.5" width="5" height="4" fill="#d9b67a" stroke="#6b4e1f"/><path d="M5.5 4.5h3v7h1.2" fill="none" stroke="#0f62fe" stroke-width="1.3"/><path d="M8.6 9.3l2.2 2.2-2.2 2.2z" fill="#0f62fe"/>'),
  pan: SA('<path d="M5 8V3.7a1 1 0 0 1 2 0V7.5V2.5a1 1 0 0 1 2 0v5V3.5a1 1 0 0 1 2 0V8.5V6a1 1 0 0 1 2 0v4.5c0 2.5-1.8 4-4.2 4-2 0-3-.8-4.3-2.6L2.8 9.6a1 1 0 0 1 1.5-1.3z" style="fill:var(--c-field)" stroke="currentColor" stroke-linejoin="round"/>'),
  rotate: SA('<path d="M12.8 7.5A4.8 4.8 0 1 1 8 2.7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 0v5.4l3-2.7z" fill="#0f62fe"/><rect x="5.5" y="6" width="5" height="4" fill="#4dbeee" stroke="currentColor"/>'),
  remove: SA('<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="#d0021b" stroke-width="2.2"/>'),
  copy: S('<path d="M1.5 1.5h7v9h-7z" style="fill:var(--c-field)" stroke="currentColor"/><path d="M6.5 5.5h7v9h-7z" style="fill:var(--c-field)" stroke="currentColor"/><path d="M8 8h4M8 10h4M8 12h3" stroke="currentColor" opacity=".5"/>'),
  paste: S('<rect x="2.5" y="2.5" width="9" height="12" fill="#d9b67a" stroke="#6b4e1f"/><rect x="5" y="1.5" width="4" height="2" style="fill:var(--c-face)" stroke="currentColor"/><path d="M7.5 6.5h7v8h-7z" style="fill:var(--c-field)" stroke="currentColor"/>'),
  zoomFit: SA('<path d="M1.5 5V1.5H5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="4.5" y="5.5" width="7" height="5" fill="#4dbeee" stroke="currentColor"/>'),
  zoomIn: SA('<circle cx="6.5" cy="6.5" r="4.5" style="fill:var(--c-field)" stroke="currentColor" stroke-width="1.3"/><path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="2"/><path d="M4.3 6.5h4.4M6.5 4.3v4.4" stroke="currentColor" stroke-width="1.2"/>'),
  zoomOut: SA('<circle cx="6.5" cy="6.5" r="4.5" style="fill:var(--c-field)" stroke="currentColor" stroke-width="1.3"/><path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="2"/><path d="M4.3 6.5h4.4" stroke="currentColor" stroke-width="1.2"/>'),
  grid: S('<rect x="1.5" y="1.5" width="13" height="13" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12" stroke="currentColor" opacity=".5"/>'),
  snap: S('<path d="M2 2h1v1H2zM6 2h1v1H6zM10 2h1v1h-1zM14 2h1v1h-1zM2 6h1v1H2zM2 10h1v1H2zM2 14h1v1H2zM6 14h1v1H6zM10 14h1v1h-1zM14 14h1v1h-1zM14 6h1v1h-1zM14 10h1v1h-1z" fill="currentColor"/><rect x="5.5" y="5.5" width="5" height="5" fill="#4dbeee" stroke="#0f62fe"/>'),
  apply: SA('<rect x="1.5" y="2.5" width="13" height="9" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5 14.5h6M8 11.5v3" stroke="currentColor"/><path d="M4.5 7l2.4 2.4 4.6-5" fill="none" style="stroke:var(--s-running)" stroke-width="1.9"/>'),
  validate: SA('<path d="M8 1.3l5.8 2.2v4c0 3.4-2.5 6-5.8 7.2-3.3-1.2-5.8-3.8-5.8-7.2v-4z" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5 8l2.2 2.2 4-4.4" fill="none" style="stroke:var(--s-running)" stroke-width="1.7"/>'),
  loadLive: SA('<rect x="1.5" y="2.5" width="13" height="9" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5 14.5h6M8 11.5v3" stroke="currentColor"/><path d="M8 4v5M5.8 6.8L8 9l2.2-2.2" fill="none" stroke="#0f62fe" stroke-width="1.5"/>'),
  maximize: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9" width="9" height="9" shape-rendering="crispEdges"><path d="M0 0h9v9H0zM1 2v6h7V2z" fill="currentColor" fill-rule="evenodd"/></svg>',
  restore: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9" width="9" height="9" shape-rendering="crispEdges"><path d="M2 0h7v6H7V2H2zM0 3h7v6H0zM1 5v3h5V5z" fill="currentColor" fill-rule="evenodd"/></svg>',
  lines: shared.line,
  resources: SA('<circle cx="5.5" cy="4.5" r="2.3" style="fill:var(--c-field)" stroke="currentColor"/><path d="M1.5 13.5c0-3 1.8-4.6 4-4.6s4 1.6 4 4.6z" fill="#3a6ea5" stroke="#0a246a"/><circle cx="11.5" cy="5.5" r="2" style="fill:var(--c-field)" stroke="currentColor"/><path d="M10 9.3c.5-.2 1-.3 1.5-.3 2 0 3.3 1.4 3.3 4.5h-4" fill="#77ac30" stroke="#2d5200"/>'),
  shifts: SA('<circle cx="8" cy="8" r="6.5" style="fill:var(--c-field)" stroke="currentColor"/><path d="M8 1.5A6.5 6.5 0 0 1 14.5 8H8z" fill="#edb120" opacity=".8"/><path d="M8 4v4l2.8 1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
  sensors: shared.sensor,
} as const;

export type BIconName = keyof typeof bicons;

export const KIND_ICON: Record<AssetKind, IconName> = {
  source: 'source', conveyor: 'conveyor', machine: 'machine', buffer: 'buffer', robot: 'robot', inspection: 'inspection', sink: 'sink',
};

export function iconMarkup(name: BIconName | IconName): string {
  return (bicons as Record<string, string>)[name] ?? (shared as Record<string, string>)[name];
}
