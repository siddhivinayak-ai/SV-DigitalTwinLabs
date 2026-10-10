// Plant Builder entry points, wired into the console by one call from main.ts:
// ToolStrip "Plant Builder" button, File → Plant Builder… (Ctrl+B), New Plant, Open Template…,
// Open Layout…, and the ?builder=1 dev hook (opens the builder on load, for screenshots).
import './builder.css';
import type { PanelContext } from '../panels/panel';
import type { PlantModel } from '../net/contracts';
import type { MenuEntry } from '../widgets/Menu';
import { h, svg } from '../widgets/dom';
import { PopupMenu } from '../widgets/Menu';
import { BuilderWindow } from './BuilderWindow';
import { bicons } from './icons';
import { newPlant } from './model';

/** The two shell extension points the builder needs (see Shell.extendFileMenu / addToolItems). */
export interface BuilderHost {
  extendFileMenu(items: MenuEntry[]): void;
  addToolItems(...els: HTMLElement[]): void;
}

let current: BuilderWindow | null = null;

export function registerBuilderUi(host: BuilderHost, ctx: PanelContext): void {
  const open = (start?: 'new' | 'template' | 'layout'): BuilderWindow => {
    if (current?.isOpen) {
      current.focus();
    } else {
      const live = ctx.store.plant;
      const plant: PlantModel = start === 'new' || !live ? newPlant() : (JSON.parse(JSON.stringify(live)) as PlantModel);
      current = new BuilderWindow(ctx, plant, start === 'new' || !live ? 'New' : 'Current plant');
      current.onClosed = () => { current = null; };
      current.mount();
    }
    const w = current;
    if (start === 'new' && w.editor.doc.origin !== 'New') void w.cmdNew();
    if (start === 'template') void w.cmdOpenTemplate();
    if (start === 'layout') void w.cmdOpenLayout();
    return w;
  };

  const btn = h('button.tool-btn', { type: 'button', title: 'Plant Builder: design the plant layout (Ctrl+B)' });
  btn.append(svg(bicons.builder), h('span.tb-text', { text: 'Plant Builder' }));
  btn.addEventListener('click', () => open());
  host.addToolItems(h('span.sep'), btn);

  host.extendFileMenu([
    { label: '&Plant Builder…', accel: 'Ctrl+B', action: () => open() },
    { label: '&New Plant', action: () => open('new') },
    { label: 'Open &Template…', action: () => open('template') },
    { label: '&Open Layout…', action: () => open('layout') },
    'sep',
  ]);

  document.addEventListener('keydown', (e) => {
    if (PopupMenu.isOpen || document.querySelector('.dialog')) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      open();
    }
  });

  // Dev hook: ?builder=1 opens the builder once the first snapshot (or 2 s) has arrived.
  if (new URLSearchParams(location.search).get('builder') === '1') {
    let done = false;
    const go = () => { if (!done) { done = true; (window as unknown as { __svdtlBuilder?: BuilderWindow }).__svdtlBuilder = open(); } };
    const off = ctx.store.on('snapshot', () => { off(); setTimeout(go, 50); });
    setTimeout(go, 2000);
  }
}
