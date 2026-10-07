// 16x16 inline SVG icons, drawn on the pixel grid in the classic toolbar style.
// Outlines use currentColor so they follow the theme; fills use status tokens.

const S = (body: string, vb = '0 0 16 16') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="16" height="16" shape-rendering="crispEdges">${body}</svg>`;
const SA = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${body}</svg>`;

export const icons = {
  play: SA('<path d="M4.5 2.5v11l9-5.5z" style="fill:var(--s-running)" stroke="#2d5200" stroke-width="1" stroke-linejoin="round"/><path d="M5.5 4.3v3.2l4.5-2.6" fill="none" stroke="rgba(255,255,255,.6)"/>'),
  pause: S('<rect x="3.5" y="3.5" width="3" height="9" fill="#3a6ea5" stroke="#0a246a"/><rect x="9.5" y="3.5" width="3" height="9" fill="#3a6ea5" stroke="#0a246a"/>'),
  stop: S('<rect x="3.5" y="3.5" width="9" height="9" fill="#5a5a5a" stroke="#202020"/><rect x="4.5" y="4.5" width="3" height="1" fill="#9a9a9a"/>'),
  reset: SA('<path d="M12.6 8A4.6 4.6 0 1 1 8 3.4h2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 0.8l3 2.6-3 2.6z" fill="currentColor"/>'),
  fault: SA('<path d="M8 1.5l6.8 12.5H1.2z" style="fill:var(--sev-warning)" stroke="#5c3d00" stroke-linejoin="round"/><rect x="7.2" y="5.5" width="1.6" height="4.6" fill="#000"/><rect x="7.2" y="11" width="1.6" height="1.6" fill="#000"/>'),
  clearFault: SA('<path d="M8 1.5l6.8 12.5H1.2z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M5 9l2 2 4-4.5" fill="none" style="stroke:var(--s-running)" stroke-width="1.8"/>'),
  whatIf: SA('<path d="M6 1.5h4M6.8 1.5v4.2L2.6 13a1 1 0 0 0 .9 1.5h9a1 1 0 0 0 .9-1.5L9.2 5.7V1.5" fill="none" stroke="currentColor"/><path d="M4.4 10h7.2l1.5 3.3H2.9z" fill="#4dbeee"/><circle cx="7" cy="12" r=".8" fill="#fff"/><circle cx="9.3" cy="11" r=".6" fill="#fff"/>'),
  export: S('<path d="M2.5 1.5h8l3 3v10h-11z" style="fill:var(--c-field)" stroke="currentColor"/><path d="M10.5 1.5v3h3" fill="none" stroke="currentColor"/><rect x="4" y="7" width="8" height="1" fill="#77ac30"/><rect x="4" y="9" width="8" height="1" fill="#77ac30"/><rect x="4" y="11" width="8" height="1" fill="#77ac30"/><rect x="7" y="7" width="1" height="5" fill="currentColor" opacity=".5"/>'),
  theme: SA('<circle cx="8" cy="8" r="6" style="fill:var(--c-field)" stroke="currentColor"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>'),
  maintenance: SA('<path d="M10.8 1.6a3.6 3.6 0 0 0-4.3 4.7L1.8 11a1.4 1.4 0 0 0 2 2l4.8-4.7a3.6 3.6 0 0 0 4.7-4.3l-2 2-2.2-.4-.4-2.2z" style="fill:var(--s-maintenance)" stroke="#1d4f86" stroke-linejoin="round"/>'),
  power: SA('<path d="M5 3.6a5.2 5.2 0 1 0 6 0" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 1v6.5" stroke="currentColor" stroke-width="1.7"/>'),
  info: SA('<circle cx="8" cy="8" r="6.5" style="fill:var(--c-field);stroke:var(--sev-info)"/><rect x="7.25" y="7" width="1.5" height="5" style="fill:var(--sev-info)"/><rect x="7.25" y="4" width="1.5" height="1.6" style="fill:var(--sev-info)"/>'),
  warning: SA('<path d="M8 1.8l6.5 12H1.5z" style="fill:var(--sev-warning)" stroke="#6b4700" stroke-linejoin="round"/><rect x="7.3" y="5.6" width="1.4" height="4.4" fill="#000"/><rect x="7.3" y="11" width="1.4" height="1.4" fill="#000"/>'),
  critical: SA('<circle cx="8" cy="8" r="6.5" style="fill:var(--sev-critical)" stroke="#5a000a"/><path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="#fff" stroke-width="1.8"/>'),
  ack: SA('<path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2"/>'),
  ackAll: SA('<path d="M1 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.5 11l1 1 7.5-8" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  about: SA('<circle cx="8" cy="8" r="6.5" fill="#3a6ea5" stroke="#0a246a"/><rect x="7.2" y="7" width="1.6" height="5" fill="#fff"/><rect x="7.2" y="4" width="1.6" height="1.6" fill="#fff"/>'),
  plus: S('<rect x="7" y="3" width="2" height="10" fill="currentColor"/><rect x="3" y="7" width="10" height="2" fill="currentColor"/>'),
  minus: S('<rect x="3" y="7" width="10" height="2" fill="currentColor"/>'),
  clear: S('<path d="M3 3h10M6 3V2h4v1M4 4.5h8l-.7 9.5H4.7z" fill="none" stroke="currentColor"/><path d="M6.5 6v6M9.5 6v6" stroke="currentColor"/>'),
  filter: SA('<path d="M1.5 2.5h13l-5 6v5l-3 1.5v-6.5z" style="fill:var(--c-field)" stroke="currentColor" stroke-linejoin="round"/>'),
  link: SA('<path d="M6.5 9.5l3-3M5 8l-1.6 1.6a2 2 0 0 0 2.9 2.9L8 11M11 8l1.6-1.6a2 2 0 0 0-2.9-2.9L8 5" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
  demo: SA('<rect x="1.5" y="2.5" width="13" height="9" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5 14.5h6M8 11.5v3" stroke="currentColor"/><path d="M6.5 4.8v4.4L10.3 7z" style="fill:var(--s-maintenance)"/>'),
  live: SA('<rect x="1.5" y="2.5" width="13" height="9" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5 14.5h6M8 11.5v3" stroke="currentColor"/><path d="M3.5 9l2.5-3 2 2 2.5-3.5 2 2" fill="none" style="stroke:var(--s-running)" stroke-width="1.3"/>'),
  keyboard: S('<rect x="0.5" y="3.5" width="15" height="9" style="fill:var(--c-field)" stroke="currentColor"/><path d="M2 5h2v2H2zM5 5h2v2H5zM8 5h2v2H8zM11 5h3v2h-3zM2 8h2v2H2zM5 8h6v2H5zM12 8h2v2h-2z" fill="currentColor" opacity=".7"/>'),
  layout: S('<rect x="0.5" y="1.5" width="15" height="13" style="fill:var(--c-field)" stroke="currentColor"/><rect x="1" y="2" width="14" height="2" fill="#3a6ea5"/><path d="M5.5 4v10M5.5 9.5h10" stroke="currentColor"/>'),

  // ---- plant tree ----
  line: S('<path d="M1.5 14.5V7.5l3-2v2l3-2v2l3-2V2.5h3v12z" style="fill:var(--c-face)" stroke="currentColor"/><rect x="3" y="10" width="2" height="2" fill="#4dbeee"/><rect x="7" y="10" width="2" height="2" fill="#4dbeee"/><rect x="11" y="10" width="2" height="2" fill="#4dbeee"/>'),
  folder: S('<path d="M1.5 3.5h5l1 1.5h7v8.5h-13z" fill="#edc95a" stroke="#8a6a12"/><path d="M1.5 6.5h13" stroke="#fbe9a8"/>'),
  folderOpen: S('<path d="M1.5 3.5h5l1 1.5h6v2" fill="#edc95a" stroke="#8a6a12"/><path d="M1.5 13.5V3.5M1.5 13.5h11l3-6.5h-11z" fill="#f6dc85" stroke="#8a6a12"/>'),
  source: S('<rect x="6.5" y="3.5" width="8" height="9" fill="#d9b67a" stroke="#6b4e1f"/><path d="M6.5 6.5h8M10.5 3.5v3" stroke="#6b4e1f"/><path d="M1 8h4M3 6l2 2-2 2" fill="none" stroke="currentColor"/>'),
  conveyor: SA('<rect x="1" y="6.5" width="14" height="4" rx="2" style="fill:var(--c-face)" stroke="currentColor"/><circle cx="3.2" cy="8.5" r="1" fill="currentColor"/><circle cx="8" cy="8.5" r="1" fill="currentColor"/><circle cx="12.8" cy="8.5" r="1" fill="currentColor"/><rect x="5" y="3" width="4" height="3" fill="#d9b67a" stroke="#6b4e1f" stroke-width=".8"/>'),
  machine: S('<rect x="1.5" y="2.5" width="13" height="11" style="fill:var(--c-face)" stroke="currentColor"/><rect x="3.5" y="4.5" width="6" height="5" fill="#4dbeee" stroke="currentColor"/><rect x="11" y="4" width="2" height="1" fill="#d0021b"/><rect x="11" y="6" width="2" height="1" style="fill:var(--s-running)"/><rect x="3" y="11" width="10" height="1" fill="currentColor" opacity=".5"/>'),
  buffer: S('<rect x="2.5" y="10.5" width="11" height="3" fill="#d9b67a" stroke="#6b4e1f"/><rect x="2.5" y="6.5" width="11" height="3" fill="#d9b67a" stroke="#6b4e1f"/><rect x="2.5" y="2.5" width="11" height="3" style="fill:var(--c-field)" stroke="currentColor" stroke-dasharray="1 1"/>'),
  robot: SA('<rect x="2" y="12.5" width="7" height="2" fill="currentColor"/><path d="M5.5 12.5V9l4-5 3.5 2.5" fill="none" stroke="#e8a317" stroke-width="2.2" stroke-linejoin="round"/><circle cx="5.5" cy="9" r="1.3" fill="currentColor"/><circle cx="9.5" cy="4" r="1.3" fill="currentColor"/><path d="M13 5v3M14.5 5.8v2" stroke="currentColor"/>'),
  inspection: SA('<circle cx="6.5" cy="6.5" r="4.2" style="fill:var(--c-field)" stroke="currentColor" stroke-width="1.4"/><path d="M9.5 9.5l5 5" stroke="currentColor" stroke-width="2.2"/><path d="M4.5 6.5l1.5 1.5 2.5-3" fill="none" style="stroke:var(--s-running)" stroke-width="1.3"/>'),
  sink: S('<path d="M1.5 6.5l6.5-3 6.5 3v8h-13z" style="fill:var(--c-face)" stroke="currentColor"/><rect x="4.5" y="9.5" width="7" height="5" fill="#d9b67a" stroke="#6b4e1f"/><path d="M4.5 11.5h7" stroke="#6b4e1f"/>'),
  sensor: SA('<path d="M2.5 12a5.5 5.5 0 1 1 11 0" style="fill:var(--c-field)" stroke="currentColor"/><path d="M8 12l3-4" stroke="#d0021b" stroke-width="1.4"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/>'),
  temperature: SA('<path d="M6.5 2.5a1.5 1.5 0 0 1 3 0v6.6a3 3 0 1 1-3 0z" style="fill:var(--c-field)" stroke="currentColor"/><circle cx="8" cy="11.7" r="1.7" fill="#d0021b"/><rect x="7.4" y="5" width="1.2" height="6" fill="#d0021b"/>'),
  vibration: SA('<path d="M1 8h2l1.5-4 2 8 2-9 2 9 1.5-4H15" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'),
  powerSensor: SA('<path d="M9.5 1L3.5 9h4l-1 6 6-8h-4z" fill="#edb120" stroke="#6b4700" stroke-linejoin="round" stroke-width=".9"/>'),
  current: SA('<circle cx="8" cy="8" r="6.5" style="fill:var(--c-field)" stroke="currentColor"/><path d="M5 11l3-7 3 7M6.2 8.6h3.6" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  speed: SA('<path d="M2.5 12a5.5 5.5 0 1 1 11 0" style="fill:var(--c-field)" stroke="currentColor"/><path d="M8 12l-2.5-4" stroke="#0072bd" stroke-width="1.4"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/>'),
  level: S('<rect x="3.5" y="1.5" width="9" height="13" style="fill:var(--c-field)" stroke="currentColor"/><rect x="4" y="8" width="8" height="6" fill="#4dbeee"/><path d="M13 4h2M13 8h2M13 12h2" stroke="currentColor"/>'),
  count: S('<rect x="1.5" y="3.5" width="13" height="9" style="fill:var(--c-field)" stroke="currentColor"/><path d="M4 6v4M6 6h2v2H6v2h2M10 6h2v4h-2M10 8h2" fill="none" stroke="currentColor"/>'),

  // ---- small glyphs (non 16px viewbox) ----
  arrowDown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 4" width="7" height="4" shape-rendering="crispEdges"><path d="M0 0h7v1H6v1H5v1H4v1H3V3H2V2H1V1H0z"/></svg>',
  arrowUp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 4" width="7" height="4" shape-rendering="crispEdges"><path d="M3 0h1v1h1v1h1v1h1v1H0V3h1V2h1V1h1z"/></svg>',
  arrowRight: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 7" width="4" height="7" shape-rendering="crispEdges"><path d="M0 0h1v1h1v1h1v1h1v1H3v1H2v1H1v1H0z"/></svg>',
  close: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 7" width="8" height="7" shape-rendering="crispEdges"><path d="M0 0h2v1h1v1h2V1h1V0h2v1H7v1H6v1H5v1h1v1h1v1h1v1H6V6H5V5H3v1H2v1H0V6h1V5h1V4h1V3H2V2H1V1H0z"/></svg>',
  check: S('<path d="M5 7h1v1h1v1h1V8h1V7h1V6h1V5h1v2h-1v1h-1v1H9v1H8v1H7v-1H6V9H5z" fill="currentColor"/>'),
  radioDot: S('<rect x="6" y="6" width="4" height="4" fill="currentColor"/><rect x="7" y="5" width="2" height="6" fill="currentColor"/><rect x="5" y="7" width="6" height="2" fill="currentColor"/>'),
} as const;

export type IconName = keyof typeof icons;

const SENSOR_ICON: Record<string, IconName> = {
  temperature: 'temperature', vibration: 'vibration', power: 'powerSensor', current: 'current',
  speed: 'speed', level: 'level', count: 'count',
};
export const sensorIcon = (kind: string): IconName => SENSOR_ICON[kind] ?? 'sensor';
