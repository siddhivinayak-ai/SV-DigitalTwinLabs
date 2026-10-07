// NumericUpDown: right-aligned mono text with spin buttons. Enter commits, Up/Down step.
import { h, svg, clamp } from './dom';
import { icons } from './icons';

export interface NumericOptions {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  width?: number;
  title?: string;
  onCommit?: (value: number) => void;
}

/** Parse user text into a number within bounds; null if invalid (pure). */
export function parseNumeric(text: string, min = -Infinity, max = Infinity): number | null {
  const t = text.trim().replace(/,/g, '');
  if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < min || v > max) return null;
  return v;
}

export class NumericInput {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private current: number;

  constructor(private readonly opt: NumericOptions) {
    this.current = opt.value;
    this.el = h('div.numeric', { title: opt.title });
    if (opt.width) this.el.style.width = `${opt.width}px`;
    this.input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
    const spin = h('div.spin');
    const up = h('button', { type: 'button', tabindex: -1 });
    up.append(svg(icons.arrowUp));
    const dn = h('button', { type: 'button', tabindex: -1 });
    dn.append(svg(icons.arrowDown));
    spin.append(up, dn);
    this.el.append(this.input, spin);
    this.write(opt.value);
    up.addEventListener('mousedown', (e) => { e.preventDefault(); this.step(1); });
    dn.addEventListener('mousedown', (e) => { e.preventDefault(); this.step(-1); });
    this.input.addEventListener('input', () => this.el.classList.toggle('invalid', this.parsed() === null));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { this.step(1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { this.step(-1); e.preventDefault(); }
      else if (e.key === 'Enter') this.commit();
    });
    this.input.addEventListener('blur', () => this.commit());
  }

  get value(): number { return this.parsed() ?? this.current; }
  get valid(): boolean { return this.parsed() !== null; }

  setValue(v: number): void { this.current = v; this.write(v); }

  setDisabled(on: boolean): void { this.input.disabled = on; this.el.classList.toggle('disabled', on); }

  private parsed(): number | null {
    return parseNumeric(this.input.value, this.opt.min, this.opt.max);
  }

  private write(v: number): void {
    this.input.value = this.opt.decimals !== undefined ? v.toFixed(this.opt.decimals) : String(v);
    this.el.classList.remove('invalid');
  }

  private step(dir: number): void {
    const s = this.opt.step ?? 1;
    const v = clamp(+(this.value + dir * s).toFixed(10), this.opt.min ?? -Infinity, this.opt.max ?? Infinity);
    this.setValue(v);
    this.opt.onCommit?.(v);
  }

  private commit(): void {
    const v = this.parsed();
    if (v === null) { this.write(this.current); return; }
    if (v !== this.current) { this.current = v; this.opt.onCommit?.(v); }
    this.write(v);
  }
}
