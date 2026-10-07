// The console shell: menu bar, tool strip, dock layout, status bar, shortcuts, theme.
import type { PanelContext, Panel } from '../panels/panel';
import type { Theme } from '../state/store';
import { h, svg, storage } from '../widgets/dom';
import { icons } from '../widgets/icons';
import { button } from '../widgets/Button';
import { PopupMenu, type MenuEntry } from '../widgets/Menu';
import { messageBox } from '../widgets/Dialog';
import { MenuBar } from './MenuBar';
import { ToolStrip } from './ToolStrip';
import { StatusBar } from './StatusBar';
import { DockLayout, type ToggleablePane } from './DockLayout';
import { runCommand } from './actions';
import { postStatus } from './status';
import { shortcutFor, accelText, type ShortcutCommand } from './keyboard';
import { SPEEDS, formatSpeed, formatSimClock } from './format';
import { historyToCsv, downloadText, downloadUrl } from './exportCsv';
import { alarmSummary } from '../panels/AlarmsPanel';
import { openInjectFaultDialog } from '../dialogs/InjectFaultDialog';
import { openWhatIfDialog } from '../dialogs/WhatIfDialog';
import { openAboutDialog, openShortcutsDialog } from '../dialogs/AboutDialog';
import { createPlantTreePanel } from '../panels/PlantTreePanel';
import { createPropertiesPanel } from '../panels/PropertiesPanel';
import { createEventLogPanel } from '../panels/EventLogPanel';
import { createAlarmsPanel } from '../panels/AlarmsPanel';
import { createDataGridPanel } from '../panels/DataGridPanel';
import { createViewportPanel } from '../viewport/ViewportPanel';
import { createTrendsPanel } from '../panels/TrendsPanel';
import { createKpiPanel } from '../panels/KpiPanel';

export const THEME_KEY = 'svdtl.theme';

export interface ShellOptions {
  /** Switch data source (reloads the page). */
  switchSource(kind: 'live' | 'mock'): void;
  /** Live only: retry now. */
  reconnect?(): void;
  /** Live only: extra status text such as "retry in 3 s". */
  connDetail?(): string;
}

export class Shell {
  readonly el: HTMLDivElement;
  private readonly tool: ToolStrip;
  private readonly status: StatusBar;
  private readonly dock: DockLayout;
  private readonly infoHost: HTMLDivElement;
  private infobar: HTMLDivElement | null = null;

  constructor(private readonly ctx: PanelContext, private readonly opt: ShellOptions) {
    const { store, source } = ctx;
    this.el = h('div.shell');

    const brand = h('span.brand', null, h('b', { text: 'SV TwinLabs' }), ` · ${source.kind === 'mock' ? 'Demo' : 'Live'}`);
    const menu = new MenuBar(this.menus(), brand);
    this.tool = new ToolStrip(store, {
      start: () => this.cmd('start'),
      pause: () => this.cmd('pause'),
      stop: () => this.cmd('stop'),
      reset: () => this.cmd('reset'),
      speed: (v) => void runCommand(source, { action: 'sim.speed', value: v }),
      injectFault: () => this.cmd('injectFault'),
      whatIf: () => this.cmd('whatIf'),
      exportCsv: () => this.cmd('export'),
      toggleTheme: () => this.cmd('theme'),
    });
    this.infoHost = h('div');

    const panel = (f: (c: PanelContext) => Panel) => f(ctx);
    this.dock = new DockLayout({
      left: { title: 'Plant Explorer', icon: 'line', panel: panel(createPlantTreePanel) },
      center: { title: '3D Viewport', icon: 'machine', panel: panel(createViewportPanel), closable: false },
      bottom: {
        title: 'Trends', icon: 'vibration',
        tabs: [
          { id: 'trends', label: 'Trends', icon: 'vibration', panel: panel(createTrendsPanel) },
          { id: 'events', label: 'Event Log', icon: 'info', panel: panel(createEventLogPanel) },
          { id: 'alarms', label: 'Alarms', icon: 'warning', panel: panel(createAlarmsPanel) },
          { id: 'grid', label: 'Data Grid', icon: 'count', panel: panel(createDataGridPanel) },
        ],
      },
      rightTop: { title: 'Properties', icon: 'layout', panel: panel(createPropertiesPanel) },
      rightBottom: { title: 'KPIs', icon: 'speed', panel: panel(createKpiPanel) },
    });
    this.status = new StatusBar(store);
    this.status.connDetail = opt.connDetail ?? null;
    this.status.onAlarmClick(() => this.dock.showTab('alarms'));

    this.el.append(menu.el, this.tool.el, this.infoHost, this.dock.el, this.status.el);

    // ---- store wiring (cheap in-place updates) ----
    store.on('tick', () => { this.status.update(); this.tool.update(); });
    store.on('snapshot', () => { this.status.update(); this.tool.update(); this.status.updateAlarms(); this.updateAlarmBadge(); this.updateTitles(); });
    store.on('connection', () => { this.status.updateConnection(); this.tool.update(); });
    store.on('alarm', () => { this.status.updateAlarms(); this.updateAlarmBadge(); });
    store.on('selection', () => { this.tool.update(); this.updateTitles(); });
    store.on('theme', (t) => this.tool.setTheme(t === 'dark'));
    this.tool.setTheme(store.theme === 'dark');

    document.addEventListener('keydown', (e) => this.onShortcut(e));
  }

