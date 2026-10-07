// Connections (bottom tab): one row per external OPC UA / MQTT connection with an LED, bound tag
// count and a live "last value" age. Reconnect calls POST /api/connections/{id}/reconnect.
import type { ConnectionStatus } from '../net/contracts';
import type { Panel, PanelFactory } from '../panels/panel';
import { DataGrid } from '../widgets/DataGrid';
import { button } from '../widgets/Button';
import { Led } from '../widgets/Led';
import { h, svg, setText } from '../widgets/dom';
import { postStatus } from '../shell/status';
import { connectedTwinApi } from './api';
import { connIcons } from './icons';
import {
  ValueAgeTracker, connectionKindLabel, connectionLed, connectionStatusLabel, connectionsSummary, formatAge, sortConnections,
} from './logic';

/** Age above which the "last value" cell is highlighted (contract: tags older than 5 s are stale). */
const STALE_MS = 5000;

const EXAMPLE = `"connections": [
  { "id": "plc1", "kind": "opcua", "endpoint": "opc.tcp://localhost:4840/twinlabs" }
],
"bindings": [
  { "target": "sensor:CNC-01.temp", "connectionId": "plc1", "address": "ns=2;s=LineA.CNC-01.Temp" }
]`;

export const createConnectionsPanel: PanelFactory = (ctx) => {
  const { store, source } = ctx;
  const api = connectedTwinApi(source);
  const ages = new ValueAgeTracker();
  const leds = new WeakMap<HTMLElement, Led>();
  const offs: (() => void)[] = [];
  let grid: DataGrid<ConnectionStatus>;
  let summary: HTMLSpanElement;
  let reconnectBtn: HTMLButtonElement;
  let empty: HTMLDivElement;
  let timer = 0;
  let raf = 0;

  const ageOf = (c: ConnectionStatus) => ages.ageMs(c.id, performance.now());

  const observeAll = () => {
    const now = performance.now();
    for (const c of store.connections.values()) ages.observe(c, store.sim, now);
  };

  const refresh = () => {
    raf = 0;
    const rows = sortConnections(store.connections.values());
    grid.setRows(rows);
    setText(summary, connectionsSummary(rows));
    empty.style.display = rows.length ? 'none' : '';
    const sel = grid.selection ? store.connections.get(grid.selection) : undefined;
    reconnectBtn.disabled = !sel || sel.status === 'connecting' || sel.status === 'disabled';
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(refresh); };

  const reconnect = async (c: ConnectionStatus | undefined) => {
    if (!c) return;
    reconnectBtn.disabled = true;
    try {
      const st = await api.reconnect(c.id);
      // Apply the REST answer like a WS frame so the grid updates even if the frame is late.
      store.apply({ type: 'connection', t: store.sim.simTimeMs, seq: store.lastSeq, data: st });
      postStatus(`Reconnecting ${c.id} (${c.endpoint})…`, 'ok');
    } catch (e) {
      postStatus(`Reconnect ${c.id} failed: ${(e as Error)?.message ?? e}`, 'error');
    } finally {
      schedule();
    }
  };

  const reload = async (manual: boolean) => {
    try {
      const list = await api.connections();
      for (const c of list) store.apply({ type: 'connection', t: store.sim.simTimeMs, seq: store.lastSeq, data: c });
      if (manual) postStatus(`${list.length} connection(s) loaded`, 'ok');
    } catch (e) {
      if (manual) postStatus(`Could not load connections: ${(e as Error)?.message ?? e}`, 'error');
    }
  };

  const panel: Panel = {
    id: 'connections',
    title: 'Connections',
    mount(host) {
      const root = h('div.panel-col');
      reconnectBtn = button({ text: 'Reconnect', small: true, title: 'Drop and re-open the selected connection', onClick: () => void reconnect(grid.selection ? store.connections.get(grid.selection) : undefined) });
      reconnectBtn.prepend(svg(connIcons.reconnect));
      const refreshBtn = button({ text: 'Refresh', small: true, title: 'Reload the list (GET /api/connections)', onClick: () => void reload(true) });
      summary = h('span.count');
      const tb = h('div.panel-toolbar', null, reconnectBtn, refreshBtn, h('span.sep'), summary, h('span.grow'),
        h('span.dim', { text: 'Values older than 5 s are stale; shadow mode then falls back to the prediction', style: 'padding-right:4px' }));
      const body = h('div.panel-fill');
      grid = new DataGrid<ConnectionStatus>({
        storageKey: 'svdtl.grid.connections.v1',
        emptyText: '',
        rowId: (c) => c.id,
        onSelect: () => schedule(),
        onActivate: (c) => void reconnect(c),
        initialSort: null,
        columns: [
          {
            key: 'status', title: 'Status', width: 104, sortKey: (c) => ['error', 'connecting', 'connected', 'disabled'].indexOf(c.status),
            render: (cell, c) => {
              let led = leds.get(cell);
              if (!led) { led = new Led('off', { square: false }); leds.set(cell, led); cell.append(led.el, h('span.ct')); }
              const l = connectionLed(c.status);
              led.set(l.led, l.blink);
              const t = cell.querySelector<HTMLSpanElement>('.ct')!;
              setText(t, connectionStatusLabel(c.status));
              const cls = c.status === 'error' ? 'ct tx-fault' : 'ct';
              if (t.className !== cls) t.className = cls;
            },
          },
          { key: 'id', title: 'Id', width: 90, mono: true },
          { key: 'kind', title: 'Kind', width: 62, text: (c) => connectionKindLabel(c.kind) },
          { key: 'endpoint', title: 'Endpoint', width: 250, mono: true },
          { key: 'boundTags', title: 'Bound tags', width: 74, align: 'right', sortKey: (c) => c.boundTags },
          {
            key: 'age', title: 'Last value', width: 118, align: 'right', sortable: true,
            text: (c) => (c.status === 'disabled' ? '—' : formatAge(ageOf(c))),
            sortKey: (c) => ageOf(c) ?? Number.MAX_SAFE_INTEGER,
            cellClass: (c) => { const a = ageOf(c); return c.status === 'connected' && a !== null && a > STALE_MS ? 'tx-stale' : ''; },
            tooltip: 'Wall-clock age of the last tag value received on this connection',
          },
          { key: 'error', title: 'Error', width: 320, text: (c) => c.error ?? '', cellClass: (c) => (c.error ? 'tx-fault' : '') },
        ],
      });
      empty = h('div.conn-empty');
      const box = h('div.box');
      box.append(svg(connIcons.plug), h('div', null,
        h('b', { text: 'No external connections' }),
        h('span', { text: 'The loaded plant has no "connections". Add OPC UA or MQTT connections and tag "bindings" to the plant model (see contracts/plant/sample_line.connected.json), reload the plant, then switch the toolbar to Shadow to mirror the real line.' }),
        h('pre', { text: EXAMPLE })));
      empty.append(box);
      body.append(grid.el, empty);
      root.append(tb, body);
      host.append(root);

      offs.push(
        store.on('connectionStatus', (c) => { ages.observe(c, store.sim, performance.now()); schedule(); }),
        store.on('snapshot', () => { ages.clear(); observeAll(); schedule(); }),
      );
      observeAll();
      refresh();
      // Live ages: repaint the visible rows twice a second (cheap; rows are recycled).
      timer = window.setInterval(() => { if (store.connections.size) grid.refresh(); }, 500);
      if (source.kind === 'live') void reload(false);
    },
    resize() { grid?.refresh(); },
    dispose() {
      offs.splice(0).forEach((f) => f());
      clearInterval(timer);
      cancelAnimationFrame(raf);
      grid?.dispose();
    },
  };
  return panel;
};
