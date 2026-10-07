// Analysis → What-If…: edit parameter overrides, run baseline vs scenario headless,
// show a results table with improvement colouring.
import type { PanelContext } from '../panels/panel';
import type { WhatIfResult } from '../net/contracts';
import type { Scenario, WhatIfRequest } from '../net/contracts'; // v0.2 ui-connections
import { whatIfScenarioHook } from '../connections/ScenarioDialogs'; // v0.2 ui-connections
import { scenarioOverrideRows, formatHorizon } from '../connections/logic'; // v0.2 ui-connections
import { Dialog } from '../widgets/Dialog';
import { ComboBox } from '../widgets/ComboBox';
import { NumericInput } from '../widgets/NumericInput';
import { groupBox, checkbox } from '../widgets/GroupBox';
import { button } from '../widgets/Button';
import { h, svg } from '../widgets/dom';
import { icons } from '../widgets/icons';
import { paramLabel, formatNum } from '../shell/format';
import { postStatus } from '../shell/status';
import {
  buildOverrides, classifyDelta, formatDelta, formatDeltaPct, formatMetric, metricLabel, metricUnit,
  WHATIF_DURATIONS, type OverrideRow,
} from './whatIfLogic';

interface RowCtl { tr: HTMLTableRowElement; asset: ComboBox<string>; param: ComboBox<string>; value: NumericInput; base: HTMLTableCellElement }

let lastDuration = 8 * 3600;
let lastFromLive = true;

