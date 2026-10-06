// Alarms: active alarms sorted by severity then time (newest first). Unacknowledged alarms
// blink (ISA-18.2 style); Ack acknowledges the selected alarm, Ack All the rest.
import type { Alarm } from '../net/contracts';
import type { Panel, PanelFactory } from './panel';
import { DataGrid } from '../widgets/DataGrid';
import { button } from '../widgets/Button';
import { h, setText } from '../widgets/dom';
import { formatNum, formatSimTime, severityRank } from '../shell/format';
import { runCommand } from '../shell/actions';
import { postStatus } from '../shell/status';

/** Severity (critical first), then newest first, then id (pure). */
export function sortAlarms(alarms: Iterable<Alarm>): Alarm[] {
  return [...alarms].sort((a, b) =>
    severityRank(a.severity) - severityRank(b.severity) || b.raisedAtMs - a.raisedAtMs || a.id.localeCompare(b.id));
}

/** Summary used by the tab badge and status bar (pure). */
export function alarmSummary(alarms: Iterable<Alarm>): { active: number; unacked: number; top: Alarm['severity'] | null; topUnacked: boolean } {
  let active = 0, unacked = 0;
  let top: Alarm['severity'] | null = null;
  let topUnacked = false;
  for (const a of alarms) {
    if (!a.active) continue;
    active++;
    if (!a.acknowledged) unacked++;
    if (top === null || severityRank(a.severity) < severityRank(top)) { top = a.severity; topUnacked = !a.acknowledged; }
    else if (a.severity === top && !a.acknowledged) topUnacked = true;
  }
  return { active, unacked, top, topUnacked };
}

export const createAlarmsPanel: PanelFactory = (ctx) => {
  const { store, source } = ctx;
  const offs: (() => void)[] = [];
  let grid: DataGrid<Alarm>;
  let ackBtn: HTMLButtonElement, ackAllBtn: HTMLButtonElement;
  let summary: HTMLSpanElement;
  let raf = 0;

  const refresh = () => {
    raf = 0;
    const rows = sortAlarms(store.alarms.values());
    grid.setRows(rows);
    const s = alarmSummary(rows);
    setText(summary, s.active ? `${s.active} active · ${s.unacked} unacknowledged` : 'No active alarms');
    ackAllBtn.disabled = s.unacked === 0;
    const sel = grid.selection ? store.alarms.get(grid.selection) : undefined;
    ackBtn.disabled = !sel || sel.acknowledged;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(refresh); };

  const ack = async (a: Alarm | undefined) => {
    if (!a || a.acknowledged) return;
    await runCommand(source, { action: 'alarm.ack', alarmId: a.id });
  };

  const panel: Panel = {
    id: 'alarms',
    title: 'Alarms',
    mount(host) {
      const root = h('div.panel-col');
      ackBtn = button({ text: 'Ack', icon: 'ack', small: true, title: 'Acknowledge the selected alarm', onClick: () => ack(grid.selection ? store.alarms.get(grid.selection) : undefined) });
      ackAllBtn = button({ text: 'Ack All', icon: 'ackAll', small: true, title: 'Acknowledge all unacknowledged alarms', onClick: async () => {
        const list = [...store.alarms.values()].filter((a) => !a.acknowledged);
        const acks = await Promise.all(list.map((a) => source.command({ action: 'alarm.ack', alarmId: a.id }).catch(() => ({ ok: false }))));
        const bad = acks.filter((a) => !a.ok).length;
        postStatus(bad ? `Acknowledged ${list.length - bad} of ${list.length} alarms` : `Acknowledged ${list.length} alarm(s)`, bad ? 'error' : 'ok');
      } });
      summary = h('span.count');
      const tb = h('div.panel-toolbar', null, ackBtn, ackAllBtn, h('span.sep'), summary, h('span.grow'),
        h('span.dim', { text: 'Blinking = unacknowledged · double-click to acknowledge', style: 'padding-right:4px' }));
      const body = h('div.panel-fill');
      grid = new DataGrid<Alarm>({
        storageKey: 'svdtl.grid.alarms.v1',
        emptyText: 'No active alarms — the line is operating within limits.',
        rowId: (a) => a.id,
        rowClass: (a) => (a.acknowledged ? 'acked' : `unack unack-${a.severity}`),
        onSelect: (a) => { if (a) store.select(a.assetId); schedule(); },
        onActivate: (a) => void ack(a),
        columns: [
          {
            key: 'severity', title: 'Severity', width: 78, align: 'center', sortKey: (a) => severityRank(a.severity),
            render: (cell, a) => {
              let chip = cell.firstElementChild as HTMLSpanElement | null;
              if (!chip) { chip = h('span.sevchip'); cell.append(chip); }
              const cls = `sevchip sev-${a.severity}`;
              if (chip.className !== cls) chip.className = cls;
              setText(chip, a.severity.toUpperCase());
            },
          },
          { key: 'raisedAtMs', title: 'Raised', width: 72, mono: true, text: (a) => formatSimTime(a.raisedAtMs), sortKey: (a) => a.raisedAtMs },
          { key: 'assetId', title: 'Asset', width: 70 },
          { key: 'source', title: 'Source', width: 62 },
          { key: 'message', title: 'Message', width: 300 },
          { key: 'value', title: 'Value', width: 64, align: 'right', text: (a) => (a.value === undefined ? '' : formatNum(a.value, 2)), sortKey: (a) => a.value },
          { key: 'limit', title: 'Limit', width: 58, align: 'right', text: (a) => (a.limit === undefined ? '' : formatNum(a.limit, 2)), sortKey: (a) => a.limit },
          { key: 'ack', title: 'State', width: 66, text: (a) => (a.acknowledged ? 'ACKED' : 'UNACK'), cellClass: (a) => (a.acknowledged ? 'dim' : 'tx-fault') },
          { key: 'id', title: 'Alarm Id', width: 160, mono: true },
        ],
      });
      body.append(grid.el);
      root.append(tb, body);
      host.append(root);
      offs.push(store.on('alarm', schedule), store.on('snapshot', schedule));
      refresh();
    },
    resize() { grid?.refresh(); },
    dispose() {
      offs.splice(0).forEach((f) => f());
      cancelAnimationFrame(raf);
      grid?.dispose();
    },
  };
  return panel;
};
