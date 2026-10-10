// Plant Builder plan view: HTML canvas at devicePixelRatio with CAD rulers, 1 m / 5 m grid,
// rotated footprints, flow arrows, selection handles, validation markers and the Select / Connect /
// Pan tools. Drags preview locally and commit one undoable step on release.
import type { AssetDef, AssetKind } from '../net/contracts';
import { h } from '../widgets/dom';
import { PopupMenu, type MenuEntry } from '../widgets/Menu';
import type { BuilderEditor, Edge } from './editor';
import {
  aabb, assetInRect, distToSegment, exitPoint, fitView, localToWorld, niceStep, normRect, pointInAsset,
  round3, screenToWorld, snap, unionRect, worldToLocal, worldToScreen, zoomAt, type Pt, type View,
} from './geometry';
import { KIND_SPECS } from './model';
import * as ops from './ops';

export const RULER = 18;
const SNAP = 0.5;
const SIZE_SNAP = 0.1;
const HANDLE = 7;

interface Theme {
  bg: string; minor: string; major: string; axis: string; text: string; dim: string; outline: string;
  ruler: string; rulerText: string; rulerLine: string; arrow: string; select: string; selectSoft: string;
  crit: string; warn: string; fills: Record<AssetKind, string>; lines: string[];
}

const LIGHT: Theme = {
  bg: '#ffffff', minor: '#ececec', major: '#cfcfcf', axis: '#9a9a9a', text: '#000000', dim: '#5a5a5a', outline: '#404040',
  ruler: '#d4d0c8', rulerText: '#000000', rulerLine: '#808080', arrow: '#404040', select: '#0f62fe', selectSoft: 'rgba(15,98,254,0.10)',
  crit: '#d0021b', warn: '#e8a317',
  fills: { source: '#ecdcbc', conveyor: '#dfe2e6', machine: '#cfe1f1', buffer: '#efe2c4', robot: '#f7e2b5', inspection: '#d9ecd0', sink: '#e4d8ee' },
  lines: ['#0072bd', '#d95319', '#77ac30', '#7e2f8e', '#edb120', '#4dbeee', '#a2142f'],
};
const DARK: Theme = {
  bg: '#1b1c1f', minor: '#25272b', major: '#363940', axis: '#5e636b', text: '#d4d4d4', dim: '#9a9a9a', outline: '#a8acb2',
  ruler: '#3c3f44', rulerText: '#d4d4d4', rulerLine: '#18191b', arrow: '#9da2a8', select: '#4589ff', selectSoft: 'rgba(69,137,255,0.14)',
  crit: '#ff3b4e', warn: '#e8a317',
  fills: { source: '#3d3527', conveyor: '#33363b', machine: '#25384a', buffer: '#3d3626', robot: '#45391f', inspection: '#2a3a26', sink: '#372d40' },
  lines: ['#4dbeee', '#d95319', '#77ac30', '#a066c8', '#edb120', '#0072bd', '#d2475d'],
};

