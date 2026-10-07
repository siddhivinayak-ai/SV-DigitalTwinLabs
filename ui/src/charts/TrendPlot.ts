import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './charts.css';
import { fmtSimTime, fmtValue, yRangeWithLimits, type Aligned } from './series';
import { readPlotPalette, type PlotPalette } from './theme';

/** One trace of a TrendPlot. */
export interface TrendSeries {
  id: string;
  label: string;
  unit: string;
  /** y-axis: left (L) or right (R), MATLAB `yyaxis`. */
  axis: 'L' | 'R';
  hi?: number;
  hiHi?: number;
}

export interface TrendPlotOptions {
  series: TrendSeries[];
  yLabelL: string;
  yLabelR?: string;
  /** Show x tick labels and the x label (bottom subplot only, like a linked `tiledlayout`). */
  showX: boolean;
  /** Cursor sync group shared by stacked subplots. */
  syncKey?: string;
  /** User dragged a zoom box on X. */
  onZoom?: (min: number, max: number) => void;
  /** User double-clicked: restore the default view. */
  onReset?: () => void;
}

const X_INCRS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
const TICK = 4; // inward tick length, css px

/**
 * uPlot wrapper styled after MATLAB axes: white axes, light grid, black box frame with inward ticks on
 * all sides, 10 px tick labels, labelled axes with units, MATLAB colour order with 1.5 px lines, an
 * in-axes "northwest" legend with live values (the live edge is on the right), crosshair cursor, drag-to-zoom on X, double-click reset.
 * Data is pushed with setData() at the tick rate; the uPlot instance is only rebuilt on theme change.
 */
export class TrendPlot {
  readonly el: HTMLDivElement;
  private u: uPlot | null = null;
  private pal: PlotPalette = readPlotPalette();
  private data: Aligned = [[]];
  private width = 300;
  private height = 150;
  private splits: number[][] = [];
  private legend!: HTMLDivElement;
  private legendVals: HTMLElement[] = [];
  private xRange: [number, number] | null = null;

  constructor(host: HTMLElement, private readonly opts: TrendPlotOptions) {
    this.el = document.createElement('div');
    this.el.className = 'tp';
    host.appendChild(this.el);
    this.create();
  }

  get series(): readonly TrendSeries[] {
    return this.opts.series;
  }

  /** Colour of series i (MATLAB colour order, restarting per axes like MATLAB does). */
  color(i: number): string {
    return this.pal.order[i % this.pal.order.length];
  }

  private font(px: number): string {
    return `${px}px Helvetica, Arial, ${this.pal.fontUi}`;
  }

