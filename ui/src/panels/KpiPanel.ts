import type { AssetKpi, AssetStateKind, KpiReport, PlantModel, ResourceKind, StateBreakdown } from '../net/contracts';
import type { Panel, PanelContext, PanelFactory } from './panel';
import type { TwinStore } from '../state/store';
import { ArcGauge, BarMeter } from '../charts/KpiGauge';
import { Sparkline } from '../charts/Sparkline';
import { clampValue, gaugeColor, WORLD_CLASS, type GaugeZones } from '../charts/gaugeMath';
import { cssVar } from '../charts/theme';
import { formatDuration } from '../shell/format';
import '../charts/panels.css';
import './KpiPanel.v03.css';

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

// ---------------------------------------------------------------- v0.3 line / resource tables (pure)

export interface LineKpiRow {
  lineId: string; name: string; oee: number; availability: number; performance: number; quality: number;
  throughputPerHour: number; wip: number; bottleneckAssetId?: string;
}
export interface ResourceKpiRow { resourceId: string; name: string; kind: ResourceKind; count: number; utilization: number; waitSeconds: number }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One row per KpiReport.lines entry, in plant line order (unknown lines appended); [] without lines. */
export function lineKpiRows(plant: Pick<PlantModel, 'lines'> | null | undefined, kpi: KpiReport | null | undefined): LineKpiRow[] {
  const entries = kpi?.lines ?? [];
  const order = new Map((plant?.lines ?? []).map((l, i) => [l.id, i]));
  const name = (id: string) => plant?.lines?.find((l) => l.id === id)?.name || id;
  return entries
    .map((e, i) => ({ e, i, o: order.get(e.lineId) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map(({ e }) => ({
      lineId: e.lineId, name: name(e.lineId),
      oee: num(e.kpi.oee), availability: num(e.kpi.availability), performance: num(e.kpi.performance), quality: num(e.kpi.quality),
      throughputPerHour: num(e.kpi.throughputPerHour), wip: num(e.kpi.wip),
      ...(e.kpi.bottleneckAssetId ? { bottleneckAssetId: e.kpi.bottleneckAssetId } : {}),
    }));
}

/** One row per KpiReport.resources entry, named and typed from the plant (count falls back to the plant's). */
export function resourceKpiRows(plant: Pick<PlantModel, 'resources'> | null | undefined, kpi: KpiReport | null | undefined): ResourceKpiRow[] {
  return (kpi?.resources ?? []).map((r) => {
    const def = plant?.resources?.find((d) => d.id === r.resourceId);
    return {
      resourceId: r.resourceId, name: def?.name || r.resourceId, kind: def?.kind ?? 'operator',
      count: num(r.count) || def?.count || 0, utilization: Math.min(1, Math.max(0, num(r.utilization))), waitSeconds: Math.max(0, num(r.waitSeconds)),
    };
  });
}

const RES_ICON: Record<ResourceKind, string> = {
  operator: '<svg viewBox="0 0 12 12" width="12" height="12"><circle cx="6" cy="2.8" r="2" fill="currentColor"/><path d="M2 11.5V8.4a4 4 0 0 1 8 0v3.1z" fill="currentColor"/></svg>',
  agv: '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1" y="4" width="10" height="4.5" fill="currentColor"/><rect x="3" y="2" width="4" height="2" fill="currentColor"/><circle cx="3.2" cy="9.6" r="1.4" fill="currentColor"/><circle cx="8.8" cy="9.6" r="1.4" fill="currentColor"/></svg>',
  tool: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M8.2 1a2.8 2.8 0 0 0-2.7 3.5L1.3 8.7a1.2 1.2 0 0 0 1.7 1.7l4.2-4.2A2.8 2.8 0 0 0 10.7 3.5L9.2 5 7.4 4.6 7 2.8 8.5 1.3A2.8 2.8 0 0 0 8.2 1z" fill="currentColor"/></svg>',
};

const OEE_ZONES: GaugeZones = { alarm: 0.4, warn: 0.6, target: WORLD_CLASS.oee };
const BAR_ZONES: Record<'availability' | 'performance' | 'quality', GaugeZones> = {
  availability: { alarm: 0.7, warn: 0.85, target: WORLD_CLASS.availability },
  performance: { alarm: 0.6, warn: 0.8, target: WORLD_CLASS.performance },
  quality: { alarm: 0.95, warn: 0.98, target: WORLD_CLASS.quality },
};

interface LineRow { tr: HTMLTableRowElement; oee: HTMLElement; val: HTMLElement; a: HTMLElement; p: HTMLElement; q: HTMLElement; thr: HTMLElement; wip: HTMLElement; bn: HTMLElement; bnId?: string }
interface ResRow { tr: HTMLTableRowElement; bar: HTMLElement; val: HTMLElement; wait: HTMLElement }

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
  // v0.3
  private lineCap!: HTMLElement;
  private linesBox!: HTMLDivElement;
  private linesBody!: HTMLTableSectionElement;
  private readonly lineRows = new Map<string, LineRow>();
  private resBox!: HTMLDivElement;
  private resBody!: HTMLTableSectionElement;
  private readonly resRows = new Map<string, ResRow>();
  private readonly thr = { t: [] as number[], v: [] as number[] };
  private readonly unsubs: (() => void)[] = [];

  constructor(ctx: PanelContext) {
    this.store = ctx.store;
  }

  mount(host: HTMLElement): void {
    this.root = el('div', 'kp');
    // ---- line OEE
    const line = box('Line OEE', 'A × P × Q (bottleneck)');
    this.lineCap = line.querySelector('.kp-cap')!;
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

    // ---- v0.3: per-line and resource tables (hidden unless the report carries them)
    this.linesBox = box('Lines', 'OEE · A P Q % · pcs/h');
    const lt = el('table', 'kp-tbl kp-lines');
    lt.innerHTML = '<colgroup><col><col style="width:56px"><col style="width:22px"><col style="width:22px"><col style="width:22px"><col style="width:32px"><col style="width:24px"><col style="width:50px"></colgroup>' +
      '<thead><tr><th>Line</th><th>OEE</th><th class="r" title="Availability %">A</th><th class="r" title="Performance %">P</th><th class="r" title="Quality %">Q</th>' +
      '<th class="r" title="Throughput, pcs/h">/h</th><th class="r" title="Work in progress, pcs">WIP</th><th title="Bottleneck asset (click to select)">Bottleneck</th></tr></thead>';
    this.linesBody = el('tbody', '');
    lt.append(this.linesBody);
    this.linesBox.append(lt);
    this.linesBox.hidden = true;

    this.resBox = box('Resources', 'utilisation · wait');
    const rt = el('table', 'kp-tbl kp-res');
    rt.innerHTML = '<colgroup><col><col style="width:96px"><col style="width:58px"></colgroup>' +
      '<thead><tr><th>Resource</th><th>Utilisation</th><th class="r" title="Cumulative time assets waited for a free unit">Wait</th></tr></thead>';
    this.resBody = el('tbody', '');
    rt.append(this.resBody);
    this.resBox.append(rt);
    this.resBox.hidden = true;

    this.root.append(line, this.linesBox, this.resBox, sp, at);
    host.appendChild(this.root);

    this.unsubs.push(
      this.store.on('kpi', (k) => this.update(k)),
      this.store.on('snapshot', (s) => {
        this.thr.t.length = 0; this.thr.v.length = 0;
        this.rows.clear(); this.tbody.textContent = '';
        this.lineRows.clear(); this.linesBody.textContent = '';
        this.resRows.clear(); this.resBody.textContent = '';
        this.linesBox.hidden = true; this.resBox.hidden = true;
        this.spark.setData([], []);
        if (s.kpi) this.update(s.kpi);
      }),
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
    this.updateLines(k);
    this.updateResources(k);
    this.markSelection();
  }

  // ---------------------------------------------------------------- v0.3 sections

  private oeeColor(v: number): string {
    return gaugeColor(v, OEE_ZONES, {
      alarm: cssVar('--s-fault', '#d0021b'), warn: cssVar('--s-starved', '#e8a317'), normal: cssVar('--c-text-dim', '#5a5a5a'), target: cssVar('--s-running', '#76b900'),
    });
  }

  private updateLines(k: KpiReport): void {
    const rows = lineKpiRows(this.store.plant, k);
    this.linesBox.hidden = rows.length === 0;
    const cap = rows.length ? 'Plant OEE' : 'Line OEE';
    if (this.lineCap.firstChild && this.lineCap.firstChild.textContent !== cap) this.lineCap.firstChild.textContent = cap;
    for (const r of rows) {
      let v = this.lineRows.get(r.lineId);
      if (!v) {
        const tr = el('tr', 'row');
        const name = el('td', 'kp-lname', r.name);
        const c2 = el('td', '');
        const oeeW = el('div', 'kp-oee');
        const trk = el('div', 'trk');
        const bar = el('i', '');
        const mark = el('u', '');
        mark.style.left = `${WORLD_CLASS.oee * 100}%`;
        trk.append(bar, mark);
        const val = el('b', '', '—');
        oeeW.append(trk, val);
        c2.append(oeeW);
        const n = () => el('td', 'n', '—');
        const a = n(), p = n(), q = n(), thr = n(), wip = n();
        const bnTd = el('td', '');
        const bn = el('span', 'kp-bn kp-id', '—');
        bnTd.append(bn);
        tr.append(name, c2, a, p, q, thr, wip, bnTd);
        this.linesBody.append(tr);
        v = { tr, oee: bar, val, a, p, q, thr, wip, bn };
        const row = v;
        bn.addEventListener('click', (e) => { e.stopPropagation(); if (row.bnId) this.store.select(row.bnId); });
        this.lineRows.set(r.lineId, v);
      }
      const oee = clampValue(r.oee);
      v.oee.style.width = `${(oee * 100).toFixed(1)}%`;
      v.oee.style.background = this.oeeColor(r.oee);
      setTxt(v.val, (oee * 100).toFixed(1));
      setTxt(v.a, (r.availability * 100).toFixed(0));
      setTxt(v.p, (r.performance * 100).toFixed(0));
      setTxt(v.q, (r.quality * 100).toFixed(0));
      setTxt(v.thr, r.throughputPerHour.toFixed(1));
      setTxt(v.wip, r.wip.toFixed(0));
      v.bnId = r.bottleneckAssetId;
      setTxt(v.bn, r.bottleneckAssetId ?? '—');
      v.bn.classList.toggle('kp-bn', !!r.bottleneckAssetId);
      v.bn.title = r.bottleneckAssetId ? `Select ${r.bottleneckAssetId}` : '';
      v.tr.title = `${r.name} (${r.lineId}) — OEE ${(oee * 100).toFixed(1)} % (A ${(r.availability * 100).toFixed(1)} · P ${(r.performance * 100).toFixed(1)} · Q ${(r.quality * 100).toFixed(1)}), ${r.throughputPerHour.toFixed(1)} pcs/h, WIP ${r.wip}`;
    }
  }

  private updateResources(k: KpiReport): void {
    const rows = resourceKpiRows(this.store.plant, k);
    this.resBox.hidden = rows.length === 0;
    for (const r of rows) {
      let v = this.resRows.get(r.resourceId);
      if (!v) {
        const tr = el('tr', 'row');
        const c1 = el('td', 'kp-rname');
        const ic = el('span', 'kp-ric');
        ic.innerHTML = RES_ICON[r.kind] ?? RES_ICON.tool;
        c1.append(ic, el('span', '', r.name), el('small', '', ` ×${r.count}`));
        const c2 = el('td', '');
        const w = el('div', 'kp-oee');
        const trk = el('div', 'trk');
        const bar = el('i', '');
        trk.append(bar);
        const val = el('b', '', '—');
        w.append(trk, val);
        c2.append(w);
        const wait = el('td', 'n', '—');
        tr.append(c1, c2, wait);
        this.resBody.append(tr);
        v = { tr, bar, val, wait };
        this.resRows.set(r.resourceId, v);
      }
      v.bar.style.width = `${(r.utilization * 100).toFixed(1)}%`;
      // saturated pools are the abnormal case worth colour (ISA-101): amber ≥ 85 %, red ≥ 97 %
      v.bar.style.background = r.utilization >= 0.97 ? cssVar('--s-fault', '#d0021b') : r.utilization >= 0.85 ? cssVar('--s-starved', '#e8a317') : cssVar('--c-text-dim', '#5a5a5a');
      setTxt(v.val, (r.utilization * 100).toFixed(1));
      setTxt(v.wait, formatDuration(r.waitSeconds * 1000));
      v.tr.title = `${r.name} (${r.resourceId}): ${r.count} × ${r.kind}, utilisation ${(r.utilization * 100).toFixed(1)} %, assets waited ${formatDuration(r.waitSeconds * 1000)} in total`;
    }
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

function setTxt(e: HTMLElement, t: string): void {
  if (e.textContent !== t) e.textContent = t;
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
