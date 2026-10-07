// State-coloured LED. ISA-101: grey when normal/off, colour only when active or abnormal.
import { h, setPrefixedClass } from './dom';

export class Led {
  readonly el: HTMLSpanElement;
  private state = '';

  constructor(state = 'off', opts: { square?: boolean; title?: string } = {}) {
    this.el = h('span.led');
    if (opts.square) this.el.classList.add('sq');
    if (opts.title) this.el.title = opts.title;
    this.set(state);
  }

  /** state: an AssetStateKind, or 'ok' | 'warn' | 'bad' | 'conn' etc. mapped by the caller to st-* tokens. */
  set(state: string, blink = state === 'fault'): void {
    if (state === this.state && this.el.classList.contains('blink') === blink) return;
    this.state = state;
    setPrefixedClass(this.el, 'st-', state);
    this.el.classList.toggle('blink', blink);
    this.el.classList.toggle('blocked', state === 'blocked');
  }
}
