// SV TwinLabs web console bootstrap.
// ?source=mock → in-browser MockSource (DEMO). Otherwise the live TwinClient (same-origin /ws).
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/layout.css';
import './styles/grids.css';
import './styles/panels.css';
import './styles/dialogs.css';
import { TwinStore, type Theme } from './state/store';
import { MockSource } from './net/MockSource';
import { TwinClient } from './net/TwinClient';
import type { TwinSource } from './net/source';
import { Shell, THEME_KEY } from './shell/Shell';
import { storage } from './widgets/dom';
import { postStatus } from './shell/status';
import { registerLibraryUi } from './library/register'; // v0.3 ui-library

const params = new URLSearchParams(location.search);
const useMock = params.get('source') === 'mock';

const store = new TwinStore();
const urlTheme = params.get('theme');
const savedTheme = storage.get(THEME_KEY);
store.setTheme(urlTheme === 'dark' || urlTheme === 'light' ? (urlTheme as Theme) : savedTheme === 'dark' ? 'dark' : 'light');

const client = useMock ? null : new TwinClient(store);
const source: TwinSource = client ?? new MockSource(store);

const switchSource = (kind: 'live' | 'mock') => {
  const p = new URLSearchParams(location.search);
  if (kind === 'mock') p.set('source', 'mock'); else p.delete('source');
  const q = p.toString();
  location.href = `${location.pathname}${q ? '?' + q : ''}${location.hash}`;
};

const shell = new Shell({ store, source }, {
  switchSource,
  reconnect: client ? () => client.retryNow() : undefined,
  connDetail: client
    ? () => {
      if (store.connection !== 'disconnected' || client.nextRetryAt === null) return '';
      const s = Math.max(0, Math.ceil((client.nextRetryAt - Date.now()) / 1000));
      return `retry in ${s} s`;
    }
    : undefined,
});
shell.attach(document.getElementById('app')!);
registerLibraryUi({ store, source }); // v0.3 ui-library: Mesh Library + dev hooks
document.title = `SV TwinLabs — Line A Console${useMock ? ' (Demo)' : ''}`;
source.connect();

if (client) {
  // If the live server is unreachable on first load, offer the demo without blocking.
  const offer = () => {
    if (client.everConnected) return;
    shell.showInfoBar(
      `Cannot reach the twin server at ${location.host}/ws. The console keeps retrying in the background.`,
      [
        { text: 'Switch to Demo Mode', onClick: () => switchSource('mock') },
        { text: 'Retry Now', onClick: () => client.retryNow() },
      ],
    );
    postStatus('Live server unreachable. Tools > Data Source > Demo Mode runs an in-browser simulation.', 'error');
  };
  const timer = setTimeout(offer, 3000);
  store.on('connection', (c) => {
    if (c === 'connected') { clearTimeout(timer); shell.hideInfoBar(); }
  });
} else {
  postStatus('Demo mode: in-browser mock simulation (not the reference engine)', 'info');
}
