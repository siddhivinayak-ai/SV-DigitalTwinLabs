// Status bar: sunken segments for connection, message, sim clock, speed, run state,
// alarms, last message seq and UI frame rate. Updated in place.
import type { TwinStore, ConnectionState } from '../state/store';
import { h, setText, setPrefixedClass } from '../widgets/dom';
import { Led } from '../widgets/Led';
import { formatSimClock, formatSpeed, runStateLabel } from './format';
import { alarmSummary } from '../panels/AlarmsPanel';
import { onStatus, type StatusKind } from './status';

export function connectionLabel(c: ConnectionState): { text: string; led: string; blink: boolean } {
  switch (c) {
    case 'connected': return { text: 'CONNECTED', led: 'running', blink: false };
    case 'connecting': return { text: 'CONNECTING', led: 'starved', blink: true };
    case 'mock': return { text: 'DEMO', led: 'maintenance', blink: false };
    default: return { text: 'OFFLINE', led: 'fault', blink: false };
  }
}

export class StatusBar {
  readonly el: HTMLDivElement;
  private readonly connLed = new Led('off');
  private readonly connText = h('span.conn-text');
  private readonly connExtra = h('span.dim');
  private readonly msg = h('span');
  private readonly msgSeg: HTMLDivElement;
  private readonly clock = h('span.mono');
  private readonly speed = h('span.mono');
  private readonly runLed = new Led('off');
  private readonly run = h('span');
  private readonly alarmSeg: HTMLDivElement;
  private readonly alarms = h('span.mono');
  private readonly seq = h('span.mono');
  private readonly fps = h('span.mono');
  private msgTimer = 0;
  private frames = 0;
  private lastFpsT = performance.now();
  private rafId = 0;
  /** Optional provider of extra connection text, e.g. "retry in 4 s". */
  connDetail: (() => string) | null = null;

  constructor(private readonly store: TwinStore) {
    const seg = (cls: string, ...kids: (Node | string)[]) => h(`div.sb-seg.${cls}`, null, ...kids);
    this.msgSeg = seg('msg.grow', this.msg);
    this.alarmSeg = seg('alarms', h('span.sb-label', { text: 'Alarms' }), this.alarms);
    this.el = h('div.statusbar', { role: 'status' },
      seg('conn', this.connLed.el, this.connText, this.connExtra),
      this.msgSeg,
      seg('clock', h('span.sb-label', { text: 'Sim' }), this.clock),
      seg('speed', this.speed),
      seg('run', this.runLed.el, this.run),
      this.alarmSeg,
      seg('seq', h('span.sb-label', { text: 'seq' }), this.seq),
      seg('fps', this.fps, h('span.sb-label', { text: 'fps' })),
      h('div.sb-grip'),
    );
    this.alarmSeg.title = 'Active alarms (unacknowledged blink)';
    this.alarmSeg.style.cursor = 'default';
    this.setMessage('Ready', 'info', 0);
    onStatus((t, k) => this.setMessage(t, k));
    const loop = (t: number) => {
      this.frames++;
      if (t - this.lastFpsT >= 1000) {
        setText(this.fps, String(Math.round((this.frames * 1000) / (t - this.lastFpsT))));
        this.frames = 0;
        this.lastFpsT = t;
        this.updateConnection(); // refresh retry countdown
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
    this.update();
    this.updateConnection();
    this.updateAlarms();
  }

  onAlarmClick(fn: () => void): void { this.alarmSeg.addEventListener('click', fn); }

  setMessage(text: string, kind: StatusKind = 'info', holdMs = 8000): void {
    setText(this.msg, text);
    this.msgSeg.classList.toggle('error', kind === 'error');
    this.msgSeg.title = text;
    clearTimeout(this.msgTimer);
    if (holdMs > 0) this.msgTimer = window.setTimeout(() => this.setMessage('Ready', 'info', 0), holdMs);
  }

  /** Per tick: clock, speed, run state, seq. */
  update(): void {
    const s = this.store.sim;
    setText(this.clock, formatSimClock(s.simTimeMs));
    setText(this.speed, formatSpeed(s.speed));
    setText(this.run, runStateLabel(s.state));
    this.runLed.set(s.state === 'running' ? 'running' : s.state === 'paused' ? 'starved' : 'off', false);
    setText(this.seq, String(this.store.lastSeq));
  }

  updateConnection(): void {
    const c = connectionLabel(this.store.connection);
    this.connLed.set(c.led, c.blink);
    setText(this.connText, c.text);
    setText(this.connExtra, this.connDetail?.() ?? '');
  }

  updateAlarms(): void {
    const s = alarmSummary(this.store.alarms.values());
    setText(this.alarms, s.active ? `${s.active}${s.unacked ? ` (${s.unacked} unack)` : ''}` : '0');
    setPrefixedClass(this.alarmSeg, 'sev-', s.top === 'critical' || s.top === 'warning' ? s.top : null);
    this.alarmSeg.classList.toggle('blink', s.topUnacked && s.top === 'critical');
  }

  dispose(): void { cancelAnimationFrame(this.rafId); }
}