  private create(): void {
    const p = this.pal;
    const o = this.opts;
    const limits = (axis: 'L' | 'R') => o.series.filter((s) => s.axis === axis).flatMap((s) => [s.hi, s.hiHi]).filter((v): v is number => v != null);
    const limL = limits('L'), limR = limits('R');
    const hasR = o.series.some((s) => s.axis === 'R');
    const capture = (i: number) => (_u: uPlot, splits: number[]) => { this.splits[i] = splits; return splits; };
    const axisBase = {
      stroke: p.axis,
      font: this.font(10),
      labelFont: this.font(11),
      grid: { stroke: p.grid, width: 1 },
      ticks: { show: false },
      border: { show: false },
      gap: 4,
    };
    const opts: uPlot.Options = {
      width: this.width,
      height: this.height,
      pxAlign: 1,
      padding: [8, hasR ? 4 : 12, o.showX ? 0 : 6, 0],
      scales: {
        x: { time: false, auto: false },
        L: { auto: true, range: (_u, min, max) => yRangeWithLimits(min, max, limL) },
        R: { auto: true, range: (_u, min, max) => yRangeWithLimits(min, max, limR) },
      },
      series: [
        { label: 'Time' },
        ...o.series.map((s, i) => ({
          label: s.label,
          scale: s.axis,
          stroke: this.color(i),
          width: 1.5,
          spanGaps: true,
          points: { show: false },
        })),
      ],
      axes: [
        {
          ...axisBase,
          scale: 'x',
          side: 2,
          size: o.showX ? 20 : 2,
          space: 70,
          incrs: X_INCRS,
          values: (u, splits) => { capture(0)(u, splits); return o.showX ? splits.map(fmtSimTime) : splits.map(() => ''); },
          label: o.showX ? 'Sim time [m:ss]' : undefined,
          labelSize: o.showX ? 14 : 0,
        },
        {
          ...axisBase,
          scale: 'L',
          side: 3,
          size: 40,
          space: 24,
          values: (u, splits) => { capture(1)(u, splits); return splits.map(fmtTick); },
          label: o.yLabelL,
          labelSize: 14,
        },
        ...(hasR ? [{
          ...axisBase,
          scale: 'R',
          side: 1 as const,
          size: 40,
          space: 24,
          grid: { show: false },
          values: (u: uPlot, splits: number[]) => { capture(2)(u, splits); return splits.map(fmtTick); },
          label: o.yLabelR,
          labelSize: 14,
        }] : []),
      ],
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: false },
        sync: o.syncKey ? { key: o.syncKey, setSeries: false, scales: ['x', null] } : undefined,
        points: { size: 6, width: 1.5, fill: p.bg },
        bind: {
          dblclick: () => () => { o.onReset?.(); return null; },
        },
      },
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      hooks: {
        drawClear: [(u) => this.drawAxesBg(u)],
        draw: [(u) => this.drawOverlay(u, hasR)],
        setSelect: [(u) => this.onSelect(u)],
        setCursor: [() => this.updateLegend()],
      },
    };
    this.u = new uPlot(opts, this.data as uPlot.AlignedData, this.el);
    if (this.xRange) this.u.setScale('x', { min: this.xRange[0], max: this.xRange[1] });
    this.buildLegend();
  }

  private drawAxesBg(u: uPlot): void {
    const { left, top, width, height } = u.bbox;
    u.ctx.save();
    u.ctx.fillStyle = this.pal.bg;
    u.ctx.fillRect(left, top, width, height);
    u.ctx.restore();
  }

  /** Limit lines, inward ticks and the black box frame. */
  private drawOverlay(u: uPlot, hasR: boolean): void {
    const ctx = u.ctx;
    const pr = uPlot.pxRatio;
    const { left, top, width, height } = u.bbox;
    const right = left + width, bottom = top + height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();
    // hi / hiHi limit lines (deduplicated per axis); tags are nudged left so they never overlap
    const drawn = new Set<string>();
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const tagH = 11 * pr;
    ctx.font = `${Math.round(9 * pr)}px ${this.pal.fontMono}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (const s of this.opts.series) {
      for (const [lim, color, tag] of [[s.hi, this.pal.warn, 'HI'], [s.hiHi, this.pal.alarm, 'HIHI']] as const) {
        if (lim == null) continue;
        const key = `${s.axis}:${lim}:${tag}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const y = Math.round(u.valToPos(lim, s.axis, true)) + 0.5;
        if (y < top || y > bottom) continue;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.25 * pr;
        ctx.setLineDash([6 * pr, 4 * pr]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillStyle = color;
        const text = `${tag} ${fmtTick(lim)}`;
        const tw = ctx.measureText(text).width;
        const below = y - tagH - 2 * pr < top;
        const y0 = below ? y + 2 * pr : y - 2 * pr - tagH, y1 = y0 + tagH;
        let x1 = right - 4 * pr;
        while (placed.some((r) => r.y0 < y1 && r.y1 > y0 && r.x0 < x1 && r.x1 > x1 - tw) && x1 - tw > left + 40 * pr) x1 -= 8 * pr;
        placed.push({ x0: x1 - tw, x1, y0, y1 });
        ctx.textBaseline = 'top';
        ctx.fillText(text, x1, y0 + pr);
      }
    }
    ctx.restore();

    // inward ticks on all four sides (MATLAB `box on`)
    ctx.save();
    ctx.strokeStyle = this.pal.frame;
    ctx.lineWidth = Math.max(1, Math.round(pr));
    ctx.setLineDash([]);
    const t = TICK * pr;
    ctx.beginPath();
    for (const v of this.splits[0] ?? []) {
      const x = Math.round(u.valToPos(v, 'x', true)) + 0.5;
      if (x < left || x > right) continue;
      ctx.moveTo(x, bottom); ctx.lineTo(x, bottom - t);
      ctx.moveTo(x, top); ctx.lineTo(x, top + t);
    }
    for (const v of this.splits[1] ?? []) {
      const y = Math.round(u.valToPos(v, 'L', true)) + 0.5;
      if (y < top || y > bottom) continue;
      ctx.moveTo(left, y); ctx.lineTo(left + t, y);
      if (!hasR) { ctx.moveTo(right, y); ctx.lineTo(right - t, y); }
    }
    if (hasR) for (const v of this.splits[2] ?? []) {
      const y = Math.round(u.valToPos(v, 'R', true)) + 0.5;
      if (y < top || y > bottom) continue;
      ctx.moveTo(right, y); ctx.lineTo(right - t, y);
    }
    ctx.stroke();
    // box frame
    const lw = Math.max(1, Math.round(pr));
    ctx.lineWidth = lw;
    ctx.strokeRect(Math.round(left) + lw / 2, Math.round(top) + lw / 2, Math.round(width) - lw, Math.round(height) - lw);
    ctx.restore();
  }

  private onSelect(u: uPlot): void {
    const s = u.select;
    if (s.width < 3) return;
    const min = u.posToVal(s.left, 'x');
    const max = u.posToVal(s.left + s.width, 'x');
    u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    if (max > min) this.opts.onZoom?.(min, max);
  }

  // ------------------------------------------------------------------ legend (in-axes, northeast)

  private buildLegend(): void {
    this.legend?.remove();
    this.legend = document.createElement('div');
    this.legend.className = 'tp-legend';
    this.legendVals = [];
    this.opts.series.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'tp-lg-row';
      const sw = document.createElement('i');
      sw.style.background = this.color(i);
      const name = document.createElement('span');
      name.textContent = s.label;
      if (s.axis === 'R') name.textContent += ' →';
      const val = document.createElement('b');
      val.className = 'num';
      row.append(sw, name, val);
      this.legend.appendChild(row);
      this.legendVals.push(val);
    });
    this.legend.hidden = this.opts.series.length === 0;
    (this.u?.over ?? this.el).appendChild(this.legend);
    this.updateLegend();
  }

  private updateLegend(): void {
    const u = this.u;
    if (!u) return;
    const idx = u.cursor.idx;
    const n = this.data[0].length;
    this.opts.series.forEach((s, i) => {
      const col = this.data[i + 1] as (number | null)[] | undefined;
      let v: number | null | undefined = null;
      if (col) {
        if (idx != null && idx >= 0) v = col[idx];
        else for (let k = n - 1; k >= 0 && k >= n - 5; k--) if (col[k] != null) { v = col[k]; break; }
      }
      const txt = fmtValue(v, s.unit);
      if (this.legendVals[i].textContent !== txt) this.legendVals[i].textContent = txt;
    });
  }

  // ------------------------------------------------------------------ public API

  /** Push new data; `xRange` sets the visible window (follow mode), null keeps the current x zoom. */
  setData(data: Aligned, xRange: [number, number] | null): void {
    this.data = data;
    if (xRange) this.xRange = xRange;
    const u = this.u;
    if (!u) return;
    u.batch(() => {
      u.setData(data as uPlot.AlignedData, true);
      if (xRange) u.setScale('x', { min: xRange[0], max: xRange[1] });
    });
    this.updateLegend();
  }

  /** Set the x-range explicitly (zoom shared across subplots). */
  setXRange(min: number, max: number): void {
    this.xRange = [min, max];
    this.u?.setScale('x', { min, max });
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(60, Math.floor(width));
    this.height = Math.max(40, Math.floor(height));
    this.u?.setSize({ width: this.width, height: this.height });
  }

  /** Re-read the theme tokens and rebuild the uPlot instance (theme changes only). */
  refreshTheme(): void {
    this.pal = readPlotPalette();
    this.u?.destroy();
    this.u = null;
    this.create();
  }

  /** Draw this plot (canvas + legend) into an export canvas at device-pixel offset (dx, dy). */
  exportTo(ctx: CanvasRenderingContext2D, dx: number, dy: number): void {
    const u = this.u;
    if (!u) return;
    ctx.drawImage(u.ctx.canvas, dx, dy);
    const pr = uPlot.pxRatio;
    const rows = this.opts.series;
    if (!rows.length) return;
    const font = `${Math.round(10 * pr)}px Helvetica, Arial, sans-serif`;
    ctx.save();
    ctx.font = font;
    const texts = rows.map((s, i) => [s.label + (s.axis === 'R' ? ' →' : ''), this.legendVals[i]?.textContent ?? ''] as const);
    const wName = Math.max(...texts.map((t) => ctx.measureText(t[0]).width));
    const wVal = Math.max(...texts.map((t) => ctx.measureText(t[1]).width));
    const rowH = 14 * pr, pad = 4 * pr, sw = 18 * pr;
    const w = pad * 3 + sw + wName + 10 * pr + wVal, h = rows.length * rowH + pad * 2 - 2 * pr;
    const x = dx + u.bbox.left + 6 * pr, y = dy + u.bbox.top + 6 * pr;
    ctx.fillStyle = this.pal.bg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = this.pal.axis;
    ctx.lineWidth = pr;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.textBaseline = 'middle';
    texts.forEach(([name, val], i) => {
      const cy = y + pad + rowH * i + rowH / 2 - pr;
      ctx.strokeStyle = this.color(i);
      ctx.lineWidth = 1.5 * pr;
      ctx.beginPath(); ctx.moveTo(x + pad, cy); ctx.lineTo(x + pad + sw, cy); ctx.stroke();
      ctx.fillStyle = this.pal.axis;
      ctx.textAlign = 'left';
      ctx.fillText(name, x + pad * 2 + sw, cy);
      ctx.textAlign = 'right';
      ctx.fillText(val, x + w - pad, cy);
    });
    ctx.restore();
  }

  get canvasSize(): { width: number; height: number } {
    const c = this.u?.ctx.canvas;
    return { width: c?.width ?? 0, height: c?.height ?? 0 };
  }

  destroy(): void {
    this.u?.destroy();
    this.u = null;
    this.el.remove();
  }
}

function fmtTick(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toFixed(0);
  // strip trailing zeros from a 3-decimal representation
  return String(parseFloat(v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3)));
}
