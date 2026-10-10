// Analysis → Event History…: persisted events (keyset-paged, "Load older") and alarms
// from /api/history, with filters and a client-side CSV export of the filtered rows.
import type { Alarm, AlarmSource, EventRecord, Severity } from '../net/contracts';
import type { PanelContext } from '../panels/panel';
import { Dialog } from '../widgets/Dialog';
import { DataGrid } from '../widgets/DataGrid';
import { ComboBox } from '../widgets/ComboBox';
import { TabStrip } from '../widgets/TabStrip';
import { button } from '../widgets/Button';
import { h, svg, setText } from '../widgets/dom';
import { icons } from '../widgets/icons';
import { formatNum, formatSimTime, severityRank } from '../shell/format';
import { downloadText } from '../shell/exportCsv';
import { postStatus } from '../shell/status';
import { connectedTwinApi } from './api';
import { connIcons } from './icons';
import {
  ALARM_CSV_COLUMNS, ALARM_SOURCE_ITEMS, EVENT_CSV_COLUMNS, HistoryPager, alarmMatches, alarmSourceLabel, historyEventMatches, toCsv,
} from './logic';
import './connections.css';

const PAGE = 200;
const SEV_ICON = { info: icons.info, warning: icons.warning, critical: icons.critical } as const;
const SEV_ITEMS: { value: Severity | 'all'; label: string }[] = [
  { value: 'all', label: 'All severities' }, { value: 'warning', label: 'Warning and above' }, { value: 'critical', label: 'Critical only' },
];

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

function sevCell(cell: HTMLElement, sev: Severity): void {
  if (cell.dataset.sev === sev) return;
  cell.dataset.sev = sev;
  cell.textContent = '';
  cell.append(svg(SEV_ICON[sev]), h('span.ct', { text: sev[0].toUpperCase() + sev.slice(1) }));
}

function filterField(placeholder: string, onChange: (v: string) => void): HTMLInputElement {
  const f = h('input.field', { type: 'text', placeholder, spellcheck: 'false' });
  f.style.width = '190px';
  f.addEventListener('input', () => onChange(f.value.trim()));
  f.addEventListener('keydown', (e) => { if (e.key === 'Escape' && f.value) { e.stopPropagation(); f.value = ''; onChange(''); } });
  return f;
}

