// Categorised property grid (WinForms PropertyGrid / MATLAB Property Inspector).
// Structure is built once per setCategories(); values are patched in place.
// Editable numeric rows commit on Enter, show a pending state, and revert on failure.
import { h, setText } from './dom';
import { Led } from './Led';
import { parseNumeric } from './NumericInput';

export type PgKind = 'text' | 'num' | 'state' | 'meter';

export interface PgRowDef {
  key: string;
  label: string;
  unit?: string;
  kind?: PgKind;
  editable?: boolean;
  description?: string;
  min?: number;
  max?: number;
}

export interface PgCategory { name: string; rows: PgRowDef[]; collapsed?: boolean }

interface RowRefs {
  def: PgRowDef;
  row: HTMLDivElement;
  v: HTMLElement;
  input: HTMLInputElement | null;
  led: Led | null;
  meter: HTMLElement | null;
  last: string;
  cls: string;
}

export interface PropertyGridOptions {
  /** Commit an edited value; resolve true on success, or a string error. */
  onCommit?: (key: string, value: number) => Promise<true | string>;
}

export class PropertyGrid {
  readonly el: HTMLDivElement;
  private readonly scroller: HTMLDivElement;
  private readonly desc: HTMLDivElement;
  private readonly rows = new Map<string, RowRefs>();
  private selected: string | null = null;
  private emptyText = '';

  constructor(private readonly opt: PropertyGridOptions = {}) {
    this.el = h('div');
    this.el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column';
    const wrap = h('div');
    wrap.style.cssText = 'position:relative;flex:1;min-height:0';
    this.scroller = h('div.pgrid');
    wrap.append(this.scroller);
    this.desc = h('div.pg-desc');
    this.el.append(wrap, this.desc);
  }

  setEmpty(text: string): void {
    this.rows.clear();
    this.emptyText = text;
    this.scroller.textContent = '';
    const e = h('div', { text });
    e.style.cssText = 'padding:20px 8px;text-align:center;color:var(--c-text-dim)';
    this.scroller.append(e);
    this.setDesc(null);
  }

  setCategories(cats: PgCategory[]): void {
    this.rows.clear();
    this.scroller.textContent = '';
    this.emptyText = '';
    for (const cat of cats) {
      const header = h('div.pg-cat');
      const box = h('span.box');
      const tw = h('span.tw', null, box);
      header.append(tw, h('span', { text: cat.name }));
      const body = h('div');
      const setOpen = (open: boolean) => { box.classList.toggle('plus', !open); body.style.display = open ? '' : 'none'; };
      setOpen(!cat.collapsed);
      header.addEventListener('mousedown', (e) => { e.preventDefault(); setOpen(body.style.display === 'none'); });
      for (const def of cat.rows) body.append(this.buildRow(def));
      this.scroller.append(header, body);
    }
    if (this.selected && !this.rows.has(this.selected)) this.selected = null;
    this.setDesc(this.selected ? this.rows.get(this.selected)!.def : null);
  }

  has(key: string): boolean { return this.rows.has(key); }

  /** Update displayed text (and optional class on the value). Editable rows keep user edits. */
  setValue(key: string, text: string, cls = ''): void {
    const r = this.rows.get(key);
    if (!r) return;
    if (r.input) {
      r.last = text;
      if (document.activeElement !== r.input && !r.row.classList.contains('pending')) {
        if (r.input.value !== text) r.input.value = text;
        r.row.classList.remove('dirty');
      }
      return;
    }
    setText(r.v, text);
    if (cls !== r.cls) {
      r.cls = cls;
      r.v.className = 'v' + (r.def.kind === 'num' || r.def.kind === 'meter' ? ' n' : '') + (cls ? ' ' + cls : '');
    }
  }

  setState(key: string, state: string, text: string): void {
    const r = this.rows.get(key);
    if (!r?.led) return;
    r.led.set(state);
    setText(r.v, text);
  }

