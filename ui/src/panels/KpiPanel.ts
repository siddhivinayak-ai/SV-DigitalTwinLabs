import type { AssetKpi, AssetStateKind, KpiReport, StateBreakdown } from '../net/contracts';
import type { Panel, PanelContext, PanelFactory } from './panel';
import type { TwinStore } from '../state/store';
import { ArcGauge, BarMeter } from '../charts/KpiGauge';
import { Sparkline } from '../charts/Sparkline';
import { clampValue, gaugeColor, WORLD_CLASS, type GaugeZones } from '../charts/gaugeMath';
import { cssVar } from '../charts/theme';
import '../charts/panels.css';

/** Order of the stacked state-fraction bar (left → right); idle/off fill the remainder in grey. */
export const STATE_BAR_ORDER: readonly AssetStateKind[] = ['running', 'starved', 'blocked', 'fault', 'maintenance', 'idle', 'off'];

/** Normalised state fractions in bar order (sums to 1 when any time was recorded; NaN/negatives → 0). */
export function stateSegments(states: Partial<StateBreakdown> | undefined): { state: AssetStateKind; frac: number }[] {
  const raw = STATE_BAR_ORDER.map((s) => {
    const v = states?.[s];
    return { state: s, frac: v != null && Number.isFinite(v) && v > 0 ? v : 0 };
  });
  const sum = raw.reduce((a, r) => a + r.frac, 0);
  return sum > 0 ? raw.map((r) => ({ state: r.state, frac: r.frac / sum })) : raw;
}

/** Append a sample to a bounded series, ignoring non-advancing time (pause, duplicate frames). */
export function pushSample(s: { t: number[]; v: number[] }, t: number, v: number, cap = 720): void {
  if (!Number.isFinite(t) || !Number.isFinite(v)) return;
  const n = s.t.length;
  if (n && t <= s.t[n - 1]) { if (t === s.t[n - 1]) s.v[n - 1] = v; return; }
  s.t.push(t);
  s.v.push(v);
  if (s.t.length > cap) { s.t.splice(0, s.t.length - cap); s.v.splice(0, s.v.length - cap); }
}

const OEE_ZONES: GaugeZones = { alarm: 0.4, warn: 0.6, target: WORLD_CLASS.oee };
const BAR_ZONES: Record<'availability' | 'performance' | 'quality', GaugeZones> = {
  availability: { alarm: 0.7, warn: 0.85, target: WORLD_CLASS.availability },
  performance: { alarm: 0.6, warn: 0.8, target: WORLD_CLASS.performance },
  quality: { alarm: 0.95, warn: 0.98, target: WORLD_CLASS.quality },
};

interface AssetRow { tr: HTMLTableRowElement; id: HTMLElement; bn: HTMLElement; bar: HTMLElement; mark: HTMLElement; val: HTMLElement; segs: Map<AssetStateKind, HTMLElement> }

class KpiPanel implements Panel {
  readonly id = 'kpi';
  readonly title = 'KPIs';
  private readonly store: TwinStore;
  private root!: HTMLDivElement;
  private gauge!: ArcGauge;
  private bars!: Record<'availability' | 'performance' | 'quality', BarMeter>;
  private spark!: Sparkline;
  private tiles!: Record<'thr' | 'wip' | 'good' | 'scrap', HTMLElement>;
  private bottleneck!: HTMLElement;
  private sparkCap!: HTMLElement;
  private tbody!: HTMLTableSectionElement;
  private readonly rows = new Map<string, AssetRow>();
  private readonly thr = { t: [] as number[], v: [] as number[] };
  private readonly unsubs: (() => void)[] = [];

  constructor(ctx: PanelContext) {
    this.store = ctx.store;
  }