export function openWhatIfDialog(ctx: PanelContext, saved?: { scenario: Scenario; rerun?: boolean }): Dialog | null {
  const { store, source } = ctx;
  const plant = store.plant;
  if (!plant) return null;
  const editable = plant.assets.filter((a) => Object.keys(a.params).length > 0);
  const assetItems = editable.map((a) => ({ value: a.id, label: a.id }));
  const paramItems = (assetId: string) =>
    Object.keys(store.assetDef(assetId)?.params ?? {}).map((k) => ({ value: k, label: paramLabel(k).label }));
  const paramValue = (assetId: string, key: string) => store.assetDef(assetId)?.params[key] ?? 0;

  // ---------- overrides editor ----------
  const rows: RowCtl[] = [];
  const tbody = h('tbody');
  const list = h('div.ovr-list');
  const empty = h('div.ovr-empty', { text: 'No overrides — the scenario will equal the baseline. Click "Add" to change a parameter.' });
  const table = h('table.ovr-table', null,
    h('thead', null, h('tr', null,
      h('th', { text: 'Asset' }), h('th', { text: 'Parameter' }), h('th', { text: 'Scenario value' }),
      h('th', { text: 'Current', style: 'text-align:right' }), h('th'))),
    tbody);
  list.append(table, empty);
  const syncEmpty = () => { empty.style.display = rows.length ? 'none' : ''; table.style.display = rows.length ? '' : 'none'; };

  const addRow = (assetId: string, param?: string, value?: number) => {
    const tr = h('tr');
    const base = h('td.base');
    const pItems = paramItems(assetId);
    const p0 = param ?? pItems[0]?.value ?? '';
    const valueIn = new NumericInput({ value: value ?? paramValue(assetId, p0), min: 0, step: 1, width: 110 });
    const paramCombo = new ComboBox<string>({
      items: pItems, value: p0, width: 170,
      onChange: (k) => { const cur = paramValue(assetCombo.value!, k); valueIn.setValue(cur); base.textContent = formatNum(cur); },
    });
    const assetCombo: ComboBox<string> = new ComboBox<string>({
      items: assetItems, value: assetId, width: 96,
      onChange: (id) => {
        paramCombo.setItems(paramItems(id));
        const cur = paramValue(id, paramCombo.value!);
        valueIn.setValue(cur);
        base.textContent = formatNum(cur);
      },
    });
    base.textContent = formatNum(paramValue(assetId, p0));
    const rm = button({ icon: 'clear', small: true, title: 'Remove override' });
    const ctl: RowCtl = { tr, asset: assetCombo, param: paramCombo, value: valueIn, base };
    rm.addEventListener('click', () => { tr.remove(); rows.splice(rows.indexOf(ctl), 1); syncEmpty(); });
    tr.append(h('td', null, assetCombo.el), h('td', null, paramCombo.el), h('td', null, valueIn.el), base, h('td', null, rm));
    tbody.append(tr);
    rows.push(ctl);
    syncEmpty();
  };

  // Sensible default: speed up the current bottleneck (or the selection) by 10 %.
  const seedAsset = (store.selection && editable.find((a) => a.id === store.selection)?.id)
    ?? store.kpi?.line.bottleneckAssetId ?? editable.find((a) => a.kind === 'machine')?.id;
  if (seedAsset && store.assetDef(seedAsset)?.params.cycleTimeS !== undefined) {
    addRow(seedAsset, 'cycleTimeS', +(paramValue(seedAsset, 'cycleTimeS') * 0.9).toFixed(1));
  }
  syncEmpty();

  const addBtn = button({ text: 'Add', icon: 'plus', small: true, onClick: () => addRow(store.selection && editable.some((a) => a.id === store.selection) ? store.selection : editable[0].id) });
  const clearBtn = button({ text: 'Remove All', small: true, onClick: () => { rows.splice(0).forEach((r) => r.tr.remove()); syncEmpty(); } });
  const ovrBox = groupBox('Parameter overrides (scenario)', list, h('div.dlg-row', { style: 'margin-top:4px' }, addBtn, clearBtn));

  // ---------- run settings ----------
  const dur = new ComboBox<number>({ items: WHATIF_DURATIONS, value: lastDuration, width: 150 });
  const seed = new NumericInput({ value: store.sim.seed || plant.seed, min: 0, max: 2 ** 31 - 1, step: 1, width: 90 });
  const fromLive = checkbox('Start from live parameters', lastFromLive);
  const settings = groupBox('Run settings',
    h('div.dlg-row', null,
      h('label', { text: 'Sim duration:' }), dur.el,
      h('label', { text: 'Seed:', style: 'margin-left:8px' }), seed.el,
      h('span.grow'), fromLive.el),
    h('p.dlg-note', { text: 'Both runs start empty from the same seed, so short horizons include warm-up. Baseline uses the current parameters when "from live" is checked, otherwise the original plant model.' }));

  // ---------- results ----------
  const results = h('div.wi-results');
  const placeholder = (text: string, busy = false) => {
    results.textContent = '';
    const ph = h('div.wi-placeholder');
    const ic = svg(icons.whatIf);
    ic.style.cssText = 'width:32px;height:32px;opacity:.55';
    ph.append(ic, h('span', { text }));
    if (busy) ph.append(h('div.progress', null, h('div.bar')));
    results.append(ph);
  };
  placeholder('Press Run to simulate baseline and scenario side by side.');
  const resBox = groupBox('Results', results);

  const showResult = (r: WhatIfResult) => {
    results.textContent = '';
    const tb = h('tbody');
    const order = ['oee', 'availability', 'performance', 'quality', 'throughputPerHour', 'good', 'scrap', 'wip'];
    const rank = (m: string) => { const i = order.indexOf(m); return i < 0 ? 99 : i; };
    const deltas = [...r.deltas].sort((a, b) => rank(a.metric) - rank(b.metric));
    for (const d of deltas) {
      const cls = classifyDelta(d);
      const unit = metricUnit(d.metric);
      const tr = h('tr', null,
        h('td', { text: metricLabel(d.metric) }),
        h('td.r', null, formatMetric(d.metric, d.baseline), h('span.u', { text: unit })),
        h('td.r', null, formatMetric(d.metric, d.scenario), h('span.u', { text: unit })),
        h(`td.r${cls !== 'same' ? '.' + cls : ''}`, { text: formatDelta(d.metric, d.delta) }),
        h(`td.r${cls !== 'same' ? '.' + cls : ''}`, { text: formatDeltaPct(d.deltaPct) }));
      if (d.metric === 'oee' || d.metric === 'throughputPerHour') tr.classList.add('key');
      tb.append(tr);
    }
    const t = h('table.sgrid', null,
      h('colgroup', null, h('col', { style: 'width:30%' }), h('col'), h('col'), h('col'), h('col')),
      h('thead', null, h('tr', null,
        h('th', { text: 'Metric' }), h('th.r', { text: 'Baseline' }), h('th.r', { text: 'Scenario' }),
        h('th.r', { text: 'Δ' }), h('th.r', { text: 'Δ %' }))),
      tb);
    const bl = r.baseline.line.bottleneckAssetId ?? '—';
    const sl = r.scenario.line.bottleneckAssetId ?? '—';
    const sum = h('div.wi-summary', null,
      h('span', null, 'Horizon ', h('b', { text: `${(r.durationS / 3600).toFixed(0)} h` })),
      h('span', null, 'Seed ', h('b', { text: String(r.seed) })),
      h('span', null, 'Bottleneck ', h('b', { text: bl === sl ? bl : `${bl} → ${sl}` })),
      h('span', null, 'Computed in ', h('b', { text: `${r.elapsedMs} ms` })));
    results.append(t, sum);
  };

  const body = h('div', null, ovrBox, settings, resBox);
  body.style.width = '600px';

  // ---- v0.2 ui-connections: saved scenarios (Save scenario… / Open saved…) ----
  const scen = whatIfScenarioHook(ctx, {
    currentRequest: (): WhatIfRequest => ({
      durationS: dur.value ?? 8 * 3600, seed: seed.value, fromLive: fromLive.input.checked,
      overrides: buildOverrides(rows.map((r) => ({ assetId: r.asset.value!, param: r.param.value!, value: r.value.value }))),
    }),
    load: (s) => {
      rows.splice(0).forEach((r) => r.tr.remove());
      for (const o of scenarioOverrideRows(s)) if (editable.some((a) => a.id === o.assetId)) addRow(o.assetId, o.param, o.value);
      syncEmpty();
      const d = s.request.durationS;
      if (!WHATIF_DURATIONS.some((x) => x.value === d)) dur.setItems([...WHATIF_DURATIONS, { label: formatHorizon(d), value: d }], d);
      else dur.setValue(d, true);
      if (s.request.seed !== undefined) seed.setValue(s.request.seed);
      fromLive.input.checked = s.request.fromLive ?? true;
      if (s.result) showResult(s.result); else placeholder(`Loaded “${s.name}”. Press Run to simulate it.`);
    },
    run: () => dlg.buttons.get('run')?.click(),
  });
  // ---- end v0.2 ui-connections ----

  let running = false;
  const dlg = Dialog.open({
    title: 'What-If Scenario',
    icon: 'whatIf',
    body,
    width: 628,
    buttons: [
      ...scen.buttons, // v0.2 ui-connections
      {
        id: 'run', text: 'Run', isDefault: true,
        onClick: async (d) => {
          if (running) return false;
          const ovr: OverrideRow[] = rows.map((r) => ({ assetId: r.asset.value!, param: r.param.value!, value: r.value.value }));
          lastDuration = dur.value ?? 8 * 3600;
          lastFromLive = fromLive.input.checked;
          running = true;
          d.setBusy(true);
          placeholder(`Running two headless simulations of ${(lastDuration / 3600).toFixed(0)} h…`, true);
          try {
            const req = { durationS: lastDuration, overrides: buildOverrides(ovr), seed: seed.value, fromLive: lastFromLive };
            const res = await source.whatIf(req);
            scen.afterRun(req, res); // v0.2 ui-connections
            if (d.isOpen) showResult(res);
            postStatus(`What-if finished in ${res.elapsedMs} ms`, 'ok');
          } catch (e) {
            results.textContent = '';
            results.append(h('div.wi-error', { text: `What-if failed: ${(e as Error)?.message ?? e}` }));
            postStatus('What-if failed', 'error');
          } finally {
            running = false;
            d.setBusy(false);
            scen.refresh(); // v0.2 ui-connections
          }
          return false;
        },
      },
      { id: 'close', text: 'Close', isCancel: true },
    ],
  });
  scen.bind(dlg); // v0.2 ui-connections
  if (saved) scen.loadSaved(saved.scenario, saved.rerun); // v0.2 ui-connections
  return dlg;
}