  setMeter(key: string, frac: number, cls: 'run' | 'warn' | 'bad' | null = null): void {
    const r = this.rows.get(key);
    if (!r?.meter) return;
    const w = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    const bar = r.meter.firstElementChild as HTMLElement;
    if (bar.style.width !== w) bar.style.width = w;
    const mc = 'meter' + (cls ? ' ' + cls : '');
    if (r.meter.className !== mc) r.meter.className = mc;
  }

  private buildRow(def: PgRowDef): HTMLDivElement {
    const row = h('div.pg-row');
    row.classList.add(def.editable ? 'editable' : 'ro');
    const key = h('div.pg-key', { text: def.label, title: def.description ?? def.label });
    const val = h('div.pg-val');
    let input: HTMLInputElement | null = null;
    let led: Led | null = null;
    let meter: HTMLElement | null = null;
    const isNum = def.kind === 'num' || def.kind === 'meter';
    const v = h(`span.v${isNum ? '.n' : ''}`);
    if (def.kind === 'state') { led = new Led('off'); val.append(led.el); }
    if (def.editable) {
      input = h('input.pg-edit', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
      val.append(input);
      this.wireEdit(def, row, input);
    } else {
      val.append(v);
    }
    if (def.kind === 'meter') { meter = h('span.meter', null, h('i')); val.insertBefore(meter, val.firstChild); }
    if (def.unit !== undefined) val.append(h('span.u', { text: def.unit }));
    row.append(h('div.gutter'), key, val);
    row.addEventListener('mousedown', () => this.selectRow(def.key));
    this.rows.set(def.key, { def, row, v, input, led, meter, last: '', cls: '' });
    return row;
  }

  private selectRow(key: string): void {
    if (this.selected) this.rows.get(this.selected)?.row.classList.remove('sel');
    this.selected = key;
    const r = this.rows.get(key);
    r?.row.classList.add('sel');
    this.setDesc(r?.def ?? null);
  }

  private setDesc(def: PgRowDef | null): void {
    this.desc.textContent = '';
    if (!def) {
      this.desc.append(h('span.dim', { text: this.emptyText ? '' : 'Select a property to see its description.' }));
      return;
    }
    this.desc.append(h('b', { text: def.label + (def.unit ? ` (${def.unit})` : '') }), h('span', { text: def.description ?? (def.editable ? 'Editable. Type a value and press Enter to apply.' : 'Read-only live value.') }));
  }

  private wireEdit(def: PgRowDef, row: HTMLDivElement, input: HTMLInputElement): void {
    input.addEventListener('focus', () => { this.selectRow(def.key); input.select(); });
    input.addEventListener('input', () => {
      const r = this.rows.get(def.key)!;
      row.classList.toggle('dirty', input.value !== r.last);
      row.classList.toggle('err', parseNumeric(input.value, def.min, def.max) === null);
    });
    input.addEventListener('keydown', async (e) => {
      const r = this.rows.get(def.key)!;
      if (e.key === 'Escape') {
        input.value = r.last;
        row.classList.remove('dirty', 'err');
        input.blur();
        e.stopPropagation();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = parseNumeric(input.value, def.min, def.max);
      if (v === null) { row.classList.add('err'); row.title = 'Invalid number'; return; }
      if (!this.opt.onCommit || input.value === r.last) { row.classList.remove('dirty'); return; }
      row.classList.add('pending');
      row.classList.remove('err', 'ok');
      input.readOnly = true;
      const res = await this.opt.onCommit(def.key, v).catch((err: unknown) => String((err as Error)?.message ?? err));
      input.readOnly = false;
      row.classList.remove('pending', 'dirty');
      if (res === true) {
        r.last = input.value;
        row.title = '';
        row.classList.remove('ok');
        void row.offsetWidth;
        row.classList.add('ok');
      } else {
        input.value = r.last;
        row.classList.add('err');
        row.title = res;
        setTimeout(() => row.classList.remove('err'), 2500);
      }
    });
    input.addEventListener('blur', () => {
      const r = this.rows.get(def.key);
      if (!r || row.classList.contains('pending')) return;
      if (row.classList.contains('dirty')) { input.value = r.last; row.classList.remove('dirty', 'err'); }
    });
  }
}