  /** Attach to the page and mount panels. */
  attach(parent: HTMLElement): void {
    parent.append(this.el);
    this.dock.mountAll();
    this.updateAlarmBadge();
    this.updateTitles();
  }

  /** Non-blocking info bar under the tool strip. */
  showInfoBar(text: string, actions: { text: string; onClick: () => void }[]): void {
    this.hideInfoBar();
    const bar = h('div.infobar', { role: 'alert' });
    bar.append(svg(icons.warning), h('span.ib-text', { text }));
    for (const a of actions) bar.append(button({ text: a.text, small: true, onClick: a.onClick }));
    const x = h('button.title-btn', { type: 'button', title: 'Dismiss' });
    x.append(svg(icons.close));
    x.addEventListener('click', () => this.hideInfoBar());
    bar.append(x);
    this.infoHost.append(bar);
    this.infobar = bar;
  }

  hideInfoBar(): void { this.infobar?.remove(); this.infobar = null; }

  setTheme(t: Theme): void {
    this.ctx.store.setTheme(t);
    storage.set(THEME_KEY, t);
    postStatus(t === 'dark' ? 'Control Room theme' : 'Light theme');
  }

  // ---------- commands ----------

  private cmd(c: ShortcutCommand): void {
    const { store, source } = this.ctx;
    const online = store.connection === 'connected' || store.connection === 'mock';
    const needOnline = () => { if (!online) postStatus('Not connected to the twin server', 'error'); return online; };
    switch (c) {
      case 'start': if (needOnline()) void runCommand(source, { action: 'sim.start' }); break;
      case 'pause': if (needOnline()) void runCommand(source, { action: 'sim.pause' }); break;
      case 'stop': if (needOnline()) void runCommand(source, { action: 'sim.stop' }); break;
      case 'reset': if (needOnline()) void runCommand(source, { action: 'sim.reset' }); break;
      case 'injectFault': if (needOnline()) openInjectFaultDialog(this.ctx, store.selection); break;
      case 'whatIf': if (needOnline()) openWhatIfDialog(this.ctx); break;
      case 'export': this.exportCsv(); break;
      case 'theme': this.setTheme(store.theme === 'dark' ? 'light' : 'dark'); break;
      case 'help': openShortcutsDialog(); break;
    }
  }

  private exportCsv(seconds = 3600): void {
    const { store, source } = this.ctx;
    const url = source.exportCsvUrl(seconds);
    const stamp = formatSimClock(store.sim.simTimeMs).replace(/[:.]/g, '');
    if (url) {
      downloadUrl(url, `lineA_${stamp}.csv`);
      postStatus(`Exporting last ${seconds / 60} min of sensor history…`, 'ok');
      return;
    }
    if (!store.plant) return;
    const ids = store.plant.sensors.map((s) => s.id);
    const since = store.sim.simTimeMs / 1000 - seconds;
    const csv = historyToCsv(ids, (id) => store.getHistory(id), since);
    downloadText(`lineA_demo_${stamp}.csv`, csv);
    postStatus(`Exported ${csv.split('\n').length - 2} samples × ${ids.length} sensors (client-side history)`, 'ok');
  }

