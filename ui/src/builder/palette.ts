// Toolbox palette (VS designer style): the 7 asset kinds. Drag one onto the plan, or click to arm
// and then click in the plan. Keyboard: Up/Down move, Enter adds at the view centre, Space arms.
import type { AssetKind } from '../net/contracts';
import { h, svg } from '../widgets/dom';
import { icons } from '../widgets/icons';
import type { BuilderCanvas } from './canvas';
import type { BuilderEditor } from './editor';
import { KIND_ICON } from './icons';
import { KINDS, KIND_SPECS } from './model';

export class Palette {
  readonly el: HTMLDivElement;
  private readonly items = new Map<AssetKind, HTMLDivElement>();
  private focusKind: AssetKind = 'source';
  private ghost: HTMLDivElement | null = null;

  constructor(private readonly ed: BuilderEditor, private readonly canvas: BuilderCanvas) {
    this.el = h('div.bld-palette', { tabindex: 0, role: 'listbox', 'aria-label': 'Asset toolbox' });
    const head = h('div.bld-pal-group', null, h('span.box'), h('span', { text: 'Plant Assets' }));
    this.el.append(head);
    const pointer = h('div.bld-pal-item.pointer', { role: 'option', title: 'Pointer (select / move)' });
    pointer.append(svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path d="M3.5 1.5v11l3-2.6 2 4.6 2-.9-2-4.5h4z" style="fill:var(--c-field)" stroke="currentColor" stroke-linejoin="round"/></svg>'), h('span', { text: 'Pointer' }));
    pointer.addEventListener('mousedown', (e) => { e.preventDefault(); this.ed.arm(null); this.ed.setTool('select'); });
    this.el.append(pointer);
    for (const k of KINDS) {
      const spec = KIND_SPECS[k];
      const it = h('div.bld-pal-item', { role: 'option', title: `${spec.label} (${spec.prefix}-nn): ${spec.description}\nDrag onto the plan, or click then click in the plan.` });
      it.append(svg(icons[KIND_ICON[k]]), h('span', { text: spec.label }), h('span.pfx', { text: spec.prefix }));
      it.addEventListener('pointerdown', (e) => this.startDrag(k, e));
      this.el.append(it);
      this.items.set(k, it);
    }
    this.el.append(h('div.bld-pal-hint', { text: 'Drag onto the plan, or click a kind and click in the plan. Enter adds at the centre.' }));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('focus', () => this.paint());
    this.el.addEventListener('blur', () => this.paint());
    ed.on('tool', () => this.paint());
    this.paint();
  }

  private paint(): void {
    const focused = document.activeElement === this.el;
    for (const [k, it] of this.items) {
      it.classList.toggle('armed', this.ed.placeKind === k);
      it.classList.toggle('focus', focused && this.focusKind === k);
    }
    this.el.querySelector('.pointer')?.classList.toggle('armed', !this.ed.placeKind && this.ed.tool === 'select');
  }

  private onKey(e: KeyboardEvent): void {
    const i = KINDS.indexOf(this.focusKind);
    if (e.key === 'ArrowDown') this.focusKind = KINDS[Math.min(KINDS.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') this.focusKind = KINDS[Math.max(0, i - 1)];
    else if (e.key === 'Home') this.focusKind = KINDS[0];
    else if (e.key === 'End') this.focusKind = KINDS[KINDS.length - 1];
    else if (e.key === 'Enter') {
      const c = this.canvas.centre();
      this.ed.add(this.focusKind, c.x, c.z);
      this.canvas.focus();
    } else if (e.key === ' ') {
      this.ed.arm(this.ed.placeKind === this.focusKind ? null : this.focusKind);
      this.canvas.focus();
    } else if (e.key === 'Escape') this.ed.arm(null);
    else return;
    e.preventDefault();
    e.stopPropagation();
    this.paint();
  }

  private startDrag(kind: AssetKind, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.focusKind = kind;
    const x0 = e.clientX, y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) {
        dragging = true;
        this.ed.arm(kind);
        this.ghost = h('div.bld-drag-ghost');
        this.ghost.append(svg(icons[KIND_ICON[kind]]), h('span', { text: KIND_SPECS[kind].label }));
        document.body.append(this.ghost);
      }
      if (!dragging || !this.ghost) return;
      const over = this.canvas.containsClient(ev.clientX, ev.clientY);
      this.ghost.style.display = over ? 'none' : '';
      this.ghost.style.left = `${ev.clientX + 10}px`;
      this.ghost.style.top = `${ev.clientY + 6}px`;
      if (over) this.canvas.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: ev.clientX, clientY: ev.clientY, altKey: ev.altKey }));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.ghost?.remove();
      this.ghost = null;
      if (!dragging) {
        this.ed.arm(this.ed.placeKind === kind ? null : kind);
        this.canvas.focus();
        return;
      }
      if (this.canvas.containsClient(ev.clientX, ev.clientY)) {
        this.canvas.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: ev.clientX, clientY: ev.clientY, button: 0, altKey: ev.altKey, bubbles: true }));
        this.canvas.focus();
      } else {
        this.ed.arm(null);
        this.ed.status('Drop cancelled');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
