// 16x16 icons for the v0.2 Connected Twin UI, in the style of widgets/icons.ts.
const SA = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${body}</svg>`;

export const connIcons = {
  /** Engine drives the line: a play triangle inside a cog-like frame. */
  simulate: SA('<rect x="1.5" y="2.5" width="13" height="11" rx="1" style="fill:var(--c-field)" stroke="currentColor"/><path d="M6 5v6l5-3z" style="fill:var(--s-running)" stroke="currentColor" stroke-width=".6" stroke-linejoin="round"/>'),
  /** Reality drives the twin: a solid line with its dashed shadow (prediction). */
  shadow: SA('<rect x="1.5" y="2.5" width="13" height="11" rx="1" style="fill:var(--c-field)" stroke="currentColor"/><path d="M3 11l3-4 2.5 2 4.5-5" fill="none" style="stroke:var(--s-maintenance)" stroke-width="1.6"/><path d="M3 12.2l3-3 2.5 1.6 4.5-3.6" fill="none" stroke="currentColor" stroke-width=".9" stroke-dasharray="1.4 1.2"/>'),
  /** Deviation alarm: actual (solid) leaving the predicted (dashed) path. */
  deviation: SA('<path d="M1.5 12h13" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="1.6 1.2"/><path d="M1.5 12h5l3-8 2 3h3" fill="none" style="stroke:var(--sev-warning)" stroke-width="1.9" stroke-linejoin="round"/><path d="M1.5 12h5l3-8 2 3h3" fill="none" stroke="#6b4700" stroke-width=".5" stroke-linejoin="round"/>'),
  /** Plug for connections. */
  plug: SA('<path d="M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.5"/><path d="M3 4.5h10v3a5 5 0 0 1-10 0z" style="fill:var(--c-face)" stroke="currentColor"/><path d="M8 12.5v3" stroke="currentColor" stroke-width="1.5"/>'),
  reconnect: SA('<path d="M12.6 8A4.6 4.6 0 1 1 8 3.4h2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 1l2.5 2.4L9 5.8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.6" style="fill:var(--s-running)"/>'),
  history: SA('<circle cx="8" cy="8" r="6.3" style="fill:var(--c-field)" stroke="currentColor"/><path d="M8 4v4.3l2.8 1.7" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
  save: SA('<path d="M2 1.5h10l2.5 2.5v10.5h-12.5z" style="fill:var(--s-maintenance)" stroke="#1d4f86"/><rect x="4.5" y="1.5" width="6" height="4" style="fill:var(--c-field)" stroke="#1d4f86"/><rect x="4" y="9" width="8" height="5.5" style="fill:var(--c-field)" stroke="#1d4f86"/>'),
  open: SA('<path d="M1.5 3.5h5l1 1.5h6v2" fill="#e8c766" stroke="#8a6d1a"/><path d="M1.5 13.5l2-6.5h12l-2 6.5z" fill="#f5dc8a" stroke="#8a6d1a" stroke-linejoin="round"/><path d="M1.5 3.5v10" stroke="#8a6d1a"/>'),
} as const;

export type ConnIconName = keyof typeof connIcons;