  private exportEvents(): void {
    const rows = this.ctx.store.events.map((e) =>
      [e.id, e.timeMs, e.severity, e.kind, e.assetId ?? '', `"${e.message.replace(/"/g, '""')}"`].join(','));
    downloadText('lineA_events.csv', ['id,timeMs,severity,kind,assetId,message', ...rows].join('\n') + '\n');
    postStatus(`Exported ${rows.length} events`, 'ok');
  }

  private onShortcut(e: KeyboardEvent): void {
    if (PopupMenu.isOpen || document.querySelector('.dialog')) return;
    const c = shortcutFor(e);
    if (c) {
      e.preventDefault();
      e.stopPropagation();
      this.cmd(c);
      return;
    }
    if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input')) this.ctx.store.select(null);
  }

  private updateAlarmBadge(): void {
    const s = alarmSummary(this.ctx.store.alarms.values());
    this.dock.tabs.setBadge('alarms', s.active ? String(s.active) : null, s.top === 'info' ? null : s.top, s.unacked > 0 && s.top === 'critical');
  }

  private updateTitles(): void {
    const { store } = this.ctx;
    const def = store.selection ? store.assetDef(store.selection) : undefined;
    this.dock.setSubtitle('rightTop', def ? def.id : '');
    this.dock.setSubtitle('center', store.plant?.name ?? '');
  }

  private selectedAction(action: 'asset.clearFault' | 'asset.maintenance' | 'asset.enable'): void {
    const { store, source } = this.ctx;
    const id = store.selection;
    if (!id) { postStatus('Select an asset first', 'error'); return; }
    const st = store.assets.get(id)?.state;
    if (action === 'asset.maintenance') void runCommand(source, { action, assetId: id, value: st === 'maintenance' ? 0 : 1 });
    else if (action === 'asset.enable') void runCommand(source, { action, assetId: id, value: st === 'off' ? 1 : 0 });
    else void runCommand(source, { action, assetId: id });
  }

  // ---------- menus ----------

