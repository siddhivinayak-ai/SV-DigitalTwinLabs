// Etched group box with caption (fieldset/legend).
import { h } from './dom';

export function groupBox(caption: string, ...children: (Node | string)[]): HTMLFieldSetElement {
  const fs = h('fieldset.groupbox');
  fs.append(h('legend', { text: caption }), ...children);
  return fs;
}

export function checkbox(label: string, checked = false, type: 'checkbox' | 'radio' = 'checkbox', name?: string): { el: HTMLLabelElement; input: HTMLInputElement } {
  const input = h('input', { type, name });
  input.checked = checked;
  const el = h('label.check', null, input, h('span', { text: label }));
  return { el, input };
}