type Drag =
  | { type: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { type: 'move'; start: Pt; anchor: string; orig: Map<string, Pt>; dx: number; dz: number; moved: boolean }
  | { type: 'resize'; id: string; hx: -1 | 0 | 1; hz: -1 | 0 | 1; orig: AssetDef; size: { x: number; z: number }; pos: Pt }
  | { type: 'marquee'; start: Pt; cur: Pt; mode: 'replace' | 'add' }
  | { type: 'connect'; from: string; cur: Pt; target: string | null };

export class BuilderCanvas {
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  view: View = { scale: 24, ox: 80, oy: 200 };
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private raf = 0;
  private drag: Drag | null = null;
  private hover: Pt | null = null;
  private hoverAsset: string | null = null;
  private hoverEdge: Edge | null = null;
  private space = false;
  private fitted = false;
  private readonly ro: ResizeObserver;
  private readonly off: (() => void)[] = [];
  /** Cursor position changes (status bar). */
  onCursor: ((p: Pt | null) => void) | null = null;
  onView: (() => void) | null = null;

  constructor(private readonly ed: BuilderEditor) {
    this.el = h('div.bld-canvas');
    this.canvas = h('canvas', { tabindex: 0, 'aria-label': 'Plant plan view. Arrows nudge, R rotates, Delete removes, Tab cycles assets.' });
    this.el.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', () => { this.drag = null; this.invalidate(); });
    c.addEventListener('pointerleave', () => { this.hover = null; this.onCursor?.(null); if (!this.drag) this.invalidate(); });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => {
      const id = this.hitAsset(this.toWorld(e));
      if (id) this.ed.emit('activate', id);
    });
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(e); });
    c.addEventListener('keydown', (e) => this.onKey(e));
    c.addEventListener('keyup', (e) => { if (e.key === ' ') { this.space = false; this.updateCursor(); } });
    c.addEventListener('blur', () => { this.space = false; });

    for (const k of ['change', 'selection', 'tool', 'issues'] as const) this.off.push(this.ed.on(k, () => this.invalidate()));
    this.off.push(this.ed.on('fit', () => { if (this.w) this.zoomToFit(); else this.fitted = false; }));
    this.off.push(this.ed.on('reveal', (id) => this.reveal(id)));
    const mo = new MutationObserver(() => this.invalidate());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.off.push(() => mo.disconnect());
  }

  dispose(): void {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    this.off.forEach((f) => f());
  }

  focus(): void { this.canvas.focus({ preventScroll: true }); }

  // ---------- view ----------

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(r.width));
    this.h = Math.max(1, Math.floor(r.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    if (!this.fitted) this.zoomToFit();
    this.render();
  }

  zoomToFit(): void {
    if (!this.w) return;
    this.fitted = true;
    const r = unionRect(this.ed.plant.assets.map(aabb));
    this.view = fitView(r, this.w, this.h, 36, RULER, RULER);
    this.viewChanged();
  }

  zoomBy(f: number): void {
    this.view = zoomAt(this.view, RULER + (this.w - RULER) / 2, RULER + (this.h - RULER) / 2, f);
    this.viewChanged();
  }

  zoom100(): void { this.zoomBy(40 / this.view.scale); }

  /** Centre the view on an asset (keeps zoom unless it is too far out). */
  reveal(id: string): void {
    const a = this.ed.asset(id);
    if (!a || !this.w) return;
    const s = worldToScreen(this.view, a.position.x, a.position.z);
    const margin = 60;
    if (s.sx > RULER + margin && s.sx < this.w - margin && s.sy > RULER + margin && s.sy < this.h - margin) { this.invalidate(); return; }
    const cx = RULER + (this.w - RULER) / 2, cy = RULER + (this.h - RULER) / 2;
    this.view = { ...this.view, ox: cx - a.position.x * this.view.scale, oy: cy - a.position.z * this.view.scale };
    this.viewChanged();
  }

  /** World point at the centre of the drawing area (keyboard "add"). */
  centre(): Pt {
    const p = screenToWorld(this.view, RULER + (this.w - RULER) / 2, RULER + (this.h - RULER) / 2);
    return { x: snap(p.x, SNAP), z: snap(p.z, SNAP) };
  }

  get zoomPct(): number { return Math.round((this.view.scale / 40) * 100); }

  private viewChanged(): void { this.invalidate(); this.onView?.(); }

  invalidate(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  // ---------- coordinates & hit testing ----------

  private local(e: { clientX: number; clientY: number }): { sx: number; sy: number } {
    const r = this.canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  private toWorld(e: { clientX: number; clientY: number }): Pt {
    const { sx, sy } = this.local(e);
    return screenToWorld(this.view, sx, sy);
  }

  /** Is a client point over the drawing area? (palette drops) */
  containsClient(x: number, y: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    return x >= r.left + RULER && x < r.right && y >= r.top + RULER && y < r.bottom;
  }

  snapPoint(p: Pt, free: boolean): Pt {
    return free || !this.ed.snapOn ? { x: round3(p.x), z: round3(p.z) } : { x: snap(p.x, SNAP), z: snap(p.z, SNAP) };
  }

  /** Asset drawn as this one, including drag previews. */
  private shown(a: AssetDef): AssetDef {
    const d = this.drag;
    if (d?.type === 'move' && d.orig.has(a.id)) {
      const o = d.orig.get(a.id)!;
      return { ...a, position: { ...a.position, x: o.x + d.dx, z: o.z + d.dz } };
    }
    if (d?.type === 'resize' && d.id === a.id) return { ...a, size: { ...a.size, x: d.size.x, z: d.size.z }, position: { ...a.position, x: d.pos.x, z: d.pos.z } };
    return a;
  }

  private hitAsset(p: Pt): string | null {
    const list = this.ed.plant.assets;
    const tol = 3 / this.view.scale;
    for (let i = list.length - 1; i >= 0; i--) if (pointInAsset(this.shown(list[i]), p.x, p.z, tol)) return list[i].id;
    return null;
  }

  private edgeSegment(from: AssetDef, to: AssetDef): [Pt, Pt] {
    const a = this.shown(from), b = this.shown(to);
    const p0 = exitPoint(a, b.position.x, b.position.z, 0.05);
    const p1 = exitPoint(b, a.position.x, a.position.z, 0.05);
    if (b.downstream.includes(a.id)) { // both directions: offset to the right of travel
      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      const L = Math.hypot(dx, dz) || 1;
      const o = 5 / this.view.scale;
      const nx = -dz / L * o, nz = dx / L * o;
      return [{ x: p0.x + nx, z: p0.z + nz }, { x: p1.x + nx, z: p1.z + nz }];
    }
    return [p0, p1];
  }

  private hitEdge(p: Pt): Edge | null {
    const byId = new Map(this.ed.plant.assets.map((a) => [a.id, a]));
    const tol = 5 / this.view.scale;
    let best: Edge | null = null;
    let bestD = tol;
    for (const a of this.ed.plant.assets) {
      for (const d of a.downstream) {
        const b = byId.get(d);
        if (!b) continue;
        const [p0, p1] = this.edgeSegment(a, b);
        const dist = distToSegment(p.x, p.z, p0.x, p0.z, p1.x, p1.z);
        if (dist < bestD) { bestD = dist; best = { from: a.id, to: d }; }
      }
    }
    return best;
  }

  private handles(a: AssetDef): { hx: -1 | 0 | 1; hz: -1 | 0 | 1; p: Pt }[] {
    const out: { hx: -1 | 0 | 1; hz: -1 | 0 | 1; p: Pt }[] = [];
    for (const hx of [-1, 0, 1] as const) for (const hz of [-1, 0, 1] as const) {
      if (!hx && !hz) continue;
      out.push({ hx, hz, p: localToWorld(a, (hx * a.size.x) / 2, (hz * a.size.z) / 2) });
    }
    return out;
  }

  private hitHandle(sx: number, sy: number): { hx: -1 | 0 | 1; hz: -1 | 0 | 1 } | null {
    if (this.ed.selection.length !== 1) return null;
    const a = this.ed.asset(this.ed.primary);
    if (!a) return null;
    for (const hd of this.handles(a)) {
      const s = worldToScreen(this.view, hd.p.x, hd.p.z);
      if (Math.abs(s.sx - sx) <= HANDLE / 2 + 2 && Math.abs(s.sy - sy) <= HANDLE / 2 + 2) return hd;
    }
    return null;
  }

  // ---------- pointer ----------

  private onDown(e: PointerEvent): void {
    this.focus();
    const { sx, sy } = this.local(e);
    const p = screenToWorld(this.view, sx, sy);
    if (e.button === 1 || (e.button === 0 && (this.space || this.ed.tool === 'pan'))) {
      e.preventDefault();
      this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.ox, oy: this.view.oy };
      this.canvas.setPointerCapture(e.pointerId);
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    if (sx < RULER || sy < RULER) return;

    if (this.ed.placeKind) {
      const q = this.snapPoint(p, e.altKey);
      const kind = this.ed.placeKind;
      this.ed.arm(null);
      this.ed.add(kind, q.x, q.z);
      return;
    }

    const hitA = this.hitAsset(p);
    if (this.ed.tool === 'connect') {
      if (hitA) {
        this.drag = { type: 'connect', from: hitA, cur: p, target: null };
        this.canvas.setPointerCapture(e.pointerId);
      } else {
        const edge = this.hitEdge(p);
        if (edge) this.ed.disconnect(edge);
      }
      this.invalidate();
      return;
    }

    const hd = this.hitHandle(sx, sy);
    if (hd) {
      const a = this.ed.asset(this.ed.primary)!;
      this.drag = { type: 'resize', id: a.id, hx: hd.hx, hz: hd.hz, orig: JSON.parse(JSON.stringify(a)) as AssetDef, size: { x: a.size.x, z: a.size.z }, pos: { x: a.position.x, z: a.position.z } };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (hitA) {
      const multi = e.shiftKey || e.ctrlKey || e.metaKey;
      if (multi) this.ed.select([hitA], 'toggle');
      else if (!this.ed.selection.includes(hitA)) this.ed.select([hitA]);
      else this.ed.select([...this.ed.selection.filter((x) => x !== hitA), hitA]); // make primary
      if (!this.ed.selection.includes(hitA)) return;
      const orig = new Map<string, Pt>();
      for (const id of this.ed.selection) {
        const a = this.ed.asset(id);
        if (a) orig.set(id, { x: a.position.x, z: a.position.z });
      }
      this.drag = { type: 'move', start: p, anchor: hitA, orig, dx: 0, dz: 0, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const edge = this.hitEdge(p);
    if (edge) { this.ed.selectEdge(edge); return; }
    this.drag = { type: 'marquee', start: p, cur: p, mode: e.shiftKey || e.ctrlKey ? 'add' : 'replace' };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    const { sx, sy } = this.local(e);
    const p = screenToWorld(this.view, sx, sy);
    this.hover = p;
    this.onCursor?.(p);
    const d = this.drag;
    if (!d) {
      const ha = this.hitAsset(p);
      const he = ha ? null : this.hitEdge(p);
      const changed = ha !== this.hoverAsset || (he?.from !== this.hoverEdge?.from || he?.to !== this.hoverEdge?.to);
      this.hoverAsset = ha;
      this.hoverEdge = he;
      this.updateCursor(sx, sy);
      if (changed || this.ed.placeKind) this.invalidate();
      else this.drawRulersOnly();
      return;
    }
    switch (d.type) {
      case 'pan':
        this.view = { ...this.view, ox: d.ox + e.clientX - d.sx, oy: d.oy + e.clientY - d.sy };
        this.viewChanged();
        return;
      case 'move': {
        const o = d.orig.get(d.anchor)!;
        const raw = { x: o.x + p.x - d.start.x, z: o.z + p.z - d.start.z };
        const q = this.snapPoint(raw, e.altKey);
        d.dx = round3(q.x - o.x);
        d.dz = round3(q.z - o.z);
        if (Math.hypot(p.x - d.start.x, p.z - d.start.z) * this.view.scale > 3) d.moved = true;
        break;
      }
      case 'resize': {
        const a = d.orig;
        const l = worldToLocal(a, p.x, p.z);
        const step = e.altKey || !this.ed.snapOn ? 0 : SIZE_SNAP;
        const ext = (half: number, sgn: -1 | 0 | 1, lv: number) => {
          if (!sgn) return { size: half * 2, c: 0 };
          const fixed = -sgn * half;
          let size = Math.max(0.2, sgn * (lv - fixed));
          if (step) size = Math.max(0.2, snap(size, step));
          return { size: round3(size), c: fixed + (sgn * size) / 2 };
        };
        const ex = ext(a.size.x / 2, d.hx, l.x), ez = ext(a.size.z / 2, d.hz, l.z);
        d.size = { x: ex.size, z: ez.size };
        const c = localToWorld(a, ex.c, ez.c);
        d.pos = { x: round3(c.x), z: round3(c.z) };
        this.ed.status(`Size ${d.size.x} × ${d.size.z} m`);
        break;
      }
      case 'marquee': d.cur = p; break;
      case 'connect': {
        d.cur = p;
        const t = this.hitAsset(p);
        d.target = t && t !== d.from ? t : null;
        break;
      }
    }
    this.invalidate();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    switch (d.type) {
      case 'move':
        if (d.moved && (d.dx || d.dz)) this.ed.move(d.dx, d.dz);
        break;
      case 'resize': {
        const a = d.orig;
        if (d.size.x !== a.size.x || d.size.z !== a.size.z) {
          this.ed.edit(`Resize ${d.id}`, (pl) => ops.resizeAsset(pl, d.id, { x: d.size.x, z: d.size.z }, d.pos));
        }
        break;
      }
      case 'marquee': {
        const r = normRect(d.start.x, d.start.z, d.cur.x, d.cur.z);
        const tiny = (r.x1 - r.x0) * this.view.scale < 3 && (r.z1 - r.z0) * this.view.scale < 3;
        const ids = tiny ? [] : this.ed.plant.assets.filter((a) => assetInRect(a, r)).map((a) => a.id);
        if (d.mode === 'add') this.ed.select(ids, 'add'); else this.ed.select(ids);
        break;
      }
      case 'connect':
        if (d.target) this.ed.connect(d.from, d.target);
        break;
      case 'pan': break;
    }
    this.updateCursor();
    this.invalidate();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { sx, sy } = this.local(e);
    const f = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 33 : 1));
    this.view = zoomAt(this.view, sx, sy, f);
    this.viewChanged();
  }

  private updateCursor(sx?: number, sy?: number): void {
    let c = 'default';
    if (this.drag?.type === 'pan') c = 'grabbing';
    else if (this.space || this.ed.tool === 'pan') c = 'grab';
    else if (this.ed.placeKind) c = 'copy';
    else if (this.ed.tool === 'connect') c = this.hoverAsset ? 'crosshair' : this.hoverEdge ? 'pointer' : 'default';
    else if (sx !== undefined && sy !== undefined && this.hitHandle(sx, sy)) {
      const hd = this.hitHandle(sx, sy)!;
      const a = this.ed.asset(this.ed.primary)!;
      const rot = ((Math.round((a.rotationY || 0) / 90) % 2) + 2) % 2 === 1;
      const hx = rot ? hd.hz : hd.hx, hz = rot ? hd.hx : hd.hz;
      c = !hx ? 'ns-resize' : !hz ? 'ew-resize' : hx * hz > 0 ? 'nwse-resize' : 'nesw-resize';
    } else if (this.hoverAsset) c = 'move';
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  // ---------- keyboard ----------

  private onKey(e: KeyboardEvent): void {
    const ed = this.ed;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    let handled = true;
    if (k === ' ') { if (!this.space) { this.space = true; this.updateCursor(); } }
    else if (k === 'Delete' || k === 'Backspace') ed.deleteSelection();
    else if (k === 'Escape') {
      if (this.drag) { this.drag = null; this.invalidate(); }
      else if (ed.placeKind) ed.arm(null);
      else if (ed.tool !== 'select') ed.setTool('select');
      else ed.select([]);
    }
    else if (ctrl && k.toLowerCase() === 'a') ed.selectAll();
    else if (ctrl && k.toLowerCase() === 'c') ed.copy();
    else if (ctrl && k.toLowerCase() === 'x') ed.cut();
    else if (ctrl && k.toLowerCase() === 'v') ed.paste();
    else if (ctrl && k.toLowerCase() === 'd') ed.duplicate();
    else if (ctrl && k.toLowerCase() === 'l') ed.chainSelection();
    else if (ctrl && k === '0') this.zoomToFit();
    else if (!ctrl && !e.altKey && (k === 'r' || k === 'R')) ed.rotate(e.shiftKey ? -90 : 90);
    else if (k.startsWith('Arrow')) {
      const step = e.shiftKey ? 1 : e.altKey ? 0.1 : SNAP;
      const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
      const dz = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
      if (ed.selection.length) ed.move(dx, dz, 'Nudge', 'nudge');
      else { this.view = { ...this.view, ox: this.view.ox - dx * 40, oy: this.view.oy - dz * 40 }; this.viewChanged(); }
    }
    else if (k === 'Tab') ed.cycle(e.shiftKey ? -1 : 1);
    else if (k === 'Enter' && ed.primary) ed.emit('activate', ed.primary);
    else if (!ctrl && (k === '+' || k === '=')) this.zoomBy(1.25);
    else if (!ctrl && (k === '-' || k === '_')) this.zoomBy(0.8);
    else if (!ctrl && k === 'Home') this.zoomToFit();
    else if (!ctrl && !e.altKey && k.toLowerCase() === 'v') ed.setTool('select');
    else if (!ctrl && !e.altKey && k.toLowerCase() === 'c') ed.setTool('connect');
    else if (!ctrl && !e.altKey && k.toLowerCase() === 'h') ed.setTool('pan');
    else if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      const a = ed.asset(ed.primary);
      const s = a ? worldToScreen(this.view, a.position.x, a.position.z) : { sx: this.w / 2, sy: this.h / 2 };
      const r = this.canvas.getBoundingClientRect();
      this.contextMenu({ clientX: r.left + s.sx, clientY: r.top + s.sy });
    }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  private contextMenu(e: { clientX: number; clientY: number }): void {
    const ed = this.ed;
    const p = this.toWorld(e);
    const hit = this.hitAsset(p);
    if (hit && !ed.selection.includes(hit)) ed.select([hit]);
    const edge = hit ? null : this.hitEdge(p);
    if (edge) ed.selectEdge(edge);
    const has = ed.selection.length > 0;
    const items: MenuEntry[] = edge
      ? [{ label: `&Remove flow ${edge.from} → ${edge.to}`, accel: 'Del', action: () => ed.disconnect(edge) }]
      : [
        { label: 'Cu&t', accel: 'Ctrl+X', disabled: !has, action: () => ed.cut() },
        { label: '&Copy', accel: 'Ctrl+C', disabled: !has, action: () => ed.copy() },
        { label: '&Paste', accel: 'Ctrl+V', disabled: !ed.canPaste, action: () => ed.paste() },
        { label: '&Delete', accel: 'Del', disabled: !has, action: () => ed.deleteSelection() },
        'sep',
        { label: 'Rotate &Right 90°', accel: 'R', disabled: !has, action: () => ed.rotate(90) },
        { label: 'Rotate &Left 90°', accel: 'Shift+R', disabled: !has, action: () => ed.rotate(-90) },
        'sep',
        { label: 'Co&nnect in Order', accel: 'Ctrl+L', disabled: ed.selection.length < 2, action: () => ed.chainSelection() },
        { label: 'Disconnect &All', disabled: !has, action: () => { const ids = [...ed.selection]; ed.edit('Disconnect all', (pl) => ops.disconnectAll(pl, ids)); } },
        'sep',
        { label: '&Properties', accel: 'Enter', disabled: !has, action: () => ed.primary && ed.emit('activate', ed.primary) },
        { label: 'Zoom to &Fit', accel: 'Ctrl+0', action: () => this.zoomToFit() },
      ];
    new PopupMenu(items, e.clientX, e.clientY);
  }

  // ---------- rendering ----------

  private theme(): Theme { return document.documentElement.dataset.theme === 'dark' ? DARK : LIGHT; }

  private begin(): CanvasRenderingContext2D {
    const dpr = window.devicePixelRatio || 1;
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  render(): void {
    if (!this.w) return;
    const g = this.begin();
    const T = this.theme();
    const v = this.view;
    g.fillStyle = T.bg;
    g.fillRect(0, 0, this.w, this.h);
    g.save();
    g.beginPath();
    g.rect(RULER, RULER, this.w - RULER, this.h - RULER);
    g.clip();
    if (this.ed.gridOn) this.drawGrid(g, T);

    const plant = this.ed.plant;
    const byId = new Map(plant.assets.map((a) => [a.id, a]));
    const lineIdx = new Map((plant.lines ?? []).map((l, i) => [l.id, i]));
    const sel = new Set(this.ed.selection);

    for (const a of plant.assets) this.drawAsset(g, T, this.shown(a), sel.has(a.id), lineIdx);

    // flows on top of footprints
    for (const a of plant.assets) {
      for (const d of a.downstream) {
        const b = byId.get(d);
        if (!b) continue;
        const e = this.ed.edge;
        const on = !!e && e.from === a.id && e.to === d;
        const hot = !on && !!this.hoverEdge && this.hoverEdge.from === a.id && this.hoverEdge.to === d;
        const [p0, p1] = this.edgeSegment(a, b);
        this.drawArrow(g, p0, p1, on ? T.select : hot ? T.select : T.arrow, on ? 2.5 : hot ? 2 : 1.4, hot && this.ed.tool === 'connect');
      }
    }

    for (const a of plant.assets) {
      const s = this.ed.issueMap.get(a.id);
      if (s) this.drawMarker(g, T, this.shown(a), s);
    }

    for (const id of this.ed.selection) {
      const a = byId.get(id);
      if (a) this.drawSelection(g, T, this.shown(a), id === this.ed.primary && this.ed.selection.length === 1);
    }

    const d = this.drag;
    if (d?.type === 'marquee') {
      const a = worldToScreen(v, d.start.x, d.start.z), b = worldToScreen(v, d.cur.x, d.cur.z);
      g.fillStyle = T.selectSoft;
      g.strokeStyle = T.select;
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      const x = Math.min(a.sx, b.sx), y = Math.min(a.sy, b.sy);
      g.fillRect(x, y, Math.abs(a.sx - b.sx), Math.abs(a.sy - b.sy));
      g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(Math.abs(a.sx - b.sx)), Math.round(Math.abs(a.sy - b.sy)));
      g.setLineDash([]);
    }
    if (d?.type === 'connect') {
      const from = byId.get(d.from)!;
      const tgt = d.target ? byId.get(d.target) : undefined;
      if (tgt) this.drawOutline(g, tgt, T.select, 2.5);
      const end = tgt ? exitPoint(tgt, from.position.x, from.position.z, 0.05) : d.cur;
      const start = exitPoint(from, end.x, end.z, 0.05);
      const bad = tgt ? ops.canConnect(plant, from.id, tgt.id) : null;
      this.drawArrow(g, start, end, bad ? T.crit : T.select, 2, true);
      if (bad && tgt) this.ed.status(bad, 'error');
    }
    if (this.ed.placeKind && this.hover) {
      const spec = KIND_SPECS[this.ed.placeKind];
      const q = this.snapPoint(this.hover, false);
      const ghost: AssetDef = { id: '', name: '', kind: spec.kind, position: { x: q.x, y: 0, z: q.z }, rotationY: 0, size: spec.size, downstream: [], params: {} };
      g.globalAlpha = 0.55;
      this.drawAsset(g, T, ghost, false, lineIdx);
      g.globalAlpha = 1;
      g.setLineDash([4, 3]);
      this.drawOutline(g, ghost, T.select, 1);
      g.setLineDash([]);
    }
    g.restore();
    this.drawRulers(g, T);
  }

  private drawRulersOnly(): void {
    if (!this.w) return;
    this.drawRulers(this.begin(), this.theme());
  }

  private drawGrid(g: CanvasRenderingContext2D, T: Theme): void {
    const v = this.view;
    const tl = screenToWorld(v, RULER, RULER), br = screenToWorld(v, this.w, this.h);
    const lines = (step: number, color: string) => {
      g.beginPath();
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = Math.round(x * v.scale + v.ox) + 0.5;
        g.moveTo(sx, RULER); g.lineTo(sx, this.h);
      }
      for (let z = Math.floor(tl.z / step) * step; z <= br.z; z += step) {
        const sy = Math.round(z * v.scale + v.oy) + 0.5;
        g.moveTo(RULER, sy); g.lineTo(this.w, sy);
      }
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.stroke();
    };
    if (v.scale >= 6) lines(1, T.minor);
    lines(v.scale >= 2 ? 5 : 25, T.major);
    // origin axes
    const o = worldToScreen(v, 0, 0);
    g.beginPath();
    g.moveTo(Math.round(o.sx) + 0.5, RULER); g.lineTo(Math.round(o.sx) + 0.5, this.h);
    g.moveTo(RULER, Math.round(o.sy) + 0.5); g.lineTo(this.w, Math.round(o.sy) + 0.5);
    g.strokeStyle = T.axis;
    g.setLineDash([6, 3, 1, 3]);
    g.stroke();
    g.setLineDash([]);
  }

  private path(g: CanvasRenderingContext2D, a: AssetDef): void {
    const v = this.view;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => localToWorld(a, (x * a.size.x) / 2, (z * a.size.z) / 2));
    g.beginPath();
    pts.forEach((p, i) => {
      const s = worldToScreen(v, p.x, p.z);
      const x = Math.round(s.sx) + 0.5, y = Math.round(s.sy) + 0.5;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.closePath();
  }

  private drawOutline(g: CanvasRenderingContext2D, a: AssetDef, color: string, width: number): void {
    this.path(g, a);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  }

  /** Transform the context into the asset's local frame, in screen pixels (1 unit = 1 px). */
  private withLocal(g: CanvasRenderingContext2D, a: AssetDef, fn: (hw: number, hh: number) => void): void {
    const s = worldToScreen(this.view, a.position.x, a.position.z);
    g.save();
    g.translate(s.sx, s.sy);
    // rotationY is CCW seen from above (+X → -Z), i.e. CCW on screen
    g.rotate(-((a.rotationY || 0) * Math.PI) / 180);
    fn((a.size.x * this.view.scale) / 2, (a.size.z * this.view.scale) / 2);
    g.restore();
  }

  private drawAsset(g: CanvasRenderingContext2D, T: Theme, a: AssetDef, selected: boolean, lineIdx: Map<string, number>): void {
    this.path(g, a);
    g.fillStyle = T.fills[a.kind] ?? T.fills.machine;
    g.fill();
    // footprint details in the local frame
    this.withLocal(g, a, (hw, hh) => {
      g.strokeStyle = T.outline;
      g.globalAlpha *= 0.45;
      g.lineWidth = 1;
      const sc = this.view.scale;
      if (a.kind === 'conveyor') {
        const pitch = 0.5 * sc;
        if (pitch >= 4) {
          g.beginPath();
          for (let x = -hw + pitch / 2; x < hw; x += pitch) { g.moveTo(x, -hh + 2); g.lineTo(x, hh - 2); }
          g.stroke();
        }
        g.strokeRect(-hw, -hh + Math.min(3, hh / 4), hw * 2, hh * 2 - Math.min(6, hh / 2));
      } else if (a.kind === 'buffer') {
        g.beginPath();
        for (let i = 1; i < 3; i++) { const y = -hh + (hh * 2 * i) / 3; g.moveTo(-hw + 3, y); g.lineTo(hw - 3, y); }
        g.stroke();
      } else if (a.kind === 'machine' || a.kind === 'inspection') {
        const m = Math.min(hw, hh) * 0.22;
        g.strokeRect(-hw + m, -hh + m, hw * 2 - 2 * m, hh * 2 - 2 * m);
      } else if (a.kind === 'robot') {
        g.beginPath();
        g.arc(0, 0, Math.min(hw, hh) * 0.8, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha /= 0.45;
      // outlet marker: small triangle on the +X edge shows flow orientation
      if (hw > 8 && hh > 5 && a.kind !== 'sink') {
        const t = Math.min(6, hh * 0.6);
        g.beginPath();
        g.moveTo(hw - 2, 0); g.lineTo(hw - 2 - t, -t * 0.7); g.lineTo(hw - 2 - t, t * 0.7);
        g.closePath();
        g.fillStyle = T.outline;
        g.globalAlpha *= 0.7;
        g.fill();
        g.globalAlpha /= 0.7;
      }
      // line colour band along the -Z (back) edge
      if (a.lineId !== undefined && lineIdx.has(a.lineId)) {
        g.fillStyle = T.lines[lineIdx.get(a.lineId)! % T.lines.length];
        g.fillRect(-hw, -hh, hw * 2, Math.max(2, Math.min(4, hh * 0.25)));
      }
    });
    this.path(g, a);
    g.strokeStyle = selected ? T.select : (a.id && a.id === this.hoverAsset ? T.select : T.outline);
    g.lineWidth = selected ? 1.5 : 1;
    g.stroke();
    if (!a.id) return;
    this.drawGlyph(g, T, a);
  }

  private drawGlyph(g: CanvasRenderingContext2D, T: Theme, a: AssetDef): void {
    const v = this.view;
    const s = worldToScreen(v, a.position.x, a.position.z);
    const r = aabb(a);
    const wpx = (r.x1 - r.x0) * v.scale, hpx = (r.z1 - r.z0) * v.scale;
    g.font = `bold 11px Tahoma, "Segoe UI", sans-serif`;
    const inside = hpx >= 30 && g.measureText(a.id).width <= wpx - 8;
    const gs = Math.min(14, Math.max(8, Math.min(wpx, hpx) * 0.32));
    const gy = inside ? s.sy - 7 : s.sy;
    if (Math.min(wpx, hpx) >= 12) this.glyph(g, T, a.kind, s.sx, gy, gs);
    g.font = `bold 11px Tahoma, "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const label = a.id;
    if (inside) {
      g.fillStyle = T.text;
      g.fillText(label, s.sx, s.sy + gs / 2 + 2);
      if (v.scale >= 40 && hpx >= 56) {
        g.font = '10px Tahoma, "Segoe UI", sans-serif';
        g.fillStyle = T.dim;
        g.fillText(fitText(g, a.name, wpx - 8), s.sx, s.sy + gs / 2 + 15);
      }
    } else if (v.scale >= 6) {
      const y = worldToScreen(v, 0, r.z1).sy + 8;
      const tw = g.measureText(label).width;
      g.fillStyle = T.bg;
      g.globalAlpha *= 0.8;
      g.fillRect(s.sx - tw / 2 - 2, y - 7, tw + 4, 13);
      g.globalAlpha /= 0.8;
      g.fillStyle = T.text;
      g.fillText(label, s.sx, y);
    }
  }

  /** Small upright kind glyph centred at (x, y) with half-size r. */
  private glyph(g: CanvasRenderingContext2D, T: Theme, kind: AssetKind, x: number, y: number, size: number): void {
    const r = size / 2;
    g.save();
    g.translate(Math.round(x), Math.round(y));
    g.lineWidth = 1.2;
    g.strokeStyle = T.outline;
    g.fillStyle = T.outline;
    switch (kind) {
      case 'source':
        g.beginPath(); g.moveTo(-r, 0); g.lineTo(r * 0.2, 0); g.stroke();
        g.beginPath(); g.moveTo(r * 0.5, 0); g.lineTo(-r * 0.1, -r * 0.6); g.lineTo(-r * 0.1, r * 0.6); g.closePath(); g.fill();
        g.strokeRect(r * 0.35, -r * 0.75, r * 0.65, r * 1.5);
        break;
      case 'conveyor':
        g.strokeRect(-r, -r * 0.4, r * 2, r * 0.8);
        for (const cx of [-r * 0.55, 0, r * 0.55]) { g.beginPath(); g.arc(cx, 0, r * 0.17, 0, Math.PI * 2); g.fill(); }
        break;
      case 'machine':
        g.strokeRect(-r, -r * 0.8, r * 2, r * 1.6);
        g.fillStyle = '#4dbeee'; g.fillRect(-r * 0.7, -r * 0.5, r * 0.9, r * 0.8); g.strokeRect(-r * 0.7, -r * 0.5, r * 0.9, r * 0.8);
        g.fillStyle = '#d0021b'; g.fillRect(r * 0.45, -r * 0.5, r * 0.3, r * 0.2);
        g.fillStyle = '#76b900'; g.fillRect(r * 0.45, -r * 0.15, r * 0.3, r * 0.2);
        break;
      case 'buffer':
        for (const yy of [-r * 0.75, -r * 0.1, r * 0.55]) g.strokeRect(-r * 0.9, yy, r * 1.8, r * 0.45);
        break;
      case 'robot':
        g.beginPath(); g.arc(-r * 0.4, r * 0.5, r * 0.3, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#e8a317'; g.lineWidth = Math.max(1.5, r * 0.3);
        g.beginPath(); g.moveTo(-r * 0.4, r * 0.5); g.lineTo(r * 0.1, -r * 0.5); g.lineTo(r * 0.85, -r * 0.1); g.stroke();
        break;
      case 'inspection':
        g.lineWidth = 1.4;
        g.beginPath(); g.arc(-r * 0.2, -r * 0.2, r * 0.6, 0, Math.PI * 2); g.stroke();
        g.lineWidth = Math.max(1.6, r * 0.28);
        g.beginPath(); g.moveTo(r * 0.25, r * 0.25); g.lineTo(r * 0.9, r * 0.9); g.stroke();
        break;
      case 'sink':
        g.beginPath(); g.moveTo(-r, -r * 0.2); g.lineTo(0, -r * 0.85); g.lineTo(r, -r * 0.2); g.lineTo(r, r * 0.8); g.lineTo(-r, r * 0.8); g.closePath(); g.stroke();
        g.strokeRect(-r * 0.45, r * 0.1, r * 0.9, r * 0.7);
        break;
    }
    g.restore();
  }

  private drawArrow(g: CanvasRenderingContext2D, p0: Pt, p1: Pt, color: string, width: number, dashed = false): void {
    const a = worldToScreen(this.view, p0.x, p0.z), b = worldToScreen(this.view, p1.x, p1.z);
    const dx = b.sx - a.sx, dy = b.sy - a.sy;
    const L = Math.hypot(dx, dy);
    if (L < 2) return;
    const ux = dx / L, uy = dy / L;
    const head = Math.min(9, Math.max(6, L * 0.3));
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = width;
    if (dashed) g.setLineDash([5, 3]);
    g.beginPath();
    g.moveTo(a.sx, a.sy);
    g.lineTo(b.sx - ux * head * 0.8, b.sy - uy * head * 0.8);
    g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(b.sx, b.sy);
    g.lineTo(b.sx - ux * head - uy * head * 0.45, b.sy - uy * head + ux * head * 0.45);
    g.lineTo(b.sx - ux * head + uy * head * 0.45, b.sy - uy * head - ux * head * 0.45);
    g.closePath();
    g.fill();
  }

  private drawSelection(g: CanvasRenderingContext2D, T: Theme, a: AssetDef, withHandles: boolean): void {
    g.setLineDash([3, 2]);
    this.drawOutline(g, a, T.select, 1);
    g.setLineDash([]);
    const color = withHandles ? T.select : T.bg;
    for (const hd of this.handles(a)) {
      if (!withHandles && (hd.hx === 0 || hd.hz === 0)) continue;
      const s = worldToScreen(this.view, hd.p.x, hd.p.z);
      const x = Math.round(s.sx - HANDLE / 2) + 0.5, y = Math.round(s.sy - HANDLE / 2) + 0.5;
      g.fillStyle = color;
      g.fillRect(x, y, HANDLE - 1, HANDLE - 1);
      g.strokeStyle = withHandles ? '#ffffff' : T.select;
      g.lineWidth = 1;
      g.strokeRect(x, y, HANDLE - 1, HANDLE - 1);
      if (withHandles) { g.strokeStyle = T.select; g.strokeRect(x - 1, y - 1, HANDLE + 1, HANDLE + 1); }
    }
  }

  private drawMarker(g: CanvasRenderingContext2D, T: Theme, a: AssetDef, sev: 'critical' | 'warning'): void {
    const r = aabb(a);
    const s = worldToScreen(this.view, r.x1, r.z0);
    const x = Math.round(s.sx), y = Math.round(s.sy);
    g.save();
    g.lineWidth = 1;
    if (sev === 'critical') {
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2);
      g.fillStyle = T.crit; g.fill();
      g.strokeStyle = '#5a000a'; g.stroke();
      g.fillStyle = '#ffffff';
    } else {
      g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 8, y + 6); g.lineTo(x - 8, y + 6); g.closePath();
      g.fillStyle = T.warn; g.fill();
      g.strokeStyle = '#6b4700'; g.stroke();
      g.fillStyle = '#000000';
    }
    g.fillRect(x - 1, y - (sev === 'critical' ? 4 : 3), 2, sev === 'critical' ? 5 : 5);
    g.fillRect(x - 1, y + (sev === 'critical' ? 2 : 3), 2, 2);
    g.restore();
  }

  private drawRulers(g: CanvasRenderingContext2D, T: Theme): void {
    const v = this.view;
    g.fillStyle = T.ruler;
    g.fillRect(0, 0, this.w, RULER);
    g.fillRect(0, 0, RULER, this.h);
    g.strokeStyle = T.rulerLine;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(RULER, RULER - 0.5); g.lineTo(this.w, RULER - 0.5);
    g.moveTo(RULER - 0.5, RULER); g.lineTo(RULER - 0.5, this.h);
    g.stroke();
    const major = niceStep(v.scale, 60);
    const minor = major / (major * v.scale >= 100 ? 10 : 5);
    g.font = '10px Tahoma, "Segoe UI", sans-serif';
    g.fillStyle = T.rulerText;
    g.strokeStyle = T.rulerText;
    const tl = screenToWorld(v, RULER, RULER), br = screenToWorld(v, this.w, this.h);
    const fmt = (n: number) => String(+n.toFixed(3));
    g.beginPath();
    g.textBaseline = 'top';
    g.textAlign = 'left';
    for (let i = Math.floor(tl.x / minor); i * minor <= br.x; i++) {
      const x = i * minor;
      const sx = Math.round(x * v.scale + v.ox) + 0.5;
      if (sx < RULER) continue;
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      const len = isMajor ? 8 : Math.abs(x / (major / 2) - Math.round(x / (major / 2))) < 1e-6 ? 5 : 3;
      g.moveTo(sx, RULER - len); g.lineTo(sx, RULER);
      if (isMajor) g.fillText(fmt(x), sx + 2, 1);
    }
    for (let i = Math.floor(tl.z / minor); i * minor <= br.z; i++) {
      const z = i * minor;
      const sy = Math.round(z * v.scale + v.oy) + 0.5;
      if (sy < RULER) continue;
      const isMajor = Math.abs(z / major - Math.round(z / major)) < 1e-6;
      const len = isMajor ? 8 : Math.abs(z / (major / 2) - Math.round(z / (major / 2))) < 1e-6 ? 5 : 3;
      g.moveTo(RULER - len, sy); g.lineTo(RULER, sy);
      if (isMajor) {
        g.save();
        g.translate(1, sy + 2);
        g.rotate(Math.PI / 2);
        g.fillText(fmt(z), 0, -9);
        g.restore();
      }
    }
    g.stroke();
    // cursor tracking marks
    if (this.hover) {
      const s = worldToScreen(v, this.hover.x, this.hover.z);
      g.strokeStyle = T.select;
      g.beginPath();
      if (s.sx >= RULER) { g.moveTo(Math.round(s.sx) + 0.5, 0); g.lineTo(Math.round(s.sx) + 0.5, RULER); }
      if (s.sy >= RULER) { g.moveTo(0, Math.round(s.sy) + 0.5); g.lineTo(RULER, Math.round(s.sy) + 0.5); }
      g.stroke();
    }
    // corner
    g.fillStyle = T.ruler;
    g.fillRect(0, 0, RULER, RULER);
    g.fillStyle = T.rulerText;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('m', RULER / 2, RULER / 2);
    g.strokeStyle = T.rulerLine;
    g.strokeRect(-0.5, -0.5, RULER, RULER);
  }
}

function fitText(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}
