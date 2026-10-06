// Event Log: virtualised grid of events with severity icons, a text filter, severity filter
// and auto-scroll that pauses while the user has scrolled up.
import type { EventRecord, Severity } from '../net/contracts';
import type { Panel, PanelFactory } from './panel';
import { DataGrid } from '../widgets/DataGrid';
import { ComboBox } from '../widgets/ComboBox';
import { checkbox } from '../widgets/GroupBox';
import { button } from '../widgets/Button';
import { h, svg, setText } from '../widgets/dom';
import { icons } from '../widgets/icons';
import { formatSimTime, severityRank } from '../shell/format';

/** Filter predicate (pure): text matches message/asset/kind, case-insensitive; minimum severity. */
export function eventMatches(e: EventRecord, text: string, minSev: Severity | 'all'): boolean {
  if (minSev !== 'all' && severityRank(e.severity) > severityRank(minSev)) return false;
  if (!text) return true;
  const t = text.toLowerCase();
  return e.message.toLowerCase().includes(t) || (e.assetId ?? '').toLowerCase().includes(t) || e.kind.includes(t);
}

const SEV_ICON = { info: icons.info, warning: icons.warning, critical: icons.critical } as const;

export const createEventLogPanel: PanelFactory = (ctx) => {
  const { store } = ctx;
  const offs: (() => void)[] = [];
  let grid: DataGrid<EventRecord>;
  let filterText = '';
  let minSev: Severity | 'all' = 'all';
  let clearedBefore = 0;
  let follow: HTMLInputElement;
  let count: HTMLSpanElement;
  let pendingRaf = 0;
  let userScrolledUp = false;

  const refresh = () => {
    pendingRaf = 0;
    const rows = store.events.filter((e) => e.id > clearedBefore && eventMatches(e, filterText, minSev));
    grid.setRows(rows);
    setText(count, `${rows.length} / ${store.events.length}`);
    if (follow.checked && !userScrolledUp) grid.scrollToBottom();
  };
  const schedule = () => { if (!pendingRaf) pendingRaf = requestAnimationFrame(refresh); };

  const panel: Panel = {
    id: 'events',
    title: 'Event Log',
    mount(host) {
      const root = h('div.panel-col');
      const filter = h('input.field', { type: 'text', placeholder: 'Filter (text, asset, kind)', spellcheck: 'false' });
      filter.style.width = '200px';
      filter.addEventListener('input', () => { filterText = filter.value.trim(); userScrolledUp = false; schedule(); });
      filter.addEventListener('keydown', (e) => { if (e.key === 'Escape') { filter.value = ''; filterText = ''; schedule(); } });
      const sev = new ComboBox<Severity | 'all'>({
        items: [{ value: 'all', label: 'All severities' }, { value: 'warning', label: 'Warning and above' }, { value: 'critical', label: 'Critical only' }],
        value: 'all', width: 130, onChange: (v) => { minSev = v; schedule(); },
      });
      const fol = checkbox('Auto-scroll', true);
      follow = fol.input;
      follow.addEventListener('change', () => { userScrolledUp = !follow.checked; schedule(); });
      count = h('span.count');
      const clr = button({ text: 'Clear', icon: 'clear', small: true, title: 'Hide events received so far (does not delete them on the server)', onClick: () => {
        clearedBefore = store.events[store.events.length - 1]?.id ?? clearedBefore;
        schedule();
      } });
      const fIcon = svg(icons.filter);
      fIcon.style.cssText = 'width:16px;height:16px;flex:none';
      const tb = h('div.panel-toolbar', null, fIcon, filter, sev.el, h('span.sep'), fol.el, h('span.grow'), count, clr);
      const body = h('div.panel-fill');
      grid = new DataGrid<EventRecord>({
        storageKey: 'svdtl.grid.events.v1',
        emptyText: '(no events)',
        rowId: (e) => String(e.id),
        rowClass: (e) => (e.severity === 'critical' ? 'ev-critical' : ''),
        onSelect: (e) => { if (e?.assetId) store.select(e.assetId); },
        columns: [
          { key: 'id', title: '#', width: 52, align: 'right', sortKey: (e) => e.id },
          { key: 'time', title: 'Sim time', width: 76, mono: true, text: (e) => formatSimTime(e.timeMs), sortKey: (e) => e.timeMs },
          {
            key: 'severity', title: 'Severity', width: 78, sortKey: (e) => severityRank(e.severity),
            render: (cell, e) => {
              if (cell.dataset.sev === e.severity) return;
              cell.dataset.sev = e.severity;
              cell.textContent = '';
              cell.append(svg(SEV_ICON[e.severity]), h('span.ct', { text: e.severity[0].toUpperCase() + e.severity.slice(1) }));
            },
          },
          { key: 'kind', title: 'Kind', width: 64 },
          { key: 'assetId', title: 'Asset', width: 70, text: (e) => e.assetId ?? '' },
          { key: 'message', title: 'Message', width: 520, cellClass: (e) => (e.severity === 'critical' ? 'tx-fault' : '') },
        ],
      });
      body.append(grid.el);
      root.append(tb, body);
      host.append(root);
      grid.el.querySelector('.dgrid-body')!.addEventListener('scroll', () => { userScrolledUp = !grid.isAtBottom(); }, { passive: true });
      offs.push(
        store.on('event', schedule),
        store.on('snapshot', () => { clearedBefore = 0; userScrolledUp = false; schedule(); }),
      );
      refresh();
    },
    resize() { grid?.refresh(); },
    dispose() {
      offs.splice(0).forEach((f) => f());
      cancelAnimationFrame(pendingRaf);
      grid?.dispose();
    },
  };
  return panel;
};