  mount(host: HTMLElement): void {
    this.root = el('div', 'kp');
    // ---- line OEE
    const line = box('Line OEE', 'A × P × Q (bottleneck)');
    const top = el('div', 'kp-top');
    const g = el('div', 'kp-gauge');
    const barsEl = el('div', 'kp-bars');
    top.append(g, barsEl);
    line.append(top);
    this.gauge = new ArcGauge(g, { label: 'OEE', unit: '%', zones: OEE_ZONES });
    const mk = (k: keyof typeof BAR_ZONES, label: string) => { const d = el('div', 'kp-bar'); barsEl.append(d); return new BarMeter(d, { label, zones: BAR_ZONES[k] }); };
    this.bars = { availability: mk('availability', 'A'), performance: mk('performance', 'P'), quality: mk('quality', 'Q') };
    barsEl.append(el('div', 'kp-target', '▼ world-class target'));
    const tiles = el('div', 'kp-tiles');
    const tile = (label: string, unit = '', wide = false) => {
      const t = el('div', `kp-tile cx-sunken${wide ? ' wide' : ''}`);
      const b = el('b', '', '—');
      t.append(el('span', '', label), b);
      if (unit) b.dataset.unit = unit;
      tiles.append(t);
      return b;
    };
    this.tiles = { thr: tile('Throughput', 'pcs/h'), wip: tile('WIP', 'pcs'), good: tile('Good', 'pcs'), scrap: tile('Scrap', 'pcs') };
    const bnTile = el('div', 'kp-tile cx-sunken wide');
    this.bottleneck = el('b', 'kp-bn', '—');
    this.bottleneck.title = 'Select the bottleneck asset';
    this.bottleneck.addEventListener('click', () => { const id = this.store.kpi?.line.bottleneckAssetId; if (id) this.store.select(id); });
    bnTile.append(el('span', '', 'Bottleneck'), this.bottleneck);
    tiles.append(bnTile);
    line.append(tiles);

    // ---- throughput sparkline
    const sp = box('Throughput', 'pcs/h vs sim time');
    this.sparkCap = sp.querySelector('.kp-cap em')!;
    const se = el('div', 'kp-spark cx-sunken');
    sp.append(se);
    this.spark = new Sparkline(se, 1);

    // ---- per-asset table
    const at = box('Assets', 'OEE · state time');
    const tbl = el('table', 'kp-tbl');
    tbl.innerHTML = '<colgroup><col style="width:68px"><col style="width:84px"><col></colgroup><thead><tr><th>Asset</th><th>OEE</th><th>State fraction</th></tr></thead>';
    this.tbody = el('tbody', '');
    tbl.append(this.tbody);
    at.append(tbl);
    const lg = el('div', 'kp-legend');
    for (const [s, label] of [['running', 'Run'], ['starved', 'Starved'], ['blocked', 'Blocked'], ['fault', 'Fault'], ['maintenance', 'Maint'], ['idle', 'Idle']] as const) {
      const sp2 = el('span', '');
      const i = el('i', '');
      i.className = '';
      i.style.background = s === 'blocked' ? 'repeating-linear-gradient(135deg, var(--s-blocked) 0 3px, #8a5e00 3px 4px)' : `var(--s-${s})`;
      sp2.append(i, document.createTextNode(label));
      lg.append(sp2);
    }
    at.append(lg);

    this.root.append(line, sp, at);
    host.appendChild(this.root);

    this.unsubs.push(
      this.store.on('kpi', (k) => this.update(k)),
      this.store.on('snapshot', (s) => { this.thr.t.length = 0; this.thr.v.length = 0; this.rows.clear(); this.tbody.textContent = ''; if (s.kpi) this.update(s.kpi); }),
      this.store.on('selection', () => this.markSelection()),
      this.store.on('theme', () => this.onTheme()),
    );
    if (this.store.kpi) this.update(this.store.kpi);
  }

  resize(): void {
    // canvases track their own size (ResizeObserver); nothing to do
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs.length = 0;
    this.gauge.dispose();
    Object.values(this.bars).forEach((b) => b.dispose());
    this.spark.dispose();
    this.root.remove();
  }

