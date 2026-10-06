// Main menu bar. Click or Alt/F10 to enter; Left/Right switch menus, Up/Down/Enter inside,
// Esc backs out. Alt+<mnemonic> opens a menu directly. Hover switches while a menu is open.
import { h } from '../widgets/dom';
import { PopupMenu, parseMnemonic, renderMnemonic, type MenuEntry } from '../widgets/Menu';

export interface TopMenu { label: string; items: () => MenuEntry[] }

export class MenuBar {
  readonly el: HTMLDivElement;
  private readonly heads: HTMLDivElement[] = [];
  private openIndex = -1;
  private kbdIndex = -1;
  private popup: PopupMenu | null = null;
  private altDown = false;

  constructor(private readonly menus: TopMenu[], brand?: HTMLElement) {
    this.el = h('div.menubar', { role: 'menubar' });
    menus.forEach((m, i) => {
      const head = h('div.menubar-item', { role: 'menuitem' });
      head.append(renderMnemonic(m.label));
      head.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (this.openIndex === i) this.closeAll(); else this.open(i, false);
      });
      head.addEventListener('mouseenter', () => {
        if (this.openIndex >= 0 && this.openIndex !== i) this.open(i, false);
        else if (this.openIndex < 0 && this.kbdIndex < 0) head.classList.add('hot');
      });
      head.addEventListener('mouseleave', () => { if (this.kbdIndex !== i) head.classList.remove('hot'); });
      this.heads.push(head);
      this.el.append(head);
    });
    if (brand) this.el.append(brand);

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.exitKbd());
  }

  private open(i: number, kbd: boolean): void {
    this.popup?.close('dismiss');
    this.setKbd(-1);
    this.openIndex = i;
    this.heads.forEach((hd, k) => { hd.classList.toggle('open', k === i); hd.classList.remove('hot'); });
    const r = this.heads[i].getBoundingClientRect();
    const popup = new PopupMenu(this.menus[i].items(), Math.round(r.left), Math.round(r.bottom), {
      showMnemonics: kbd,
      onHorizontal: (dir) => this.open((i + dir + this.menus.length) % this.menus.length, true),
      onClose: () => {
        if (this.popup !== popup) return;
        this.popup = null;
        this.openIndex = -1;
        this.heads.forEach((hd) => hd.classList.remove('open'));
        this.el.classList.remove('show-mnemonics');
      },
    });
    this.popup = popup;
    if (kbd) { popup.hotFirst(); this.el.classList.add('show-mnemonics'); }
  }

  private closeAll(): void {
    this.popup?.close('dismiss');
    this.exitKbd();
  }

  private setKbd(i: number): void {
    this.kbdIndex = i;
    this.el.classList.toggle('kbd', i >= 0);
    this.el.classList.toggle('show-mnemonics', i >= 0 || !!this.popup);
    this.heads.forEach((hd, k) => hd.classList.toggle('hot', k === i));
  }

  private exitKbd(): void {
    this.setKbd(-1);
    this.altDown = false;
    if (!this.popup) this.el.classList.remove('show-mnemonics');
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (document.querySelector('.dialog')) return;
    if (e.key === 'Alt') { this.altDown = true; if (!this.popup) this.el.classList.add('show-mnemonics'); return; }
    this.altDown = false;
    // Alt+mnemonic opens a menu
    if (e.altKey && !e.ctrlKey && e.key.length === 1) {
      const i = this.menus.findIndex((m) => parseMnemonic(m.label).mnemonic === e.key.toLowerCase());
      if (i >= 0) { e.preventDefault(); this.open(i, true); }
      return;
    }
    if (e.key === 'F10' && !e.shiftKey) { e.preventDefault(); if (this.kbdIndex >= 0 || this.popup) this.closeAll(); else this.setKbd(0); return; }
    if (this.kbdIndex < 0 || this.popup) return;
    // menu-bar keyboard mode (no popup open)
    const n = this.menus.length;
    switch (e.key) {
      case 'ArrowRight': this.setKbd((this.kbdIndex + 1) % n); break;
      case 'ArrowLeft': this.setKbd((this.kbdIndex - 1 + n) % n); break;
      case 'ArrowDown': case 'Enter': case ' ': this.open(this.kbdIndex, true); break;
      case 'Escape': this.exitKbd(); break;
      default: {
        const i = this.menus.findIndex((m) => parseMnemonic(m.label).mnemonic === e.key.toLowerCase());
        if (i >= 0) this.open(i, true); else this.exitKbd();
      }
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key !== 'Alt') return;
    if (this.altDown && !this.popup) {
      e.preventDefault();
      if (this.kbdIndex >= 0) this.exitKbd(); else this.setKbd(0);
    } else if (!this.popup && this.kbdIndex < 0) this.el.classList.remove('show-mnemonics');
    this.altDown = false;
  }
}
