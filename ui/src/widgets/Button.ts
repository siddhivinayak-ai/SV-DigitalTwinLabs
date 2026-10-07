// Push button and toolbar button factories.
import { h, svg } from './dom';
import { icons, type IconName } from './icons';

export interface ButtonOptions {
  text?: string;
  icon?: IconName;
  title?: string;
  small?: boolean;
  isDefault?: boolean;
  onClick?: (e: MouseEvent) => void;
}

export function button(o: ButtonOptions): HTMLButtonElement {
  const b = h('button.btn', { type: 'button', title: o.title });
  if (o.small) b.classList.add('small');
  if (o.isDefault) b.classList.add('default');
  if (o.icon) b.append(svg(icons[o.icon]));
  if (o.text) b.append(h('span', { text: o.text }));
  if (o.onClick) b.addEventListener('click', o.onClick);
  return b;
}

/** Flat 22px toolbar button that raises on hover (WinForms ToolStripButton). */
export function toolButton(o: ButtonOptions & { showText?: boolean }): HTMLButtonElement {
  const b = h('button.tool-btn', { type: 'button', title: o.title ?? o.text });
  if (o.icon) b.append(svg(icons[o.icon]));
  if (o.text && (o.showText || !o.icon)) b.append(h('span.tb-text', { text: o.text }));
  if (o.onClick) b.addEventListener('click', o.onClick);
  return b;
}

export function setChecked(b: HTMLElement, on: boolean): void {
  b.classList.toggle('checked', on);
  b.setAttribute('aria-pressed', String(on));
}