export function openHistoryDialog(ctx: PanelContext): Dialog {
  const api = connectedTwinApi(ctx.source);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

  // ---------------- events tab ----------------
  const pager = new HistoryPager<EventRecord>((limit, beforeId) => api.historyEvents(limit, beforeId), PAGE);
  let evText = '', evSev: Severity | 'all' = 'all', evKind: EventRecord['kind'] | 'all' = 'all';
  let evRows: EventRecord[] = [];
  const evCount = h('span.count');
  const evErr = h('span.err');
  const evGrid = new DataGrid<EventRecord>({
    storageKey: 'svdtl.grid.histEvents.v1', framed: true, emptyText: '(no events)',
    rowId: (e) => String(e.id),
    initialSort: { key: 'id', dir: 'desc' },
    rowClass: (e) => (e.severity === 'critical' ? 'ev-critical' : ''),
    columns: [
      { key: 'id', title: '#', width: 56, align: 'right', sortKey: (e) => e.id },
      { key: 'time', title: 'Sim time', width: 72, mono: true, text: (e) => formatSimTime(e.timeMs), sortKey: (e) => e.timeMs },
      { key: 'severity', title: 'Severity', width: 78, sortKey: (e) => severityRank(e.severity), render: (c, e) => sevCell(c, e.severity) },
      { key: 'kind', title: 'Kind', width: 64 },
      { key: 'assetId', title: 'Asset', width: 66, text: (e) => e.assetId ?? '' },
      { key: 'message', title: 'Message', width: 420, cellClass: (e) => (e.severity === 'critical' ? 'tx-fault' : '') },
    ],
  });
  const olderBtn = button({ text: 'Load older', small: true, title: `Fetch the next ${PAGE} older events (beforeId paging)`, onClick: () => void loadEvents(false) });
  const applyEv = () => {
    evRows = pager.rows.filter((e) => historyEventMatches(e, evText, evSev, evKind));
    evGrid.setRows(evRows);
    const oldest = pager.oldestId;
    setText(evCount, `${evRows.length} shown / ${pager.rows.length} loaded${pager.done ? ' (all)' : ''}${oldest !== undefined ? ` · oldest #${oldest}` : ''}`);
    olderBtn.disabled = pager.done || pager.loading;
  };
  const loadEvents = async (fresh: boolean) => {
    setText(evErr, '');
    olderBtn.disabled = true;
    try {
      const got = fresh ? await pager.reload() : await pager.loadMore();
      applyEv();
      if (!fresh && !got.length) postStatus('No older events', 'info');
    } catch (e) {
      setText(evErr, `Could not load events: ${errText(e)}`);
      olderBtn.disabled = false;
    }
  };
  const evKindCombo = new ComboBox<EventRecord['kind'] | 'all'>({
    items: [{ value: 'all', label: 'All kinds' }, { value: 'state', label: 'State' }, { value: 'alarm', label: 'Alarm' }, { value: 'command', label: 'Command' }, { value: 'info', label: 'Info' }],
    value: 'all', width: 90, onChange: (v) => { evKind = v; applyEv(); },
  });
  const evSevCombo = new ComboBox<Severity | 'all'>({ items: SEV_ITEMS, value: 'all', width: 124, onChange: (v) => { evSev = v; applyEv(); } });
  const evPage = h('div.cx-page', null,
    h('div.dlg-row', null, svg(icons.filter), filterField('Filter (text, asset)', (v) => { evText = v; applyEv(); }), evKindCombo.el, evSevCombo.el, h('span.grow'), olderBtn),
    h('div.cx-grid', null, evGrid.el),
    h('div.dlg-row', null, evCount, h('span.grow'), evErr));

  // ---------------- alarms tab ----------------
  let alLimit = PAGE;
  let alAll: Alarm[] = [];
  let alRows: Alarm[] = [];
  let alText = '', alSrc: AlarmSource | 'all' = 'all', alSev: Severity | 'all' = 'all';
  const alCount = h('span.count');
  const alErr = h('span.err');
  const alGrid = new DataGrid<Alarm>({
    storageKey: 'svdtl.grid.histAlarms.v1', framed: true, emptyText: '(no alarms)',
    rowId: (a) => `${a.id}@${a.raisedAtMs}`,
    initialSort: { key: 'raised', dir: 'desc' },
    rowClass: (a) => (a.source === 'deviation' ? 'dev-alarm' : ''),
    columns: [
      { key: 'raised', title: 'Raised', width: 72, mono: true, text: (a) => formatSimTime(a.raisedAtMs), sortKey: (a) => a.raisedAtMs },
      { key: 'cleared', title: 'Cleared', width: 72, mono: true, text: (a) => (a.clearedAtMs === undefined ? (a.active ? 'active' : '') : formatSimTime(a.clearedAtMs)), sortKey: (a) => a.clearedAtMs ?? Infinity },
      { key: 'severity', title: 'Severity', width: 78, sortKey: (a) => severityRank(a.severity), render: (c, a) => sevCell(c, a.severity) },
      {
        key: 'source', title: 'Source', width: 86, sortKey: (a) => a.source,
        render: (cell, a) => {
          if (cell.dataset.src === a.source) return;
          cell.dataset.src = a.source;
          cell.textContent = '';
          const wrap = h(`span.src${a.source === 'deviation' ? '.dev' : ''}`);
          if (a.source === 'deviation') wrap.append(svg(connIcons.deviation));
          wrap.append(h('span.ct', { text: alarmSourceLabel(a.source) }));
          cell.append(wrap);
        },
      },
      { key: 'assetId', title: 'Asset', width: 66 },
      { key: 'message', title: 'Message', width: 300 },
      { key: 'value', title: 'Value', width: 60, align: 'right', text: (a) => (a.value === undefined ? '' : formatNum(a.value, 2)), sortKey: (a) => a.value },
      { key: 'limit', title: 'Limit / pred.', width: 74, align: 'right', text: (a) => (a.limit === undefined ? '' : formatNum(a.limit, 2)), sortKey: (a) => a.limit },
      { key: 'ack', title: 'Ack', width: 44, text: (a) => (a.acknowledged ? 'yes' : 'no') },
      { key: 'id', title: 'Alarm Id', width: 170, mono: true },
    ],
  });
  const alMoreBtn = button({ text: 'Load older', small: true, title: `Fetch ${PAGE} more alarms`, onClick: () => { alLimit += PAGE; void loadAlarms(); } });
  const applyAl = () => {
    alRows = alAll.filter((a) => alarmMatches(a, alText, alSrc, alSev));
    alGrid.setRows(alRows);
    const all = alAll.length < alLimit;
    setText(alCount, `${alRows.length} shown / ${alAll.length} loaded${all ? ' (all)' : ''}`);
    alMoreBtn.disabled = all;
  };
  const loadAlarms = async () => {
    setText(alErr, '');
    alMoreBtn.disabled = true;
    try { alAll = await api.historyAlarms(alLimit); applyAl(); } catch (e) { setText(alErr, `Could not load alarms: ${errText(e)}`); alMoreBtn.disabled = false; }
  };
  const alSrcCombo = new ComboBox<AlarmSource | 'all'>({ items: ALARM_SOURCE_ITEMS, value: 'all', width: 124, onChange: (v) => { alSrc = v; applyAl(); } });
  const alSevCombo = new ComboBox<Severity | 'all'>({ items: SEV_ITEMS, value: 'all', width: 124, onChange: (v) => { alSev = v; applyAl(); } });
  const alPage = h('div.cx-page', null,
    h('div.dlg-row', null, svg(icons.filter), filterField('Filter (text, asset, sensor)', (v) => { alText = v; applyAl(); }), alSrcCombo.el, alSevCombo.el, h('span.grow'), alMoreBtn),
    h('div.cx-grid', null, alGrid.el),
    h('div.dlg-row', null, alCount, h('span.grow'), alErr));

  // ---------------- dialog ----------------
  const tabs = new TabStrip([{ id: 'events', label: 'Events', icon: 'info' }, { id: 'alarms', label: 'Alarms', icon: 'warning' }], () => { evGrid.refresh(); alGrid.refresh(); });
  tabs.page('events').append(evPage);
  tabs.page('alarms').append(alPage);
  tabs.el.classList.add('cx-tabs');
  const body = h('div.cx-dlg', { style: 'width:820px' }, tabs.el,
    h('p.dlg-note', { text: `Read from the persistent store (${ctx.source.kind === 'mock' ? 'demo: in-memory' : '/api/history'}), newest first. Filters apply to the loaded rows; Export CSV writes exactly the rows shown.` }));
  tabs.activate('events');

  const dlg = Dialog.open({
    title: 'Event History', icon: 'info', body, width: 848,
    onClose: () => { evGrid.dispose(); alGrid.dispose(); },
    buttons: [
      { id: 'reload', text: 'Reload', left: true, onClick: () => { void loadEvents(true); void loadAlarms(); return false; } },
      {
        id: 'csv', text: 'Export CSV', left: true,
        onClick: () => {
          if (tabs.active === 'alarms') {
            downloadText(`history_alarms_${stamp()}.csv`, toCsv(ALARM_CSV_COLUMNS, alRows));
            postStatus(`Exported ${alRows.length} alarms`, 'ok');
          } else {
            downloadText(`history_events_${stamp()}.csv`, toCsv(EVENT_CSV_COLUMNS, evRows));
            postStatus(`Exported ${evRows.length} events`, 'ok');
          }
          return false;
        },
      },
      { id: 'close', text: 'Close', isDefault: true, isCancel: true },
    ],
  });
  dlg.el.querySelector('.dt-icon')?.replaceWith(svg(connIcons.history, 'dt-icon'));
  void loadEvents(true);
  void loadAlarms();
  return dlg;
}
