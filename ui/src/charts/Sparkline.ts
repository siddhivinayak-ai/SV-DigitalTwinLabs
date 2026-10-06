import { CanvasWidget } from './CanvasWidget';
import { cssVar, withAlpha } from './theme';

/** Compact trend line with min/max readout and a marker on the latest value. */
export class Sparkline extends CanvasWidget {
  private t: number[] = [];
  private v: number[] = [];
  private color = cssVar('--plot-1', '#0072bd');
  private bg = cssVar('--plot-bg', '#ffffff');
  private grid = cssVar('--plot-grid', '#e5e5e5');
  private dim = cssVar('--c-text-dim', '#5a5a5a');
  private mono = cssVar('--font-mono', 'Consolas, monospace');

  constructor(host: HTMLElement, private readonly digits = 1) {
    super(host, 'kg-spark');
  }

  setData(t: number[], v: number[]): void {
    this.t = t;
    this.v = v;
    this.invalidate();
  }

  refreshTheme(): void {
    this.color = cssVar('--plot-1', '#0072bd');
    this.bg = cssVar('--plot-bg', '#ffffff');
    this.grid = cssVar('--plot-grid', '#e5e5e5');
    this.dim = cssVar('--c-text-dim', '#5a5a5a');
    this.invalidate();
  }

  protected draw(c: CanvasRenderingContext2D, w: number, h: number): void {
    c.fillStyle = this.bg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = this.grid;
    for (let i = 1; i < 4; i++) c.fillRect(0, Math.round((h * i) / 4), w, 1);
    const n = this.v.length;
    if (n < 2) {
      c.fillStyle = this.dim;
      c.font = `10px ${this.mono}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('collecting…', w / 2, h / 2);
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (const x of this.v) { if (x < lo) lo = x; if (x > hi) hi = x; }
    const t0 = this.t[0], t1 = this.t[n - 1];
    const span = hi - lo || Math.max(1, Math.abs(hi) * 0.1);
    const yLo = lo - span * 0.12, yHi = hi + span * 0.12;
    const padR = 4, padT = 3, padB = 3;
    const X = (t: number) => ((t - t0) / (t1 - t0 || 1)) * (w - padR - 1);
    const Y = (v: number) => padT + (1 - (v - yLo) / (yHi - yLo)) * (h - padT - padB);
    c.beginPath();
    c.moveTo(X(this.t[0]), Y(this.v[0]));
    for (let i = 1; i < n; i++) c.lineTo(X(this.t[i]), Y(this.v[i]));
    c.strokeStyle = this.color;
    c.lineWidth = 1.5;
    c.lineJoin = 'round';
    c.stroke();
    c.lineTo(X(t1), h);
    c.lineTo(X(t0), h);
    c.closePath();
    c.fillStyle = withAlpha(this.color, 0.1);
    c.fill();
    const lx = X(t1), ly = Y(this.v[n - 1]);
    c.fillStyle = this.color;
    c.beginPath(); c.arc(lx, ly, 2.5, 0, Math.PI * 2); c.fill();
    c.font = `9px ${this.mono}`;
    c.fillStyle = this.dim;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText(`max ${hi.toFixed(this.digits)}`, 3, 1);
    c.textBaseline = 'bottom';
    c.fillText(`min ${lo.toFixed(this.digits)}`, 3, h - 1);
  }
}
