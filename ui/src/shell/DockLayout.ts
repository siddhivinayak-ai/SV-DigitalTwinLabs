// Fixed dock arrangement (V1-Spec §4.1) with draggable splitters, hideable panes,
// active/inactive title bars and sizes persisted in localStorage.
//
//  ┌ left ┐│┌──── center ────┐│┌ rightTop ┐
//  │      │││                │││          │
//  │      ││├──── bottom ────┤│├ rightBot ┤
//  └──────┘│└────────────────┘│└──────────┘
import type { Panel } from '../panels/panel';
import { TabStrip } from '../widgets/TabStrip';
import { h, svg, setText, storage, clamp } from '../widgets/dom';
import { icons, type IconName } from '../widgets/icons';

export type PaneId = 'left' | 'center' | 'bottom' | 'rightTop' | 'rightBottom';
export type ToggleablePane = Exclude<PaneId, 'center'>;

export interface LayoutState {
  sizes: { left: number; right: number; bottom: number; rightBottom: number };
  visible: Record<ToggleablePane, boolean>;
  bottomTab: string;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sizes: { left: 236, right: 318, bottom: 262, rightBottom: 330 },
  visible: { left: true, bottom: true, rightTop: true, rightBottom: true },
  bottomTab: 'trends',
};

const KEY = 'svdtl.layout.v1';
const MIN = { left: 150, right: 220, bottom: 96, rightBottom: 90, centerW: 240, centerH: 120, rightTopH: 110 };

/** Merge persisted JSON over defaults, dropping anything malformed (pure). */
export function restoreLayout(json: string | null): LayoutState {
  const d = structuredClone(DEFAULT_LAYOUT);
  if (!json) return d;
  try {
    const s = JSON.parse(json) as Partial<LayoutState>;
    for (const k of Object.keys(d.sizes) as (keyof LayoutState['sizes'])[]) {
      const v = s.sizes?.[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 40 && v <= 4000) d.sizes[k] = Math.round(v);
    }
    for (const k of Object.keys(d.visible) as ToggleablePane[]) {
      const v = s.visible?.[k];
      if (typeof v === 'boolean') d.visible[k] = v;
    }
    if (typeof s.bottomTab === 'string') d.bottomTab = s.bottomTab;
  } catch { /* defaults */ }
  return d;
}

export interface PaneSpec { title: string; icon: IconName; panel?: Panel; closable?: boolean }
export interface TabbedPaneSpec { title: string; icon: IconName; tabs: { id: string; label: string; icon?: IconName; panel: Panel }[] }

interface PaneRefs { el: HTMLDivElement; title: HTMLSpanElement; sub: HTMLSpanElement }

export class DockLayout {
  readonly el: HTMLDivElement;
  readonly tabs: TabStrip;
  private state: LayoutState;
  private readonly panes = new Map<PaneId, PaneRefs>();
  private readonly leftEl: HTMLDivElement;
  private readonly rightCol: HTMLDivElement;
  private readonly splitL: HTMLDivElement;
  private readonly splitR: HTMLDivElement;
  private readonly splitB: HTMLDivElement;
  private readonly splitRB: HTMLDivElement;
  private readonly observers: ResizeObserver[] = [];
  private readonly mounted: Panel[] = [];
  private activePane: PaneId = 'center';
  private readonly listeners = new Set<() => void>();
  private readonly spec: { left: PaneSpec; center: PaneSpec; bottom: TabbedPaneSpec; rightTop: PaneSpec; rightBottom: PaneSpec };

