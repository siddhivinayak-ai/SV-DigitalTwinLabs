import type { SensorDef } from '../net/contracts';
import type { Panel, PanelContext, PanelFactory } from './panel';
import type { TwinStore } from '../state/store';
import { TrendPlot } from '../charts/TrendPlot';
import {
  alignSeries, fmtSimTime, fmtValue, layoutSubplots, sliceWindow, windowRange, windowSeconds, WINDOWS,
  type SubplotSpec, type WindowKey,
} from '../charts/series';
import { readPlotPalette } from '../charts/theme';
import '../charts/panels.css';

/**
 * Sensors to plot when an asset is selected: everything except cumulative counters, unless the
 * asset only has counters (sink, inspection rejects).
 */
export function pickAutoSensors(sensors: readonly SensorDef[], assetId: string): string[] {
  const mine = sensors.filter((s) => s.assetId === assetId);
  const live = mine.filter((s) => s.kind !== 'count');
  return (live.length ? live : mine).map((s) => s.id);
}

/** Group sensor definitions by asset, preserving plant order. */
export function groupByAsset(sensors: readonly SensorDef[]): Map<string, SensorDef[]> {
  const m = new Map<string, SensorDef[]>();
  for (const s of sensors) {
    let g = m.get(s.assetId);
    if (!g) m.set(s.assetId, (g = []));
    g.push(s);
  }
  return m;
}

const X_LABEL_H = 34; // extra height of the bottom subplot (x tick labels + x label)

interface Row { def: SensorDef; row: HTMLLabelElement; box: HTMLInputElement; sw: HTMLElement; val: HTMLElement; lastTxt: string }
interface Group { assetId: string; el: HTMLDivElement; box: HTMLInputElement; tw: HTMLElement; rows: Row[]; collapsed: boolean }

class TrendsPanel implements Panel {
  readonly id = 'trends';
  readonly title = 'Trends';
  private readonly store: TwinStore;
  private root!: HTMLDivElement;
  private list!: HTMLDivElement;
  private plotsEl!: HTMLDivElement;
  private empty!: HTMLDivElement;
  private status!: HTMLSpanElement;
  private readonly btns = new Map<string, HTMLButtonElement>();
  private groups: Group[] = [];
  private rows = new Map<string, Row>();
  private checked = new Set<string>();
  private plots: TrendPlot[] = [];
  private specs: SubplotSpec[] = [];
  private windowKey: WindowKey = '5m';
  private follow = true;
  private zoom: [number, number] | null = null;
  private pinned = false;
  private readonly unsubs: (() => void)[] = [];
  private ro: ResizeObserver | null = null;
  private readonly syncKey = `trends-${Math.random().toString(36).slice(2, 8)}`;

  constructor(ctx: PanelContext) {
    this.store = ctx.store;
  }

