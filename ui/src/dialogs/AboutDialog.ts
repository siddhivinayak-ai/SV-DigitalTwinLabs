// Help → About and Help → Keyboard Shortcuts.
import type { PanelContext } from '../panels/panel';
import { Dialog } from '../widgets/Dialog';
import { h } from '../widgets/dom';
import { SHORTCUTS } from '../shell/keyboard';

export const APP_VERSION = '0.1.0';

export function openAboutDialog(ctx: PanelContext): Dialog {
  const { store, source } = ctx;
  const plant = store.plant;
  const kv = (k: string, v: string) => [h('span', { text: k }), h('span', { text: v })];
  const body = h('div.about', null,
    h('div.logo', { text: 'SV' }),
    h('div', null,
      h('h1', { text: 'SV TwinLabs — Line A Console' }),
      h('p', { text: 'Operations console for the SV-DigitalTwinLabs factory digital twin: live line state, fault injection, OEE analytics and what-if scenarios.' }),
      h('div.kv', null,
        ...kv('Version', APP_VERSION),
        ...kv('Wire contract', 'v1'),
        ...kv('Data source', source.kind === 'mock' ? 'Demo (in-browser mock)' : 'Live server (WebSocket /ws)'),
        ...kv('Plant', plant ? `${plant.name} (v${plant.version})` : '—'),
        ...kv('Assets / sensors', plant ? `${plant.assets.length} / ${plant.sensors.length}` : '—'),
        ...kv('Seed', String(store.sim.seed || plant?.seed || '—'))),
      h('div.sunken', null,
        h('div', { text: 'MIT License. Copyright (c) 2026 Siddhivinayak Waghmode.' }),
        h('div', { text: 'Built with Vite and TypeScript. 3D view: three.js (MIT). Plots: uPlot (MIT).' }),
        h('div', { text: 'Status colours follow ISA-101: grey is normal, colour means abnormal or active.' }))));
  return Dialog.open({ title: 'About SV TwinLabs', icon: 'about', body, buttons: [{ id: 'ok', text: 'OK', isDefault: true, isCancel: true }] });
}

export function openShortcutsDialog(): Dialog {
  const tb = h('tbody');
  for (const s of SHORTCUTS) tb.append(h('tr', null, h('td', { text: s.keys }), h('td', { text: s.label })));
  const body = h('div', null, h('table.kbd-table', null, tb),
    h('p.dlg-note', { text: 'Ctrl+W is reserved by some browsers (close tab); use Analysis → What-If… if it does not reach the console.' }));
  body.style.width = '340px';
  return Dialog.open({ title: 'Keyboard Shortcuts', icon: 'keyboard', body, buttons: [{ id: 'ok', text: 'OK', isDefault: true, isCancel: true }] });
}
