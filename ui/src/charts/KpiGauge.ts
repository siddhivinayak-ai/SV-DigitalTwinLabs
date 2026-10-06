import { CanvasWidget } from './CanvasWidget';
import { ARC_START, ARC_SWEEP, arcAngle, clampValue, fraction, gaugeColor, type GaugeZones, type LevelColors } from './gaugeMath';
import { cssVar } from './theme';

interface Palette extends LevelColors { face: string; track: string; text: string; dim: string; frame: string; field: string; mono: string; ui: string }

function readPalette(): Palette {
  return {
    alarm: cssVar('--s-fault', '#d0021b'),
    warn: cssVar('--s-starved', '#e8a317'),
    target: cssVar('--s-running', '#76b900'),
    normal: cssVar('--c-text-dim', '#5a5a5a'),
    face: cssVar('--c-field', '#ffffff'),
    track: cssVar('--plot-grid', '#e5e5e5'),
    text: cssVar('--c-text', '#000000'),
    dim: cssVar('--c-text-dim', '#5a5a5a'),
    frame: cssVar('--c-shadow', '#808080'),
    field: cssVar('--c-field', '#ffffff'),
    mono: cssVar('--font-mono', 'Consolas, monospace'),
    ui: cssVar('--font-ui', 'Tahoma, sans-serif'),
  };
}

export interface GaugeOptions {
  label: string;
  unit?: string;
  min?: number;
  max?: number;
  zones?: GaugeZones;
  /** Display scale for tick labels and readout (e.g. 100 for fractions shown as %). */
  scale?: number;
  digits?: number;
}

/** Classic analog arc gauge: 240° dial, minor/major ticks, zone bands, needle, target marker, mono readout. */
export class ArcGauge extends CanvasWidget {
  private value: number | null = null;
  private pal = readPalette();

  constructor(host: HTMLElement, private readonly o: GaugeOptions) {
    super(host, 'kg-arc');
  }

  set(v: number | null | undefined): void {
    const nv = v == null || !Number.isFinite(v) ? null : v;
    if (nv === this.value) return;
    this.value = nv;
    this.invalidate();
  }

  refreshTheme(): void {
    this.pal = readPalette();
    this.invalidate();
  }