  mount(host: HTMLElement): void {
    this.root = el('div', 'tr');
    const tb = el('div', 'cx-tb');
    tb.append(el('span', 'cx-tb-label', 'Window:'));
    for (const w of WINDOWS) tb.append(this.button(`w-${w.key}`, w.label, `Rolling window: ${w.label === 'All' ? 'all history' : `last ${w.label}`}`, () => this.setWindow(w.key)));
    tb.append(el('span', 'cx-sep'));
    tb.append(this.button('follow', '', 'Pause / resume following the live edge', () => this.setFollow(!this.follow)));
    tb.append(this.button('pin', '', 'Pin the plotted sensors (ignore selection changes)', () => { this.pinned = !this.pinned; this.syncToolbar(); }));
    tb.append(el('span', 'cx-sep'));
    tb.append(this.button('png', '', 'Export the figure as PNG', () => this.exportPng()));
    this.status = el('span', 'cx-status');
    tb.append(this.status);

    const body = el('div', 'tr-body');
    this.list = el('div', 'tr-list cx-sunken');
    this.plotsEl = el('div', 'tr-plots cx-sunken');
    this.empty = el('div', 'tr-empty', 'Select an asset or tick sensors to plot.');
    this.plotsEl.append(this.empty);
    body.append(this.list, this.plotsEl);
    this.root.append(tb, body);
    host.appendChild(this.root);

    this.unsubs.push(
      this.store.on('snapshot', () => this.onPlant()),
      this.store.on('tick', () => this.onTick()),
      this.store.on('selection', (id) => this.onSelection(id)),
      this.store.on('theme', () => this.onTheme()),
    );
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.plotsEl);
    this.syncToolbar();
    if (this.store.plant) this.onPlant();
  }

  resize(): void {
    this.layout();
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs.length = 0;
    this.ro?.disconnect();
    this.plots.forEach((p) => p.destroy());
    this.plots = [];
    this.root.remove();
  }

  // ------------------------------------------------------------------ toolbar

  private button(key: string, text: string, title: string, fn: () => void): HTMLButtonElement {
    const b = el('button', 'cx-btn', text);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', fn);
    this.btns.set(key, b);
    return b;
  }

  private syncToolbar(): void {
    for (const w of WINDOWS) this.btns.get(`w-${w.key}`)!.setAttribute('aria-pressed', String(w.key === this.windowKey));
    const f = this.btns.get('follow')!;
    f.innerHTML = this.follow ? '<span class="ico">&#10074;&#10074;</span>Pause' : '<span class="ico">&#9654;</span>Follow';
    f.setAttribute('aria-pressed', String(!this.follow));
    const p = this.btns.get('pin')!;
    p.innerHTML = '<span class="ico">&#9679;</span>Pin';
    p.setAttribute('aria-pressed', String(this.pinned));
    this.btns.get('png')!.innerHTML = '<span class="ico">&#8681;</span>Export PNG';
    this.updateStatus();
  }

  private updateStatus(): void {
    const w = WINDOWS.find((x) => x.key === this.windowKey)!;
    const n = this.checked.size;
    const what = `${n} signal${n === 1 ? '' : 's'}`;
    this.status.textContent = this.follow
      ? `Following · ${w.key === 'all' ? 'all history' : `last ${w.label}`} · ${what}`
      : this.zoom
        ? `Paused · ${fmtSimTime(this.zoom[0])} – ${fmtSimTime(this.zoom[1])} · double-click plot to resume`
        : `Paused · ${what}`;
  }

  private setWindow(k: WindowKey): void {
    this.windowKey = k;
    this.zoom = null;
    this.follow = true;
    this.syncToolbar();
    this.update();
  }

  private setFollow(on: boolean): void {
    this.follow = on;
    if (on) this.zoom = null;
    this.syncToolbar();
    this.update();
  }

  // ------------------------------------------------------------------ sensor list

  private onPlant(): void {
    const plant = this.store.plant;
    this.list.textContent = '';
    this.groups = [];
    this.rows.clear();
    if (!plant) { this.setChecked([]); return; }
    for (const [assetId, defs] of groupByAsset(plant.sensors)) {
      const asset = plant.assets.find((a) => a.id === assetId);
      const g: Group = { assetId, el: el('div', 'tr-grp'), box: document.createElement('input'), tw: el('span', 'tr-tw', '▾'), rows: [], collapsed: false };
      g.box.type = 'checkbox';
      g.box.title = `Plot all ${assetId} signals`;
      g.box.addEventListener('change', () => {
        const ids = defs.map((d) => d.id);
        const next = new Set(this.checked);
        ids.forEach((id) => (g.box.checked ? next.add(id) : next.delete(id)));
        this.setChecked([...next]);
      });
      const name = el('b', '', assetId);
      const desc = el('span', '', asset?.name ?? '');
      g.el.append(g.tw, g.box, name, desc);
      g.el.addEventListener('click', (e) => {
        if (e.target === g.box) return;
        if (e.target === g.tw) { g.collapsed = !g.collapsed; g.tw.textContent = g.collapsed ? '▸' : '▾'; g.rows.forEach((r) => (r.row.hidden = g.collapsed)); return; }
        this.store.select(assetId);
      });
      this.list.append(g.el);
      for (const def of defs) {
        const row = el('label', 'tr-row');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => {
          const next = new Set(this.checked);
          if (box.checked) next.add(def.id); else next.delete(def.id);
          this.setChecked([...next]);
        });
        const sw = el('i', '');
        const suffix = def.id.slice(def.id.indexOf('.') + 1);
        const label = el('span', '', suffix);
        label.title = `${def.id} (${def.kind}, ${def.unit})${def.hi != null ? ` · hi ${def.hi}` : ''}${def.hiHi != null ? ` · hiHi ${def.hiHi}` : ''}`;
        const val = el('b', '');
        row.append(box, sw, label, val);
        this.list.append(row);
        const r: Row = { def, row, box, sw, val, lastTxt: '' };
        g.rows.push(r);
        this.rows.set(def.id, r);
      }
      this.groups.push(g);
    }
    // initial set: keep what still exists, else the selection, else the first machine with a temperature
    const keep = [...this.checked].filter((id) => this.rows.has(id));
    if (keep.length) this.setChecked(keep);
    else {
      const sel = this.store.selection;
      const first = plant.sensors.find((s) => s.kind === 'temperature')?.assetId;
      const asset = sel && plant.sensors.some((s) => s.assetId === sel) ? sel : first;
      this.setChecked(asset ? pickAutoSensors(plant.sensors, asset) : []);
    }
    this.highlightGroup();
    this.onTick();
  }

  private onSelection(id: string | null): void {
    this.highlightGroup();
    if (this.pinned || !id || !this.store.plant) return;
    const ids = pickAutoSensors(this.store.plant.sensors, id);
    if (ids.length) this.setChecked(ids);
  }

  private highlightGroup(): void {
    for (const g of this.groups) {
      const on = g.assetId === this.store.selection;
      g.el.classList.toggle('sel', on);
      if (on) this.list.scrollTop = Math.max(0, g.el.offsetTop - this.list.offsetTop - 2);
    }
  }

  private setChecked(ids: string[]): void {
    const same = ids.length === this.checked.size && ids.every((i) => this.checked.has(i));
    this.checked = new Set(ids);
    for (const [id, r] of this.rows) r.box.checked = this.checked.has(id);
    for (const g of this.groups) {
      const n = g.rows.filter((r) => r.box.checked).length;
      g.box.checked = n > 0 && n === g.rows.length;
      g.box.indeterminate = n > 0 && n < g.rows.length;
    }
    if (!same || !this.plots.length) this.rebuildPlots();
    this.updateStatus();
  }

  // ------------------------------------------------------------------ plots

  private rebuildPlots(): void {
    this.plots.forEach((p) => p.destroy());
    this.plots = [];
    const defs = [...this.checked].map((id) => this.rows.get(id)?.def).filter((d): d is SensorDef => !!d);
    // keep plant order inside each axis
    const order = new Map(this.store.plant?.sensors.map((s, i) => [s.id, i]) ?? []);
    defs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    this.specs = layoutSubplots(defs);
    this.empty.hidden = this.specs.length > 0;
    this.specs.forEach((spec, i) => {
      const last = i === this.specs.length - 1;
      const series = [
        ...spec.left.sensors.map((s) => ({ id: s.id, label: s.id, unit: s.unit, axis: 'L' as const, hi: s.hi, hiHi: s.hiHi })),
        ...(spec.right?.sensors ?? []).map((s) => ({ id: s.id, label: s.id, unit: s.unit, axis: 'R' as const, hi: s.hi, hiHi: s.hiHi })),
      ];
      this.plots.push(new TrendPlot(this.plotsEl, {
        series,
        yLabelL: spec.left.label,
        yLabelR: spec.right?.label,
        showX: last,
        syncKey: this.syncKey,
        onZoom: (min, max) => this.onZoom(min, max),
        onReset: () => this.setFollow(true),
      }));
    });
    this.paintSwatches();
    this.layout();
    this.update();
  }

  private paintSwatches(): void {
    for (const r of this.rows.values()) r.sw.style.background = 'transparent';
    for (const p of this.plots) p.series.forEach((s, i) => { const r = this.rows.get(s.id); if (r) r.sw.style.background = p.color(i); });
  }

  private layout(): void {
    const W = this.plotsEl.clientWidth, H = this.plotsEl.clientHeight;
    if (!W || !H || !this.plots.length) return;
    if (this.plots.length === 1) { this.plots[0].setSize(W, H); return; }
    const top = Math.floor((H - X_LABEL_H) / 2);
    this.plots[0].setSize(W, top);
    this.plots[1].setSize(W, H - top);
  }

  private onZoom(min: number, max: number): void {
    this.follow = false;
    this.zoom = [min, max];
    this.plots.forEach((p) => p.setXRange(min, max));
    this.syncToolbar();
    this.update();
  }

  private update(): void {
    if (!this.plots.length) return;
    const now = this.store.sim.simTimeMs / 1000;
    const secs = this.follow ? windowSeconds(this.windowKey) : Infinity;
    for (const p of this.plots) {
      const slices = p.series.map((s) => sliceWindow(this.store.getHistory(s.id), now, secs));
      const data = alignSeries(slices);
      let range: [number, number] | null = null;
      if (this.follow) range = windowRange(data[0], now, secs);
      else if (this.zoom) range = this.zoom;
      p.setData(data, range);
    }
  }

  private onTick(): void {
    this.update();
    // live values in the list
    for (const r of this.rows.values()) {
      if (r.row.hidden) continue;
      const v = this.store.sensors.get(r.def.id);
      const txt = fmtValue(v, r.def.unit);
      if (txt !== r.lastTxt) {
        r.lastTxt = txt;
        r.val.textContent = txt;
        r.row.classList.toggle('lim', v != null && r.def.hi != null && v >= r.def.hi && !(r.def.hiHi != null && v >= r.def.hiHi));
        r.row.classList.toggle('limhh', v != null && r.def.hiHi != null && v >= r.def.hiHi);
      }
    }
  }

  private onTheme(): void {
    this.plots.forEach((p) => p.refreshTheme());
    this.paintSwatches();
    this.layout();
    this.update();
  }

  // ------------------------------------------------------------------ export

  private exportPng(): void {
    if (!this.plots.length) return;
    const pal = readPlotPalette();
    const sizes = this.plots.map((p) => p.canvasSize);
    const w = Math.max(...sizes.map((s) => s.width));
    const pr = window.devicePixelRatio || 1;
    const head = Math.round(20 * pr);
    const h = sizes.reduce((a, s) => a + s.height, 0) + head;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = pal.axis;
    ctx.font = `bold ${Math.round(11 * pr)}px Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    const plant = this.store.plant?.name ?? 'Plant';
    ctx.fillText(`${plant} — Trends @ sim ${fmtSimTime(this.store.sim.simTimeMs / 1000)}`, 8 * pr, head / 2 + pr);
    let y = head;
    this.plots.forEach((p, i) => { p.exportTo(ctx, 0, y); y += sizes[i].height; });
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `trends_${Math.round(this.store.sim.simTimeMs / 1000)}s.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export const createTrendsPanel: PanelFactory = (ctx) => new TrendsPanel(ctx);
