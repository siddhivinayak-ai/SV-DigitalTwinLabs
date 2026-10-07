// Classic tree view: boxed +/- expanders, dotted guides, icons, optional state LED and
// right-hand meta text. Rows are built once per setNodes(); live updates patch in place.
import { h, svg, setText, setPrefixedClass } from './dom';
import { icons, type IconName } from './icons';

export interface TreeNode {
  id: string;
  label: string;
  icon?: IconName;
  /** Icon used when expanded (folders). */
  iconOpen?: IconName;
  /** Asset state → LED colour; omit for no LED. */
  led?: string;
  meta?: string;
  cls?: string;
  title?: string;
  expanded?: boolean;
  children?: TreeNode[];
}

export interface FlatNode { node: TreeNode; depth: number; parent: string | null; hasChildren: boolean }

/** Depth-first flatten of nodes whose ancestors are all expanded (pure). */
export function flattenVisible(nodes: TreeNode[], isExpanded: (n: TreeNode) => boolean, depth = 0, parent: string | null = null, out: FlatNode[] = []): FlatNode[] {
  for (const n of nodes) {
    const hasChildren = !!n.children?.length;
    out.push({ node: n, depth, parent, hasChildren });
    if (hasChildren && isExpanded(n)) flattenVisible(n.children!, isExpanded, depth + 1, n.id, out);
  }
  return out;
}

interface RowRefs { row: HTMLDivElement; tw: HTMLSpanElement; box: HTMLSpanElement | null; icon: HTMLSpanElement; led: HTMLSpanElement | null; meta: HTMLSpanElement; label: HTMLSpanElement; node: TreeNode }

export interface TreeViewOptions {
  onSelect?: (id: string) => void;
  onActivate?: (id: string) => void;
}

export class TreeView {
  readonly el: HTMLDivElement;
  private nodes: TreeNode[] = [];
  private readonly expanded = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly refs = new Map<string, RowRefs>();
  private visible: FlatNode[] = [];
  private selected: string | null = null;
  private focused: string | null = null;

