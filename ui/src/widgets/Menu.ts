// Classic popup menu with check/radio marks, accelerator text, submenus and full keyboard
// navigation. Labels use '&' to mark the mnemonic letter ("&File").
import { h, svg } from './dom';
import { icons } from './icons';

export type MenuEntry = MenuItem | 'sep';

export interface MenuItem {
  label: string;
  accel?: string;
  /** Static or computed at open time. */
  checked?: boolean | (() => boolean);
  radio?: boolean;
  disabled?: boolean | (() => boolean);
  action?: () => void;
  submenu?: MenuEntry[] | (() => MenuEntry[]);
}

const val = <T>(v: T | (() => T) | undefined): T | undefined => (typeof v === 'function' ? (v as () => T)() : v);

/** Split "&File" → { text: 'File', mnemonic: 'f', idx: 0 }. */
export function parseMnemonic(label: string): { text: string; mnemonic: string | null; idx: number } {
  const i = label.indexOf('&');
  if (i < 0 || i === label.length - 1) return { text: label, mnemonic: null, idx: -1 };
  return { text: label.slice(0, i) + label.slice(i + 1), mnemonic: label[i + 1].toLowerCase(), idx: i };
}

export function renderMnemonic(label: string): DocumentFragment {
  const { text, idx } = parseMnemonic(label);
  const f = document.createDocumentFragment();
  if (idx < 0) { f.append(text); return f; }
  f.append(text.slice(0, idx), h('span.mnemonic', { text: text[idx] }), text.slice(idx + 1));
  return f;
}

export interface PopupOptions {
  /** Called after an item action runs or the menu is dismissed. */
  onClose?: (reason: 'action' | 'dismiss') => void;
  /** Left/Right at the top level (MenuBar uses this to switch menus). */
  onHorizontal?: (dir: -1 | 1) => void;
  parent?: PopupMenu;
  showMnemonics?: boolean;
}

export class PopupMenu {
  readonly el: HTMLDivElement;
  private readonly entries: MenuEntry[];
  private readonly rows: (HTMLDivElement | null)[] = [];
  private hot = -1;
  private child: PopupMenu | null = null;
  private hoverTimer = 0;
  private closed = false;
  private static root: PopupMenu | null = null;

