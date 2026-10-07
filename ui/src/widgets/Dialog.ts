// Modal dialog: draggable title bar, close box, button row, Enter = default, Esc = cancel,
// Tab focus kept inside. Only the dialog (and menus) carry drop shadows.
import { h, svg, clamp } from './dom';
import { icons, type IconName } from './icons';
import { button } from './Button';

export interface DialogButton {
  id: string;
  text: string;
  isDefault?: boolean;
  isCancel?: boolean;
  /** Left-aligned (before the spacer). */
  left?: boolean;
  /** Return false (or a promise of false) to keep the dialog open. Default: close. */
  onClick?: (dlg: Dialog) => boolean | void | Promise<boolean | void>;
}

export interface DialogOptions {
  title: string;
  icon?: IconName;
  body: HTMLElement;
  buttons: DialogButton[];
  width?: number;
  onClose?: () => void;
}

export class Dialog {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly layer: HTMLDivElement;
  private readonly prevFocus: Element | null;
  private closed = false;

  static open(opt: DialogOptions): Dialog { return new Dialog(opt); }

  private constructor(private readonly opt: DialogOptions) {
    this.prevFocus = document.activeElement;
    this.layer = h('div.modal-layer');
    this.el = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': opt.title });
    if (opt.width) this.el.style.width = `${opt.width}px`;

    const title = h('div.dialog-title');
    if (opt.icon) title.append(svg(icons[opt.icon], 'dt-icon'));
    title.append(h('span.dt-text', { text: opt.title }));
    const x = h('button.title-btn', { type: 'button', title: 'Close', tabindex: -1 });
    x.append(svg(icons.close));
    x.addEventListener('click', () => this.cancel());
    title.append(x);

    this.body = h('div.dialog-body');
    this.body.append(opt.body);

    const row = h('div.dialog-buttons');
    const left = opt.buttons.filter((b) => b.left);
    const right = opt.buttons.filter((b) => !b.left);
    for (const b of left) row.append(this.makeButton(b));
    row.append(h('span.spacer'));
    for (const b of right) row.append(this.makeButton(b));

    this.el.append(title, this.body, row);
    document.body.append(this.layer, this.el);
    this.center();

    this.enableDrag(title);
    this.layer.addEventListener('mousedown', (e) => { e.preventDefault(); this.flash(); });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    const first = this.el.querySelector<HTMLElement>('.dialog-body input, .dialog-body .combo, .dialog-body [tabindex="0"]')
      ?? this.buttons.get(opt.buttons.find((b) => b.isDefault)?.id ?? '') ?? null;
    first?.focus();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.layer.remove();
    this.el.remove();
    (this.prevFocus as HTMLElement | null)?.focus?.();
    this.opt.onClose?.();
  }

  get isOpen(): boolean { return !this.closed; }

  setBusy(on: boolean): void {
    this.el.style.cursor = on ? 'progress' : '';
    for (const [id, b] of this.buttons) {
      const def = this.opt.buttons.find((x) => x.id === id);
      if (!def?.isCancel) b.disabled = on;
    }
  }

  center(): void {
    const r = this.el.getBoundingClientRect();
    this.el.style.left = `${Math.max(0, Math.round((window.innerWidth - r.width) / 2))}px`;
    this.el.style.top = `${Math.max(0, Math.round((window.innerHeight - r.height) / 2.4))}px`;
  }

  private makeButton(b: DialogButton): HTMLButtonElement {
    const el = button({ text: b.text, isDefault: b.isDefault });
    el.addEventListener('click', () => this.run(b));
    this.buttons.set(b.id, el);
    return el;
  }

  private async run(b: DialogButton): Promise<void> {
    const r = b.onClick ? await b.onClick(this) : undefined;
    if (r !== false) this.close();
  }

  private cancel(): void {
    const c = this.opt.buttons.find((b) => b.isCancel);
    if (c) void this.run(c); else this.close();
  }

  private flash(): void {
    let n = 0;
    const t = setInterval(() => {
      this.el.classList.toggle('inactive');
      if (++n >= 6) { clearInterval(t); this.el.classList.remove('inactive'); }
    }, 70);
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation(); // keep global shortcuts out while modal
    if (e.key === 'Escape') { e.preventDefault(); this.cancel(); return; }
    if (e.key === 'Enter') {
      const t = e.target as HTMLElement;
      if (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA') return;
      const d = this.opt.buttons.find((b) => b.isDefault);
      const el = d && this.buttons.get(d.id);
      if (el && !el.disabled) { e.preventDefault(); // let the field commit first
        setTimeout(() => el.click(), 0);
      }
      return;
    }
    if (e.key === 'Tab') {
      const f = [...this.el.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]')]
        .filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
      f[n].focus();
      e.preventDefault();
    }
  }

  private enableDrag(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev: MouseEvent) => {
        this.el.style.left = `${clamp(ev.clientX - dx, -r.width + 60, window.innerWidth - 60)}px`;
        this.el.style.top = `${clamp(ev.clientY - dy, 0, window.innerHeight - 20)}px`;
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }
}

/** Simple message box. */
export function messageBox(title: string, text: string, icon: IconName = 'info'): Dialog {
  const body = h('div', null);
  body.style.cssText = 'display:flex;gap:12px;align-items:flex-start;max-width:360px;padding:4px 6px';
  const ic = svg(icons[icon]);
  ic.style.cssText = 'width:32px;height:32px;flex:none';
  body.append(ic, h('div', { text }));
  return Dialog.open({ title, body, buttons: [{ id: 'ok', text: 'OK', isDefault: true, isCancel: true }] });
}
