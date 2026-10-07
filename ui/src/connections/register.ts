// v0.2 Connected Twin: everything the shell needs, in small pieces so each integration point
// in Shell.ts is a single line (see the report for the exact edits).
import type { PanelContext } from '../panels/panel';
import type { MenuEntry } from '../widgets/Menu';
import type { Scenario } from '../net/contracts';
import { h } from '../widgets/dom';
import { postStatus } from '../shell/status';
import { openWhatIfDialog } from '../dialogs/WhatIfDialog';
import { createConnectionsPanel } from './ConnectionsPanel';
import { TwinModeController, createModeSegment, createModeToggle } from './TwinMode';
import { openScenarioListDialog } from './ScenarioDialogs';
import { openHistoryDialog } from './HistoryDialog';
import './connections.css';

/** Bottom-tab spec for DockLayout: `connectionsTab(ctx)` in the bottom `tabs` array. */
export function connectionsTab(ctx: PanelContext) {
  return { id: 'connections', label: 'Connections', icon: 'link' as const, panel: createConnectionsPanel(ctx) };
}

export interface ConnectionsUi {
  mode: TwinModeController;
  /** Menu entries to splice into the shell's menus. */
  menus: { view: MenuEntry[]; simulation: MenuEntry[]; analysis: MenuEntry[] };
}

const online = (ctx: PanelContext) => ctx.store.connection === 'connected' || ctx.store.connection === 'mock';

/** Open a saved scenario in a new What-If dialog (optionally re-running it). */
function openSaved(ctx: PanelContext, scenario: Scenario, rerun: boolean): void {
  if (!online(ctx)) { postStatus('Not connected to the twin server', 'error'); return; }
  openWhatIfDialog(ctx, { scenario, rerun });
}

export function openSavedScenarios(ctx: PanelContext): void {
  openScenarioListDialog(ctx, { open: (s) => openSaved(ctx, s, false), rerun: (s) => openSaved(ctx, s, true) });
}

/**
 * Mount the v0.2 UI into an existing shell: the [Simulate | Shadow] group after the speed combo,
 * the SIM/SHADOW status segment before the run-state segment, and store wiring.
 * `showTab` opens a bottom tab (DockLayout.showTab).
 */
export function registerConnectionsUi(ctx: PanelContext, parts: {
  toolStrip: HTMLElement; statusBar: HTMLElement; showTab: (id: string) => void; activeTab: () => string | null;
}): ConnectionsUi {
  const { store } = ctx;
  const mode = new TwinModeController(ctx);
  const toggle = createModeToggle(mode);
  const seg = createModeSegment(mode);

  // Tool strip: "... Speed [1×] | [Simulate|Shadow] | Inject Fault ..."
  const speedCombo = parts.toolStrip.querySelector('.combo');
  const group = [h('span.sep'), toggle.el];
  if (speedCombo) speedCombo.after(...group); else parts.toolStrip.append(...group);

  // Status bar: "... | 10× | SIM | ● RUNNING | ..."
  const runSeg = parts.statusBar.querySelector('.sb-seg.run');
  if (runSeg) runSeg.before(seg.el); else parts.statusBar.append(seg.el);
  seg.el.addEventListener('dblclick', () => parts.showTab('connections'));

  let lastMode = store.sim.mode;
  const sync = () => {
    toggle.update();
    seg.update();
    if (store.sim.mode !== lastMode) {
      lastMode = store.sim.mode;
      postStatus(lastMode === 'shadow' ? 'SHADOW mode: external tags drive the twin; deviation alarms armed' : 'SIMULATE mode: the engine drives the twin', 'ok');
    }
  };
  store.on('tick', sync);
  store.on('snapshot', () => { lastMode = store.sim.mode; sync(); });
  store.on('connection', sync);

  const menus = {
    view: [
      { label: 'Co&nnections', radio: true, checked: () => parts.activeTab() === 'connections', action: () => parts.showTab('connections') },
    ] as MenuEntry[],
    simulation: [
      'sep',
      {
        label: 'T&win Mode', disabled: () => !online(ctx),
        submenu: () => [
          { label: '&Simulate (engine drives)', radio: true, checked: store.sim.mode !== 'shadow', action: () => void mode.set('simulate') },
          { label: 'S&hadow (external tags drive)', radio: true, checked: store.sim.mode === 'shadow', action: () => void mode.set('shadow') },
        ],
      },
      { label: 'Show C&onnections', action: () => parts.showTab('connections') },
    ] as MenuEntry[],
    analysis: [
      { label: 'Sa&ved Scenarios…', action: () => openSavedScenarios(ctx) },
      { label: 'Event &History…', action: () => openHistoryDialog(ctx) },
    ] as MenuEntry[],
  };
  return { mode, menus };
}