  private menus() {
    const { store, source } = this.ctx;
    const online = () => store.connection === 'connected' || store.connection === 'mock';
    const sel = () => (store.selection ? store.assets.get(store.selection) : undefined);
    const pane = (label: string, p: ToggleablePane): MenuEntry => ({
      label, checked: () => this.dock.isVisible(p), action: () => this.dock.setVisible(p, !this.dock.isVisible(p)),
    });
    const tab = (label: string, id: string): MenuEntry => ({
      label, radio: true, checked: () => this.dock.tabs.active === id && this.dock.isVisible('bottom'), action: () => this.dock.showTab(id),
    });
    return [
      {
        label: '&File',
        items: (): MenuEntry[] => [
          { label: '&Export Sensor History (CSV)…', accel: accelText('export'), disabled: () => !store.plant, action: () => this.cmd('export') },
          { label: 'Export E&vent Log (CSV)', disabled: () => !store.events.length, action: () => this.exportEvents() },
          'sep',
          { label: '&Reload Console', action: () => location.reload() },
        ],
      },
      {
        label: '&Edit',
        items: (): MenuEntry[] => [
          { label: 'Clear &Selection', accel: 'Esc', disabled: () => !store.selection, action: () => store.select(null) },
          { label: 'Select &Bottleneck', disabled: () => !store.kpi?.line.bottleneckAssetId, action: () => store.select(store.kpi!.line.bottleneckAssetId!) },
          'sep',
          { label: '&Copy Asset Id', disabled: () => !store.selection, action: () => { void navigator.clipboard?.writeText(store.selection!); postStatus(`Copied ${store.selection}`); } },
        ],
      },
      {
        label: '&View',
        items: (): MenuEntry[] => [
          pane('&Plant Explorer', 'left'),
          pane('P&roperties', 'rightTop'),
          pane('&KPIs', 'rightBottom'),
          pane('&Bottom Panel', 'bottom'),
          'sep',
          tab('&Trends', 'trends'),
          tab('&Event Log', 'events'),
          tab('&Alarms', 'alarms'),
          tab('&Data Grid', 'grid'),
          'sep',
          {
            label: 'T&heme', submenu: [
              { label: '&Light', radio: true, checked: () => store.theme === 'light', action: () => this.setTheme('light') },
              { label: '&Control Room (dark)', radio: true, checked: () => store.theme === 'dark', action: () => this.setTheme('dark') },
            ],
          },
          { label: 'Toggle T&heme', accel: accelText('theme'), action: () => this.cmd('theme') },
          'sep',
          { label: 'Reset &Layout', action: () => { this.dock.resetLayout(); postStatus('Layout reset'); } },
        ],
      },
      {
        label: '&Simulation',
        items: (): MenuEntry[] => [
          { label: '&Start', accel: 'F5', disabled: () => !online(), checked: () => store.sim.state === 'running', radio: true, action: () => this.cmd('start') },
          { label: '&Pause', accel: 'F6', disabled: () => !online(), checked: () => store.sim.state === 'paused', radio: true, action: () => this.cmd('pause') },
          { label: 'S&top', accel: 'Shift+F5', disabled: () => !online(), checked: () => store.sim.state === 'stopped', radio: true, action: () => this.cmd('stop') },
          { label: '&Reset', accel: 'Ctrl+Shift+R', disabled: () => !online(), action: () => this.cmd('reset') },
          'sep',
          {
            label: 'Spee&d', disabled: () => !online(),
            submenu: () => SPEEDS.map((s) => ({
              label: formatSpeed(s), radio: true, checked: store.sim.speed === s,
              action: () => void runCommand(source, { action: 'sim.speed', value: s }),
            })),
          },
          'sep',
          { label: '&Inject Fault…', accel: accelText('injectFault'), disabled: () => !online() || !store.plant, action: () => this.cmd('injectFault') },
          { label: '&Clear Fault', disabled: () => sel()?.state !== 'fault', action: () => this.selectedAction('asset.clearFault') },
          { label: '&Maintenance', checked: () => sel()?.state === 'maintenance', disabled: () => !sel(), action: () => this.selectedAction('asset.maintenance') },
          { label: '&Enabled', checked: () => !!sel() && sel()!.state !== 'off', disabled: () => !sel(), action: () => this.selectedAction('asset.enable') },
        ],
      },
      {
        label: '&Analysis',
        items: (): MenuEntry[] => [
          { label: '&What-If Scenario…', accel: accelText('whatIf'), disabled: () => !online() || !store.plant, action: () => this.cmd('whatIf') },
          'sep',
          { label: 'Go to &Bottleneck', disabled: () => !store.kpi?.line.bottleneckAssetId, action: () => store.select(store.kpi!.line.bottleneckAssetId!) },
          { label: 'Show &Alarms', action: () => this.dock.showTab('alarms') },
          { label: 'Show &Trends', action: () => this.dock.showTab('trends') },
          'sep',
          { label: '&Export CSV', accel: accelText('export'), disabled: () => !store.plant, action: () => this.cmd('export') },
        ],
      },
      {
        label: '&Tools',
        items: (): MenuEntry[] => [
          {
            label: '&Data Source', submenu: [
              { label: '&Live Server (/ws)', radio: true, checked: source.kind === 'live', action: () => source.kind !== 'live' && this.opt.switchSource('live') },
              { label: '&Demo Mode (in-browser mock)', radio: true, checked: source.kind === 'mock', action: () => source.kind !== 'mock' && this.opt.switchSource('mock') },
            ],
          },
          { label: '&Reconnect Now', disabled: () => source.kind !== 'live' || store.connection === 'connected' || !this.opt.reconnect, action: () => this.opt.reconnect?.() },
          'sep',
          {
            label: '&Acknowledge All Alarms', disabled: () => ![...store.alarms.values()].some((a) => !a.acknowledged),
            action: () => { for (const a of store.alarms.values()) if (!a.acknowledged) void source.command({ action: 'alarm.ack', alarmId: a.id }).catch(() => undefined); },
          },
          { label: 'Reset &Column Widths', action: () => { for (const k of ['events', 'alarms', 'assets']) storage.remove(`svdtl.grid.${k}.v1`); messageBox('Column Widths', 'Column widths were reset. They will apply after the console is reloaded.'); } },
        ],
      },
      {
        label: '&Help',
        items: (): MenuEntry[] => [
          { label: '&Keyboard Shortcuts', accel: 'F1', action: () => this.cmd('help') },
          'sep',
          { label: '&About SV TwinLabs…', action: () => openAboutDialog(this.ctx) },
        ],
      },
    ];
  }
}