  constructor(spec: { left: PaneSpec; center: PaneSpec; bottom: TabbedPaneSpec; rightTop: PaneSpec; rightBottom: PaneSpec }) {
    this.state = restoreLayout(storage.get(KEY));
    this.el = h('div.dock');

    this.leftEl = this.makePane('left', spec.left);
    this.splitL = h('div.splitter.v', { title: 'Drag to resize' });

    const centerCol = h('div.dock-col.grow');
    const center = this.makePane('center', spec.center);
    center.classList.add('grow');
    this.splitB = h('div.splitter.h', { title: 'Drag to resize' });
    this.tabs = new TabStrip(spec.bottom.tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon })), (id) => {
      this.state.bottomTab = id;
      this.setSubtitle('bottom', '');
      setText(this.panes.get('bottom')!.title, this.tabs.label(id));
      this.save();
      this.emit();
    });
    const bottom = this.makePane('bottom', { title: spec.bottom.title, icon: spec.bottom.icon, closable: true }, this.tabs.el);
    bottom.classList.add('tabbed');
    centerCol.append(center, this.splitB, bottom);

    this.splitR = h('div.splitter.v', { title: 'Drag to resize' });
    this.rightCol = h('div.dock-col');
    const rt = this.makePane('rightTop', spec.rightTop);
    this.splitRB = h('div.splitter.h', { title: 'Drag to resize' });
    const rb = this.makePane('rightBottom', spec.rightBottom);
    this.rightCol.append(rt, this.splitRB, rb);

    this.el.append(this.leftEl, this.splitL, centerCol, this.splitR, this.rightCol);

    const tabId = spec.bottom.tabs.some((t) => t.id === this.state.bottomTab) ? this.state.bottomTab : spec.bottom.tabs[0].id;
    this.tabs.activate(tabId);

    this.wireSplitter(this.splitL, 'x', () => this.state.sizes.left, (v) => (this.state.sizes.left = v), 1, () => [MIN.left, this.maxWidth('left')]);
    this.wireSplitter(this.splitR, 'x', () => this.state.sizes.right, (v) => (this.state.sizes.right = v), -1, () => [MIN.right, this.maxWidth('right')]);
    this.wireSplitter(this.splitB, 'y', () => this.state.sizes.bottom, (v) => (this.state.sizes.bottom = v), -1, () => [MIN.bottom, Math.max(MIN.bottom, centerCol.clientHeight - MIN.centerH)]);
    this.wireSplitter(this.splitRB, 'y', () => this.state.sizes.rightBottom, (v) => (this.state.sizes.rightBottom = v), -1, () => [MIN.rightBottom, Math.max(MIN.rightBottom, this.rightCol.clientHeight - MIN.rightTopH)]);

    this.spec = spec;

    this.el.addEventListener('pointerdown', (e) => {
      const pane = (e.target as HTMLElement).closest<HTMLElement>('.pane');
      if (pane?.dataset.pane) this.setActive(pane.dataset.pane as PaneId);
    }, true);
    this.el.addEventListener('focusin', (e) => {
      const pane = (e.target as HTMLElement).closest<HTMLElement>('.pane');
      if (pane?.dataset.pane) this.setActive(pane.dataset.pane as PaneId);
    });
    this.apply();
    this.setActive('center');
    window.addEventListener('resize', () => this.apply());
  }

  /** Mount every panel. Call once, after the dock element is attached to the document. */
  mountAll(): void {
    const spec = this.spec;
    for (const id of ['left', 'center', 'rightTop', 'rightBottom'] as const) {
      const p = spec[id].panel;
      if (p) this.mountPanel(p, this.panes.get(id)!.el.querySelector<HTMLElement>('.pane-host')!);
    }
    for (const t of spec.bottom.tabs) this.mountPanel(t.panel, this.tabs.page(t.id));
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { this.listeners.forEach((f) => f()); }

  isVisible(p: ToggleablePane): boolean { return this.state.visible[p]; }

  setVisible(p: ToggleablePane, on: boolean): void {
    this.state.visible[p] = on;
    this.apply();
    this.save();
    this.emit();
  }

  showTab(id: string): void {
    if (!this.state.visible.bottom) this.setVisible('bottom', true);
    this.tabs.activate(id);
  }

  setSubtitle(p: PaneId, text: string): void {
    const r = this.panes.get(p);
    if (r) setText(r.sub, text ? ` — ${text}` : '');
  }

  resetLayout(): void {
    const tab = this.state.bottomTab;
    this.state = structuredClone(DEFAULT_LAYOUT);
    this.state.bottomTab = tab;
    this.apply();
    this.save();
    this.emit();
  }

  dispose(): void {
    this.observers.forEach((o) => o.disconnect());
    this.mounted.forEach((p) => p.dispose());
  }

  // ---------- internals ----------

  private makePane(id: PaneId, spec: PaneSpec, content?: HTMLElement): HTMLDivElement {
    const el = h('div.pane');
    el.dataset.pane = id;
    const bar = h('div.pane-title');
    bar.append(svg(icons[spec.icon], 'pt-icon'));
    const title = h('span', { text: spec.title });
    const sub = h('span.pt-sub');
    bar.append(h('span.pt-text', null, title, sub));
    if (spec.closable !== false && id !== 'center') {
      const x = h('button.title-btn', { type: 'button', title: `Close ${spec.title}`, tabindex: -1 });
      x.append(svg(icons.close));
      x.addEventListener('click', () => this.setVisible(id as ToggleablePane, false));
      bar.append(x);
    }
    const body = h('div.pane-body');
    if (content) body.append(content);
    else body.append(h('div.pane-host'));
    el.append(bar, body);
    this.panes.set(id, { el, title, sub });
    return el;
  }

  private mountPanel(panel: Panel, host: HTMLElement): void {
    panel.mount(host);
    this.mounted.push(panel);
    if (panel.resize) {
      let lw = -1, lh = -1;
      const ro = new ResizeObserver(() => {
        const w = host.clientWidth, hh = host.clientHeight;
        if (w === lw && hh === lh) return;
        lw = w; lh = hh;
        if (w > 0 && hh > 0) panel.resize!(w, hh);
      });
      ro.observe(host);
      this.observers.push(ro);
    }
  }

  private setActive(p: PaneId): void {
    if (p === this.activePane && this.panes.get(p)!.el.classList.contains('active')) return;
    this.activePane = p;
    for (const [id, r] of this.panes) r.el.classList.toggle('active', id === p);
  }

  private maxWidth(which: 'left' | 'right'): number {
    const total = this.el.clientWidth - 12;
    const other = which === 'left'
      ? (this.rightVisible() ? this.state.sizes.right : 0)
      : (this.state.visible.left ? this.state.sizes.left : 0);
    return Math.max(which === 'left' ? MIN.left : MIN.right, total - other - MIN.centerW);
  }

  private rightVisible(): boolean { return this.state.visible.rightTop || this.state.visible.rightBottom; }

  private apply(): void {
    const v = this.state.visible;
    const s = this.state.sizes;
    const show = (el: HTMLElement, on: boolean) => { el.style.display = on ? '' : 'none'; };
    // Effective sizes: persisted sizes, squeezed so the centre and upper panes keep a usable minimum.
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const rv0 = v.rightTop || v.rightBottom;
    let right = s.right, left = s.left;
    if (W > 0) {
      const avail = W - 12 - MIN.centerW;
      if ((v.left ? left : 0) + (rv0 ? right : 0) > avail) {
        const scale = avail / ((v.left ? left : 0) + (rv0 ? right : 0));
        left = Math.max(MIN.left, Math.floor(left * scale));
        right = Math.max(MIN.right, Math.floor(right * scale));
      }
    }
    const bottomH = H > 0 ? Math.max(MIN.bottom, Math.min(s.bottom, H - 8 - MIN.centerH)) : s.bottom;
    const rbH = H > 0 ? Math.max(MIN.rightBottom, Math.min(s.rightBottom, H - 8 - MIN.rightTopH)) : s.rightBottom;
    show(this.leftEl, v.left);
    show(this.splitL, v.left);
    this.leftEl.style.width = `${left}px`;
    this.leftEl.style.flex = 'none';

    const bottom = this.panes.get('bottom')!.el;
    show(bottom, v.bottom);
    show(this.splitB, v.bottom);
    bottom.style.height = `${bottomH}px`;
    bottom.style.flex = 'none';

    const rv = this.rightVisible();
    show(this.rightCol, rv);
    show(this.splitR, rv);
    this.rightCol.style.width = `${right}px`;
    this.rightCol.style.flex = 'none';
    const rt = this.panes.get('rightTop')!.el;
    const rb = this.panes.get('rightBottom')!.el;
    show(rt, v.rightTop);
    show(rb, v.rightBottom);
    show(this.splitRB, v.rightTop && v.rightBottom);
    rt.style.flex = '1';
    if (v.rightTop) { rb.style.flex = 'none'; rb.style.height = `${rbH}px`; }
    else { rb.style.flex = '1'; rb.style.height = ''; }
  }

  private save(): void { storage.set(KEY, JSON.stringify(this.state)); }

  private wireSplitter(el: HTMLElement, axis: 'x' | 'y', get: () => number, set: (v: number) => void, sign: 1 | -1, bounds: () => [number, number]): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const start = axis === 'x' ? e.clientX : e.clientY;
      const v0 = get();
      const [lo, hi] = bounds();
      el.classList.add('dragging');
      document.body.classList.add(axis === 'x' ? 'resizing-col' : 'resizing-row');
      const move = (ev: PointerEvent) => {
        const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
        set(Math.round(clamp(v0 + sign * d, lo, hi)));
        this.apply();
      };
      const up = () => {
        el.classList.remove('dragging');
        document.body.classList.remove('resizing-col', 'resizing-row');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        this.save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => {
      const d = DEFAULT_LAYOUT.sizes;
      if (el === this.splitL) this.state.sizes.left = d.left;
      else if (el === this.splitR) this.state.sizes.right = d.right;
      else if (el === this.splitB) this.state.sizes.bottom = d.bottom;
      else this.state.sizes.rightBottom = d.rightBottom;
      this.apply();
      this.save();
    });
  }
}
