// Main tool strip: run controls, speed combo, analysis actions, theme toggle.
import type { TwinStore } from '../state/store';
import { h, setText } from '../widgets/dom';
import { toolButton, setChecked } from '../widgets/Button';
import { ComboBox } from '../widgets/ComboBox';
import { SPEEDS, formatSpeed } from './format';

export interface ToolStripActions {
  start(): void; pause(): void; stop(): void; reset(): void;
  speed(v: number): void;
  injectFault(): void; whatIf(): void; exportCsv(): void; toggleTheme(): void;
}

export class ToolStrip {
  readonly el: HTMLDivElement;
  private readonly btnStart: HTMLButtonElement;
  private readonly btnPause: HTMLButtonElement;
  private readonly btnStop: HTMLButtonElement;
  private readonly btnReset: HTMLButtonElement;
  private readonly btnFault: HTMLButtonElement;
  private readonly btnWhatIf: HTMLButtonElement;
  private readonly btnExport: HTMLButtonElement;
  private readonly btnTheme: HTMLButtonElement;
  private readonly speed: ComboBox<number>;
  private readonly selLabel: HTMLSpanElement;

  constructor(private readonly store: TwinStore, a: ToolStripActions) {
    this.el = h('div.toolstrip', { role: 'toolbar' });
    this.btnStart = toolButton({ icon: 'play', title: 'Start / resume simulation (F5)', onClick: a.start });
    this.btnPause = toolButton({ icon: 'pause', title: 'Pause simulation (F6)', onClick: a.pause });
    this.btnStop = toolButton({ icon: 'stop', title: 'Stop simulation (Shift+F5)', onClick: a.stop });
    this.btnReset = toolButton({ icon: 'reset', title: 'Reset simulation (Ctrl+Shift+R)', onClick: a.reset });
    this.speed = new ComboBox<number>({
      items: SPEEDS.map((s) => ({ value: s, label: formatSpeed(s) })),
      value: 1, width: 64, title: 'Simulation speed (sim seconds per wall second)',
      onChange: (v) => a.speed(v),
    });
    this.btnFault = toolButton({ icon: 'fault', text: 'Inject Fault…', showText: true, title: 'Inject a fault on an asset (Ctrl+I)', onClick: a.injectFault });
    this.btnWhatIf = toolButton({ icon: 'whatIf', text: 'What-If…', showText: true, title: 'Run a what-if scenario (Ctrl+W)', onClick: a.whatIf });
    this.btnExport = toolButton({ icon: 'export', text: 'Export CSV', showText: true, title: 'Export sensor history as CSV (Ctrl+E)', onClick: a.exportCsv });
    this.btnTheme = toolButton({ icon: 'theme', title: 'Toggle Light / Control Room theme (Ctrl+Shift+T)', onClick: a.toggleTheme });
    this.selLabel = h('span.label.dim');

    this.el.append(
      h('span.grip'),
      this.btnStart, this.btnPause, this.btnStop, this.btnReset,
      h('span.sep'),
      h('span.label', { text: 'Speed' }), this.speed.el,
      h('span.sep'),
      this.btnFault, this.btnWhatIf,
      h('span.sep'),
      this.btnExport,
      h('span.grow'),
      this.selLabel,
      h('span.sep'),
      this.btnTheme,
    );
    this.update();
  }

  /** Reflect run state, speed and connection; cheap, called per tick. */
  update(): void {
    const s = this.store.sim.state;
    const online = this.store.connection === 'connected' || this.store.connection === 'mock';
    const hasPlant = !!this.store.plant;
    setChecked(this.btnStart, s === 'running');
    setChecked(this.btnPause, s === 'paused');
    setChecked(this.btnStop, s === 'stopped');
    for (const b of [this.btnStart, this.btnPause, this.btnStop, this.btnReset]) b.disabled = !online;
    this.btnFault.disabled = !online || !hasPlant;
    this.btnWhatIf.disabled = !online || !hasPlant;
    this.btnExport.disabled = !hasPlant;
    this.speed.setDisabled(!online);
    if (this.speed.value !== this.store.sim.speed) this.speed.setValue(this.store.sim.speed, true);
    const sel = this.store.selection;
    const def = sel ? this.store.assetDef(sel) : undefined;
    setText(this.selLabel, def ? `Selected: ${def.id} · ${def.name}` : '');
  }

  setTheme(dark: boolean): void { setChecked(this.btnTheme, dark); }
}
