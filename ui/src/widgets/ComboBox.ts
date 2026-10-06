// Drop-down list combo (WinForms ComboBoxStyle.DropDownList) with a custom popup so the open
// list matches the classic chrome. Keyboard: Up/Down change, Alt+Down/F4 open, Enter/Esc.
import { h, svg, setText } from './dom';
import { icons } from './icons';

export interface ComboItem<V> { value: V; label: string }

export interface ComboOptions<V> {
  items: ComboItem<V>[];
  value?: V;
  width?: number;
  title?: string;
  onChange?: (value: V) => void;
}

export class ComboBox<V> {
  readonly el: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private items: ComboItem<V>[];
  private index = -1;
  private popup: HTMLDivElement | null = null;
  private hot = -1;
  private disabled = false;
  private readonly onDocDown = (e: MouseEvent) => {
    if (!this.popup) return;
    const t = e.target as Node;
    if (!this.popup.contains(t) && !this.el.contains(t)) this.close();
  };

  constructor(private readonly opt: ComboOptions<V>) {
    this.items = opt.items;
    this.el = h('div.combo', { tabindex: 0, role: 'combobox', title: opt.title });
    if (opt.width) this.el.style.width = `${opt.width}px`;
    this.text = h('span.combo-text');
    const btn = h('span.combo-btn');
    btn.append(svg(icons.arrowDown));
    this.el.append(this.text, btn);
    this.el.addEventListener('mousedown', (e) => {
      if (this.disabled || e.button !== 0) return;
      e.preventDefault();
      this.el.focus();
      if (this.popup) this.close(); else this.open();
    });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== this.el) this.close(); }, 0));
    this.setValue(opt.value ?? opt.items[0]?.value, true);
  }

  get value(): V | undefined { return this.items[this.index]?.value; }

  setItems(items: ComboItem<V>[], value?: V): void {
    const keep = value ?? this.value;
    this.items = items;
    this.index = -1;
    this.setValue(keep, true);
    if (this.index < 0 && items.length) this.choose(0, true);
    if (!items.length) setText(this.text, '');
  }

  setValue(v: V | undefined, silent = false): void {
    const i = this.items.findIndex((it) => it.value === v);
    if (i < 0) return;
    this.choose(i, silent);
  }

  setDisabled(on: boolean): void {
    this.disabled = on;
    this.el.classList.toggle('disabled', on);
    this.el.tabIndex = on ? -1 : 0;
    if (on) this.close();
  }

  private choose(i: number, silent: boolean): void {
    if (i < 0 || i >= this.items.length) return;
    const changed = i !== this.index;
    this.index = i;
    setText(this.text, this.items[i].label);
    if (changed && !silent) this.opt.onChange?.(this.items[i].value);
  }

  private open(): void {
    if (this.popup || !this.items.length) return;
    const r = this.el.getBoundingClientRect();
    const pop = h('div.listbox', { role: 'listbox' });
    pop.style.minWidth = `${r.width}px`;
    this.items.forEach((it, i) => {
      const o = h('div.opt', { text: it.label });
      o.addEventListener('mouseenter', () => this.setHot(i));
      o.addEventListener('mousedown', (e) => e.preventDefault());
      o.addEventListener('click', () => { this.choose(i, false); this.close(); });
      pop.append(o);
    });
    document.body.append(pop);
    const below = window.innerHeight - r.bottom;
    const ph = Math.min(pop.offsetHeight, 240);
    pop.style.left = `${Math.round(r.left)}px`;
    pop.style.top = `${Math.round(below >= ph + 2 ? r.bottom : r.top - ph)}px`;
    this.popup = pop;
    this.el.classList.add('open');
    this.setHot(this.index);
    document.addEventListener('mousedown', this.onDocDown, true);
  }

  close(): void {
    if (!this.popup) return;
    this.popup.remove();
    this.popup = null;
    this.el.classList.remove('open');
    document.removeEventListener('mousedown', this.onDocDown, true);
  }

  private setHot(i: number): void {
    if (!this.popup) return;
    this.hot = i;
    [...this.popup.children].forEach((c, k) => c.classList.toggle('hot', k === i));
    (this.popup.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent): void {
    if (this.disabled) return;
    const n = this.items.length;
    if (this.popup) {
      switch (e.key) {
        case 'ArrowDown': this.setHot(Math.min(n - 1, this.hot + 1)); break;
        case 'ArrowUp': this.setHot(Math.max(0, this.hot - 1)); break;
        case 'Home': this.setHot(0); break;
        case 'End': this.setHot(n - 1); break;
        case 'Enter':
        case ' ': this.choose(this.hot, false); this.close(); break;
        case 'Tab': this.close(); return;
        case 'Escape':
        case 'F4': this.close(); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4') { this.open(); e.preventDefault(); return; }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight': this.choose(Math.min(n - 1, this.index + 1), false); break;
      case 'ArrowUp':
      case 'ArrowLeft': this.choose(Math.max(0, this.index - 1), false); break;
      case 'Home': this.choose(0, false); break;
      case 'End': this.choose(n - 1, false); break;
      default: {
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        const ch = e.key.toLowerCase();
        for (let k = 1; k <= n; k++) {
          const i = (this.index + k) % n;
          if (this.items[i].label.toLowerCase().startsWith(ch)) { this.choose(i, false); break; }
        }
      }
    }
    e.preventDefault();
  }
}