  constructor(private readonly opt: TreeViewOptions = {}) {
    this.el = h('div.tree', { tabindex: 0, role: 'tree' });
    this.el.addEventListener('mousedown', (e) => this.onMouse(e));
    this.el.addEventListener('dblclick', (e) => {
      const id = this.idFromEvent(e);
      if (!id) return;
      const r = this.refs.get(id)!;
      if (r.node.children?.length) this.toggle(id);
      else this.opt.onActivate?.(id);
    });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  setNodes(nodes: TreeNode[]): void {
    this.nodes = nodes;
    const walk = (list: TreeNode[]) => list.forEach((n) => {
      if (!this.seen.has(n.id)) { this.seen.add(n.id); if (n.expanded) this.expanded.add(n.id); }
      if (n.children) walk(n.children);
    });
    this.refs.clear();
    walk(nodes);
    this.el.textContent = '';
    const build = (list: TreeNode[], depth: number) => {
      for (const n of list) {
        this.el.append(this.buildRow(n, depth));
        if (n.children?.length) build(n.children, depth + 1);
      }
    };
    build(nodes, 0);
    if (this.selected && !this.refs.has(this.selected)) this.selected = null;
    this.relayout();
  }

  /** Patch a row in place (5 Hz safe). */
  update(id: string, patch: { led?: string; meta?: string; metaClass?: string | null; label?: string }): void {
    const r = this.refs.get(id);
    if (!r) return;
    if (patch.led !== undefined && r.led) {
      setPrefixedClass(r.led, 'st-', patch.led);
      r.led.classList.toggle('blink', patch.led === 'fault');
      r.led.classList.toggle('blocked', patch.led === 'blocked');
      r.led.title = patch.led;
    }
    if (patch.meta !== undefined) setText(r.meta, patch.meta);
    if (patch.metaClass !== undefined) {
      const c = 'tmeta' + (patch.metaClass ? ' ' + patch.metaClass : '');
      if (r.meta.className !== c) r.meta.className = c;
    }
    if (patch.label !== undefined) setText(r.label, patch.label);
  }

  select(id: string | null, notify = false): void {
    if (id !== null && !this.refs.has(id)) id = null;
    if (this.selected) this.refs.get(this.selected)?.row.classList.remove('sel');
    this.selected = id;
    if (id) {
      this.revealAncestors(id);
      this.refs.get(id)!.row.classList.add('sel');
      this.setFocus(id);
      this.scrollIntoView(id);
      if (notify) this.opt.onSelect?.(id);
    }
  }

  get selection(): string | null { return this.selected; }

  expand(id: string, on = true): void {
    if (on) this.expanded.add(id); else this.expanded.delete(id);
    this.relayout();
  }

  toggle(id: string): void { this.expand(id, !this.expanded.has(id)); }

  isExpanded(id: string): boolean { return this.expanded.has(id); }

  // ---------- internals ----------

  private buildRow(n: TreeNode, depth: number): HTMLDivElement {
    const row = h('div.tree-row', { role: 'treeitem', title: n.title });
    if (n.cls) row.classList.add(...n.cls.split(' '));
    row.dataset.id = n.id;
    row.style.paddingLeft = `${2 + depth * 16}px`;
    const tw = h('span.tw');
    let box: HTMLSpanElement | null = null;
    if (n.children?.length) { box = h('span.box'); tw.append(box); }
    if (depth > 0) tw.classList.add('lines');
    const icon = h('span.ticon');
    if (n.icon) icon.append(svg(icons[n.icon]));
    let led: HTMLSpanElement | null = null;
    if (n.led !== undefined) {
      led = h('span.led');
      setPrefixedClass(led, 'st-', n.led);
      if (n.led === 'fault') led.classList.add('blink');
    }
    const label = h('span.tlabel', { text: n.label });
    const meta = h('span.tmeta', { text: n.meta ?? '' });
    row.append(tw, icon);
    if (led) row.append(led);
    row.append(label, meta);
    this.refs.set(n.id, { row, tw, box, icon, led, meta, label, node: n });
    return row;
  }

  private relayout(): void {
    this.visible = flattenVisible(this.nodes, (n) => this.expanded.has(n.id));
    const vis = new Set(this.visible.map((v) => v.node.id));
    for (const [id, r] of this.refs) {
      r.row.style.display = vis.has(id) ? '' : 'none';
      if (r.box) {
        const open = this.expanded.has(id);
        r.box.classList.toggle('plus', !open);
        if (r.node.iconOpen && r.node.icon) {
          r.icon.textContent = '';
          r.icon.append(svg(icons[open ? r.node.iconOpen : r.node.icon]));
        }
      }
    }
    if (this.focused && !vis.has(this.focused)) this.setFocus(this.visible[0]?.node.id ?? null);
  }

  private revealAncestors(id: string): void {
    const path: string[] = [];
    const find = (list: TreeNode[], trail: string[]): boolean => {
      for (const n of list) {
        if (n.id === id) { path.push(...trail); return true; }
        if (n.children && find(n.children, [...trail, n.id])) return true;
      }
      return false;
    };
    find(this.nodes, []);
    let changed = false;
    for (const p of path) if (!this.expanded.has(p)) { this.expanded.add(p); changed = true; }
    if (changed) this.relayout();
  }

  private setFocus(id: string | null): void {
    if (this.focused) this.refs.get(this.focused)?.row.classList.remove('focus');
    this.focused = id;
    if (id) this.refs.get(id)?.row.classList.add('focus');
  }

  private scrollIntoView(id: string): void {
    const row = this.refs.get(id)?.row;
    if (!row || row.style.display === 'none') return;
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (bottom > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = bottom - this.el.clientHeight;
  }

  private idFromEvent(e: Event): string | null {
    return (e.target as HTMLElement).closest<HTMLElement>('.tree-row')?.dataset.id ?? null;
  }

  private onMouse(e: MouseEvent): void {
    if (e.button !== 0) return;
    const id = this.idFromEvent(e);
    if (!id) return;
    if ((e.target as HTMLElement).closest('.tw .box')) { this.toggle(id); this.setFocus(id); return; }
    this.select(id, true);
  }

  private onKey(e: KeyboardEvent): void {
    const idx = this.visible.findIndex((v) => v.node.id === this.focused);
    const cur = this.visible[idx];
    const go = (i: number) => {
      const v = this.visible[Math.max(0, Math.min(this.visible.length - 1, i))];
      if (v) this.select(v.node.id, true);
    };
    switch (e.key) {
      case 'ArrowDown': go(idx + 1); break;
      case 'ArrowUp': go(idx < 0 ? 0 : idx - 1); break;
      case 'Home': go(0); break;
      case 'End': go(this.visible.length - 1); break;
      case 'PageDown': go(idx + Math.floor(this.el.clientHeight / 18) - 1); break;
      case 'PageUp': go(idx - Math.floor(this.el.clientHeight / 18) + 1); break;
      case 'ArrowRight':
        if (!cur) return;
        if (cur.hasChildren && !this.expanded.has(cur.node.id)) this.expand(cur.node.id);
        else if (cur.hasChildren) go(idx + 1);
        break;
      case 'ArrowLeft':
        if (!cur) return;
        if (cur.hasChildren && this.expanded.has(cur.node.id)) this.expand(cur.node.id, false);
        else if (cur.parent) this.select(cur.parent, true);
        break;
      case '+': if (cur?.hasChildren) this.expand(cur.node.id); break;
      case '-': if (cur?.hasChildren) this.expand(cur.node.id, false); break;
      case 'Enter':
        if (cur) cur.hasChildren ? this.toggle(cur.node.id) : this.opt.onActivate?.(cur.node.id);
        break;
      default: return;
    }
    e.preventDefault();
  }
}