  private static readonly onDocKey = (e: KeyboardEvent) => {
    let m = PopupMenu.root;
    while (m?.child) m = m.child;
    if (m && m.handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
  };
  private static readonly onDocDown = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('.menu-popup') || t.closest('.menubar-item')) return;
    PopupMenu.root?.close('dismiss');
  };

  constructor(entries: MenuEntry[], x: number, y: number, private readonly opt: PopupOptions = {}) {
    this.entries = entries;
    this.el = h('div.menu-popup', { role: 'menu' });
    if (opt.showMnemonics) this.el.classList.add('show-mnemonics');
    entries.forEach((e, i) => {
      if (e === 'sep') { this.el.append(h('div.menu-sep')); this.rows.push(null); return; }
      const dis = !!val(e.disabled);
      const row = h('div.menu-item', { role: 'menuitem' });
      if (dis) row.classList.add('disabled');
      const chk = h('span.mi-check');
      if (val(e.checked)) chk.append(svg(e.radio ? icons.radioDot : icons.check));
      const lab = h('span.mi-label');
      lab.append(renderMnemonic(e.label));
      const acc = h('span.mi-accel', { text: e.accel ?? '' });
      const sub = h('span.mi-sub');
      if (e.submenu) sub.append(svg(icons.arrowRight));
      row.append(chk, lab, acc, sub);
      row.addEventListener('mouseenter', () => {
        this.setHot(i);
        clearTimeout(this.hoverTimer);
        this.hoverTimer = window.setTimeout(() => (e.submenu ? this.openChild(i, false) : this.closeChild()), 250);
      });
      row.addEventListener('mousedown', (ev) => ev.preventDefault());
      row.addEventListener('click', () => this.activate(i, false));
      this.el.append(row);
      this.rows.push(row);
    });
    document.body.append(this.el);
    // keep on screen
    const r = this.el.getBoundingClientRect();
    const left = x + r.width > window.innerWidth ? Math.max(0, window.innerWidth - r.width - 2) : x;
    const top = y + r.height > window.innerHeight ? Math.max(0, window.innerHeight - r.height - 2) : y;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    if (!opt.parent) {
      PopupMenu.root?.close('dismiss');
      PopupMenu.root = this;
      document.addEventListener('keydown', PopupMenu.onDocKey, true);
      document.addEventListener('mousedown', PopupMenu.onDocDown, true);
    }
  }

  static get isOpen(): boolean { return PopupMenu.root !== null; }

  close(reason: 'action' | 'dismiss' = 'dismiss'): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.hoverTimer);
    this.closeChild();
    this.el.remove();
    if (PopupMenu.root === this) {
      PopupMenu.root = null;
      document.removeEventListener('keydown', PopupMenu.onDocKey, true);
      document.removeEventListener('mousedown', PopupMenu.onDocDown, true);
    }
    this.opt.onClose?.(reason);
  }

  /** Highlight the first enabled item (keyboard-opened menus). */
  hotFirst(): void { this.move(1, -1); }

  private setHot(i: number): void {
    this.hot = i;
    this.rows.forEach((r, k) => r?.classList.toggle('hot', k === i));
  }

  private move(dir: 1 | -1, from = this.hot): void {
    const n = this.entries.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (this.entries[i] !== 'sep') { this.setHot(i); return; }
    }
  }

  private item(i: number): MenuItem | null {
    const e = this.entries[i];
    return e && e !== 'sep' ? e : null;
  }

  private openChild(i: number, kbd: boolean): void {
    const it = this.item(i);
    if (!it?.submenu || val(it.disabled)) return;
    if (this.child && this.child.anchorIndex === i) return;
    this.closeChild();
    const r = this.rows[i]!.getBoundingClientRect();
    const c = new PopupMenu(val(it.submenu)!, r.right - 3, r.top - 3, {
      parent: this,
      showMnemonics: this.opt.showMnemonics,
      onClose: (reason) => { if (reason === 'action') this.close('action'); },
    });
    c.anchorIndex = i;
    this.child = c;
    if (kbd) c.hotFirst();
  }
  private anchorIndex = -1;

  private closeChild(): void {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    c.close('dismiss');
  }

  private activate(i: number, kbd: boolean): void {
    const it = this.item(i);
    if (!it || val(it.disabled)) return;
    if (it.submenu) { this.openChild(i, kbd); return; }
    // close the whole chain first, then run (so dialogs get focus)
    let top: PopupMenu = this;
    while (top.opt.parent) top = top.opt.parent;
    top.close('action');
    it.action?.();
  }

  private handleKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'ArrowDown': this.move(1); return true;
      case 'ArrowUp': this.move(-1); return true;
      case 'Home': this.move(1, -1); return true;
      case 'End': this.move(-1, this.entries.length); return true;
      case 'Enter': case ' ': if (this.hot >= 0) this.activate(this.hot, true); return true;
      case 'ArrowRight':
        if (this.item(this.hot)?.submenu) { this.openChild(this.hot, true); return true; }
        this.root().opt.onHorizontal?.(1); return true;
      case 'ArrowLeft':
        if (this.opt.parent) { this.opt.parent.closeChild(); return true; }
        this.opt.onHorizontal?.(-1); return true;
      case 'Escape':
        if (this.opt.parent) this.opt.parent.closeChild(); else this.close('dismiss');
        return true;
      case 'Tab': return true;
      case 'Alt': this.root().close('dismiss'); return true;
      default: {
        if (e.key.length !== 1 || e.ctrlKey) return false;
        const ch = e.key.toLowerCase();
        const i = this.entries.findIndex((x) => x !== 'sep' && parseMnemonic(x.label).mnemonic === ch);
        if (i >= 0) { this.setHot(i); this.activate(i, true); return true; }
        return false;
      }
    }
  }

  private root(): PopupMenu {
    let m: PopupMenu = this;
    while (m.opt.parent) m = m.opt.parent;
    return m;
  }
}
