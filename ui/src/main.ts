// TEMPORARY bootstrap (Phase 0): a bare grid that mounts panels against the MockSource.
// feature/ui-shell replaces this with the full WinForms-style shell.
import './styles/tokens.css';
import { TwinStore } from './state/store';
import { MockSource } from './net/MockSource';
import type { PanelFactory } from './panels/panel';
import { createViewportPanel } from './viewport/ViewportPanel';
import { createTrendsPanel } from './panels/TrendsPanel';
import { createKpiPanel } from './panels/KpiPanel';

const store = new TwinStore();
const source = new MockSource(store);
const app = document.getElementById('app')!;
app.style.cssText = 'position:fixed;inset:0;display:grid;grid-template:1fr 260px / 1fr 300px;gap:4px;padding:4px;background:var(--c-window);font:var(--fs) var(--font-ui)';
document.body.style.margin = '0';

const factories: PanelFactory[] = [createViewportPanel, createKpiPanel, createTrendsPanel];
for (const f of factories) {
  const panel = f({ store, source });
  const host = document.createElement('div');
  host.style.cssText = 'position:relative;overflow:hidden;background:var(--c-panel);border:1px solid var(--c-border)';
  if (panel.id === 'trends') host.style.gridColumn = '1 / span 2';
  app.appendChild(host);
  panel.mount(host);
  new ResizeObserver(() => panel.resize?.(host.clientWidth, host.clientHeight)).observe(host);
}
source.connect();