  private update(k: KpiReport): void {
    const L = k.line;
    this.gauge.set(L.oee);
    this.bars.availability.set(L.availability);
    this.bars.performance.set(L.performance);
    this.bars.quality.set(L.quality);
    setNum(this.tiles.thr, L.throughputPerHour, 1);
    setNum(this.tiles.wip, L.wip, 0);
    setNum(this.tiles.good, L.good, 0);
    setNum(this.tiles.scrap, L.scrap, 0);
    const bn = L.bottleneckAssetId ?? '—';
    if (this.bottleneck.textContent !== bn) this.bottleneck.textContent = bn;
    this.bottleneck.classList.toggle('kp-bn', !!L.bottleneckAssetId);

    pushSample(this.thr, k.simTimeMs / 1000, L.throughputPerHour);
    this.spark.setData(this.thr.t, this.thr.v);
    const last = this.thr.v[this.thr.v.length - 1];
    const cap = `${last != null ? last.toFixed(1) : '—'} pcs/h`;
    if (this.sparkCap.textContent !== cap) this.sparkCap.textContent = cap;

    for (const a of k.assets) this.updateRow(a, a.assetId === L.bottleneckAssetId);
    this.markSelection();
  }

  private updateRow(a: AssetKpi, isBn: boolean): void {
    let r = this.rows.get(a.assetId);
    if (!r) {
      const tr = el('tr', 'row');
      tr.addEventListener('click', () => this.store.select(a.assetId));
      const c1 = el('td', ''), c2 = el('td', ''), c3 = el('td', '');
      const id = el('span', 'kp-id', a.assetId);
      const bn = el('small', '', '');
      bn.title = 'Bottleneck';
      c1.append(id, bn);
      const oee = el('div', 'kp-oee');
      const trk = el('div', 'trk');
      const bar = el('i', '');
      const mark = el('u', '');
      mark.style.left = `${WORLD_CLASS.oee * 100}%`;
      trk.append(bar, mark);
      const val = el('b', '', '—');
      oee.append(trk, val);
      c2.append(oee);
      const st = el('div', 'kp-st');
      const segs = new Map<AssetStateKind, HTMLElement>();
      for (const s of STATE_BAR_ORDER) { const i = el('i', s); i.style.width = '0%'; st.append(i); segs.set(s, i); }
      c3.append(st);
      tr.append(c1, c2, c3);
      this.tbody.append(tr);
      r = { tr, id, bn, bar, mark, val, segs };
      this.rows.set(a.assetId, r);
    }
    const oee = clampValue(a.oee);
    r.bar.style.width = `${(oee * 100).toFixed(1)}%`;
    r.bar.style.background = gaugeColor(a.oee, OEE_ZONES, {
      alarm: cssVar('--s-fault', '#d0021b'), warn: cssVar('--s-starved', '#e8a317'), normal: cssVar('--c-text-dim', '#5a5a5a'), target: cssVar('--s-running', '#76b900'),
    });
    const txt = `${(oee * 100).toFixed(1)}`;
    if (r.val.textContent !== txt) r.val.textContent = txt;
    r.bn.textContent = isBn ? '◆' : '';
    const segs = stateSegments(a.states);
    const tip: string[] = [];
    for (const { state, frac } of segs) {
      r.segs.get(state)!.style.width = `${(frac * 100).toFixed(2)}%`;
      if (frac >= 0.005) tip.push(`${state} ${(frac * 100).toFixed(1)}%`);
    }
    r.tr.title = `${a.assetId} — OEE ${txt}% (A ${(a.availability * 100).toFixed(1)} · P ${(a.performance * 100).toFixed(1)} · Q ${(a.quality * 100).toFixed(1)})\n${tip.join(' · ')}`;
  }

  private markSelection(): void {
    for (const [id, r] of this.rows) r.tr.classList.toggle('sel', id === this.store.selection);
  }

  private onTheme(): void {
    this.gauge.refreshTheme();
    Object.values(this.bars).forEach((b) => b.refreshTheme());
    this.spark.refreshTheme();
    if (this.store.kpi) this.update(this.store.kpi);
  }
}

function setNum(b: HTMLElement, v: number | undefined, digits: number): void {
  const s = v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
  const html = `${s}<small>${b.dataset.unit ?? ''}</small>`;
  if (b.dataset.last !== html) { b.dataset.last = html; b.innerHTML = html; }
}

function box(caption: string, sub?: string): HTMLDivElement {
  const d = el('div', 'kp-box');
  const c = el('span', 'kp-cap', caption);
  if (sub) { c.append(' '); c.append(el('em', '', sub)); }
  d.append(c);
  return d;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export const createKpiPanel: PanelFactory = (ctx) => new KpiPanel(ctx);
