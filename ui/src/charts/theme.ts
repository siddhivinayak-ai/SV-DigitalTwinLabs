// Runtime access to the design tokens in styles/tokens.css.
// Colours are read with getComputedStyle so both themes work; callers re-read on the store 'theme' event.

/** Read one CSS custom property from :root (trimmed), with a fallback when unavailable (tests, SSR). */
export function cssVar(name: string, fallback = '#000000'): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** MATLAB default colour order (R2014b+), the fallback for --plot-1 … --plot-7. */
export const MATLAB_ORDER = ['#0072bd', '#d95319', '#edb120', '#7e2f8e', '#77ac30', '#4dbeee', '#a2142f'] as const;

export interface PlotPalette {
  bg: string;
  grid: string;
  axis: string;
  frame: string;
  order: string[];
  warn: string;
  alarm: string;
  select: string;
  fontUi: string;
  fontMono: string;
  text: string;
  textDim: string;
  field: string;
  border: string;
}

export function readPlotPalette(): PlotPalette {
  return {
    bg: cssVar('--plot-bg', '#ffffff'),
    grid: cssVar('--plot-grid', '#e5e5e5'),
    axis: cssVar('--plot-axis', '#262626'),
    frame: cssVar('--plot-frame', '#000000'),
    order: MATLAB_ORDER.map((c, i) => cssVar(`--plot-${i + 1}`, c)),
    warn: cssVar('--s-starved', '#e8a317'),
    alarm: cssVar('--s-fault', '#d0021b'),
    select: cssVar('--c-select', '#0f62fe'),
    fontUi: cssVar('--font-ui', 'Tahoma, sans-serif'),
    fontMono: cssVar('--font-mono', 'Consolas, monospace'),
    text: cssVar('--c-text', '#000000'),
    textDim: cssVar('--c-text-dim', '#5a5a5a'),
    field: cssVar('--c-field', '#ffffff'),
    border: cssVar('--c-border', '#a0a0a0'),
  };
}

/** Parse '#rgb' / '#rrggbb' into a 24-bit integer (for three.js Color.setHex). */
export function hexToInt(hex: string, fallback = 0x000000): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return parseInt(s, 16);
}

/** Return `hex` with an alpha channel, as rgba(). */
export function withAlpha(hex: string, a: number): string {
  const n = hexToInt(hex);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
