// Tab strip with one absolutely-positioned page per tab. Pages stay mounted; only visibility
// changes, so panels keep their state and ResizeObserver fires when a page is shown.
import { h, svg, setText, setPrefixedClass } from './dom';
import { icons, type IconName } from './icons';

export interface TabDef { id: string; label: string; icon?: IconName }

export class TabStrip {
  readonly el: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly pagesEl: HTMLDivElement;
  private readonly tabs = new Map<string, { tab: HTMLDivElement; page: HTMLDivElement; badge: HTMLSpanElement; def: TabDef }>();
  private activeId: string | null = null;

  constructor(defs: TabDef[], private readonly onChange?: (id: string) => void) {
    this.el = h('div.tabstrip');
    this.bar = h('div.tabstrip-tabs', { role: 'tablist' });
    this.pagesEl = h('div.tabstrip-pages');
    this.el.append(this.bar, this.pagesEl);
    for (const d of defs) {
      const tab = h('div.tab', { role: 'tab', tabindex: -1 });
      if (d.icon) tab.append(svg(icons[d.icon]));
      tab.append(h('span.tab-label', { text: d.label }));
      const badge = h('span.tab-badge.hidden');
      tab.append(badge);
      tab.addEventListener('mousedown', (e) => { if (e.button === 0) { this.activate(d.id); tab.focus(); } });
      tab.addEventListener('keydown', (e) => this.onKey(e));
      const page = h('div.tabstrip-page', { role: 'tabpanel' });
      page.style.display = 'none';
      this.bar.append(tab);
      this.pagesEl.append(page);
      this.tabs.set(d.id, { tab, page, badge, def: d });
    }
  }

  page(id: string): HTMLDivElement { return this.tabs.get(id)!.page; }
  get active(): string | null { return this.activeId; }
  get ids(): string[] { return [...this.tabs.keys()]; }
  label(id: string): string { return this.tabs.get(id)?.def.label ?? id; }

  activate(id: string, notify = true): void {
    if (!this.tabs.has(id) || id === this.activeId) return;
    for (const [k, t] of this.tabs) {
      const on = k === id;
      t.tab.classList.toggle('active', on);
      t.tab.tabIndex = on ? 0 : -1;
      t.tab.setAttribute('aria-selected', String(on));
      t.page.style.display = on ? '' : 'none';
    }
    this.activeId = id;
    if (notify) this.onChange?.(id);
  }

  /** Small count badge on a tab (e.g. active alarms). */
  setBadge(id: string, text: string | null, sev: string | null = null, blink = false): void {
    const t = this.tabs.get(id);
    if (!t) return;
    t.badge.classList.toggle('hidden', text === null);
    setText(t.badge, text ?? '');
    setPrefixedClass(t.badge, 'sev-', sev);
    t.badge.classList.toggle('blink', blink);
  }

  private onKey(e: KeyboardEvent): void {
    const ids = this.ids;
    const i = ids.indexOf(this.activeId ?? '');
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    if (n < 0) return;
    e.preventDefault();
    this.activate(ids[n]);
    this.tabs.get(ids[n])!.tab.focus();
  }
}
