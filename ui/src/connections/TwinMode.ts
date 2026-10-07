// Twin mode: [Simulate | Shadow] two-state group on the tool strip, a SIM/SHADOW status-bar
// segment, and the shared switch routine used by the toolbar and the Simulation menu.
import type { TwinMode } from '../net/contracts';
import type { PanelContext } from '../panels/panel';
import { h, svg, setText } from '../widgets/dom';
import { toolButton, setChecked } from '../widgets/Button';
import { runCommand } from '../shell/actions';
import { postStatus } from '../shell/status';
import { connIcons } from './icons';
import { modeCommandValue, modeToggleState } from './logic';

export class TwinModeController {
  /** Mode requested but not yet acknowledged. */
  private pending: TwinMode | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ctx: PanelContext) {}

  get online(): boolean {
    const c = this.ctx.store.connection;
    return c === 'connected' || c === 'mock';
  }

  state() { return modeToggleState(this.ctx.store.sim, this.online, this.pending); }

  onChange(fn: () => void): void { this.listeners.add(fn); }
  private emit(): void { this.listeners.forEach((f) => f()); }

  /** Send `twin.mode`; rejections (e.g. no bindings → 409 on the server) go to the status bar. */
  async set(mode: TwinMode): Promise<void> {
    const { store, source } = this.ctx;
    if (!this.online) { postStatus('Not connected to the twin server', 'error'); return; }
    if (this.pending || store.sim.mode === mode) return;
    if (mode === 'shadow' && store.plant && !(store.plant.bindings ?? []).length) {
      postStatus('Shadow mode needs tag bindings: the loaded plant has no "bindings" (see the Connections tab)', 'error');
      return;
    }
    this.pending = mode;
    this.emit();
    try {
      const ack = await runCommand(source, { action: 'twin.mode', value: modeCommandValue(mode) },
        mode === 'shadow' ? 'Switch to SHADOW mode' : 'Switch to SIMULATE mode');
      if (ack.ok && store.sim.mode !== mode) {
        // The next tick carries SimStatus.mode; show the requested state until then.
        const off = store.on('tick', () => { if (store.sim.mode === mode || this.pending !== mode) { off(); this.pending = null; this.emit(); } });
        setTimeout(() => { if (this.pending === mode) { off(); this.pending = null; this.emit(); } }, 3000);
        return;
      }
    } catch { /* runCommand reports */ }
    this.pending = null;
    this.emit();
  }
}

/** Tool-strip group: two flat buttons acting as a radio pair (classic segmented toggle). */
export function createModeToggle(ctl: TwinModeController): { el: HTMLElement; update: () => void } {
  const sim = toolButton({ text: 'Simulate', showText: true, title: 'Simulate: the engine drives the twin (v0.1 behaviour)', onClick: () => void ctl.set('simulate') });
  sim.prepend(svg(connIcons.simulate));
  sim.classList.add('tm-sim');
  const sh = toolButton({ text: 'Shadow', showText: true, title: 'Shadow: external OPC UA / MQTT tags drive the twin; the engine predicts and raises deviation alarms', onClick: () => void ctl.set('shadow') });
  sh.prepend(svg(connIcons.shadow));
  sh.classList.add('tm-shadow');
  const el = h('span.twin-mode', { role: 'radiogroup', 'aria-label': 'Twin mode' }, sim, sh);
  const update = () => {
    const s = ctl.state();
    setChecked(sim, s.simulateChecked);
    setChecked(sh, s.shadowChecked);
    sim.setAttribute('role', 'radio'); sh.setAttribute('role', 'radio');
    sim.setAttribute('aria-checked', String(s.simulateChecked));
    sh.setAttribute('aria-checked', String(s.shadowChecked));
    sim.disabled = s.disabled;
    sh.disabled = s.disabled;
  };
  ctl.onChange(update);
  update();
  return { el, update };
}

/** Status-bar segment: "SIM" or "SHADOW". */
export function createModeSegment(ctl: TwinModeController): { el: HTMLElement; update: () => void } {
  const icon = h('span', { style: 'display:inline-flex' });
  const text = h('span');
  const el = h('div.sb-seg.twin', null, icon, text);
  let shown = '';
  const update = () => {
    const s = ctl.state();
    if (shown !== s.statusText) {
      shown = s.statusText;
      icon.textContent = '';
      icon.append(svg(s.mode === 'shadow' ? connIcons.shadow : connIcons.simulate));
      el.classList.toggle('shadow', s.mode === 'shadow');
    }
    setText(text, s.statusText);
    el.title = s.statusTitle;
  };
  ctl.onChange(update);
  update();
  return { el, update };
}