  protected draw(c: CanvasRenderingContext2D, w: number, h: number): void {
    const p = this.pal;
    const min = this.o.min ?? 0, max = this.o.max ?? 1, scale = this.o.scale ?? 100;
    const z = this.o.zones ?? {};
    const cx = w / 2;
    const R = Math.max(20, Math.min(w / 2 - 4, (h - 8) / 1.78));
    const cy = 5 + R;
    const A = (v: number) => arcAngle(v, min, max);

    // zone bands (outer ring): red below alarm, amber below warn, green from target
    const band = (from: number, to: number, color: string) => {
      if (to <= from) return;
      c.beginPath();
      c.strokeStyle = color;
      c.lineWidth = 4;
      c.arc(cx, cy, R - 2, A(from), A(to));
      c.stroke();
    };
    c.lineCap = 'butt';
    c.beginPath(); c.strokeStyle = p.track; c.lineWidth = 4; c.arc(cx, cy, R - 2, ARC_START, ARC_START + ARC_SWEEP); c.stroke();
    if (z.alarm != null) band(min, z.alarm, p.alarm);
    if (z.warn != null) band(z.alarm ?? min, z.warn, p.warn);
    if (z.target != null) band(z.target, max, p.target);

    // value arc
    const v = this.value;
    const col = gaugeColor(v, z, p);
    c.beginPath(); c.strokeStyle = p.track; c.lineWidth = 9; c.arc(cx, cy, R - 12, ARC_START, ARC_START + ARC_SWEEP); c.stroke();
    if (v != null) { c.beginPath(); c.strokeStyle = col; c.lineWidth = 9; c.arc(cx, cy, R - 12, ARC_START, A(clampValue(v, min, max))); c.stroke(); }

    // ticks + labels
    c.strokeStyle = p.text;
    c.fillStyle = p.dim;
    c.font = `9px ${p.ui}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let i = 0; i <= 50; i++) {
      const f = i / 50, a = ARC_START + f * ARC_SWEEP;
      const major = i % 5 === 0;
      const r0 = R - 17 - (major ? 6 : 3), r1 = R - 17;
      c.lineWidth = major ? 1.2 : 0.6;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      c.stroke();
      if (i % 10 === 0) {
        const rl = R - 31;
        c.fillText(String(Math.round((min + f * (max - min)) * scale)), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl);
      }
    }

    // target marker
    if (z.target != null) {
      const a = A(z.target), r = R + 1;
      c.fillStyle = p.text;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (r - 7), cy + Math.sin(a) * (r - 7));
      c.lineTo(cx + Math.cos(a + 0.06) * (r + 2), cy + Math.sin(a + 0.06) * (r + 2));
      c.lineTo(cx + Math.cos(a - 0.06) * (r + 2), cy + Math.sin(a - 0.06) * (r + 2));
      c.fill();
    }

    // needle
    const na = A(v ?? min);
    c.strokeStyle = p.text;
    c.lineWidth = 2;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(cx - Math.cos(na) * 8, cy - Math.sin(na) * 8);
    c.lineTo(cx + Math.cos(na) * (R - 16), cy + Math.sin(na) * (R - 16));
    c.stroke();
    c.lineCap = 'butt';
    c.fillStyle = p.text;
    c.beginPath(); c.arc(cx, cy, 4.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = p.face;
    c.beginPath(); c.arc(cx, cy, 1.8, 0, Math.PI * 2); c.fill();

    // readout
    const txt = v == null ? '—' : (v * scale).toFixed(this.o.digits ?? 1);
    const ry = cy + R * 0.52;
    c.font = `bold ${R > 56 ? 19 : 16}px ${p.mono}`;
    c.fillStyle = p.text;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(txt + (this.o.unit ?? ''), cx, ry);
    c.font = `bold 10px ${p.ui}`;
    c.fillStyle = p.dim;
    c.fillText(this.o.label, cx, ry + 16);
  }
}

export interface MeterOptions {
  label: string;
  zones?: GaugeZones;
  min?: number;
  max?: number;
  scale?: number;
  digits?: number;
  unit?: string;
}

/** Horizontal bar meter with a sunken track, 10 % ticks and a target marker. */
export class BarMeter extends CanvasWidget {
  private value: number | null = null;
  private pal = readPalette();

  constructor(host: HTMLElement, private readonly o: MeterOptions) {
    super(host, 'kg-bar');
  }

  set(v: number | null | undefined): void {
    const nv = v == null || !Number.isFinite(v) ? null : v;
    if (nv === this.value) return;
    this.value = nv;
    this.invalidate();
  }

  refreshTheme(): void {
    this.pal = readPalette();
    this.invalidate();
  }

  protected draw(c: CanvasRenderingContext2D, w: number, h: number): void {
    const p = this.pal;
    const min = this.o.min ?? 0, max = this.o.max ?? 1, scale = this.o.scale ?? 100;
    const z = this.o.zones ?? {};
    const lw = 14, vw = 50;
    const x0 = lw + 2, x1 = w - vw - 2;
    const ty = 3, th = h - 6;
    c.font = `bold 11px ${p.ui}`;
    c.fillStyle = p.text;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.fillText(this.o.label, 1, h / 2);
    // sunken track
    c.fillStyle = p.field;
    c.fillRect(x0, ty, x1 - x0, th);
    c.fillStyle = p.frame;
    c.fillRect(x0, ty, x1 - x0, 1);
    c.fillRect(x0, ty, 1, th);
    // fill
    const v = this.value;
    if (v != null) {
      c.fillStyle = gaugeColor(v, z, p);
      c.fillRect(x0 + 2, ty + 2, Math.max(0, (x1 - x0 - 3) * fraction(v, min, max)), th - 4);
    }
    // ticks
    c.fillStyle = p.track;
    for (let i = 1; i < 10; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / 10) + 0.5;
      c.fillStyle = i === 5 ? p.dim : p.frame;
      c.globalAlpha = 0.45;
      c.fillRect(x, ty + th - (i === 5 ? 6 : 4), 1, i === 5 ? 5 : 3);
      c.globalAlpha = 1;
    }
    // target marker
    if (z.target != null) {
      const x = Math.round(x0 + (x1 - x0) * fraction(z.target, min, max)) + 0.5;
      c.fillStyle = p.text;
      c.fillRect(x - 0.5, ty - 1, 1.5, th + 2);
      c.beginPath(); c.moveTo(x - 3.5, ty - 2); c.lineTo(x + 4, ty - 2); c.lineTo(x + 0.25, ty + 2.5); c.fill();
    }
    // value
    c.font = `11px ${p.mono}`;
    c.fillStyle = p.text;
    c.textAlign = 'right';
    c.fillText(v == null ? '—' : `${(v * scale).toFixed(this.o.digits ?? 1)}${this.o.unit ?? ' %'}`, w - 1, h / 2 + 0.5);
  }
}
