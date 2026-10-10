// Validation pane: DataGrid of ValidationIssues (severity, code, asset, message). Selecting a row
// selects the asset in the plan and pans to it.
import type { ValidationIssue } from '../net/contracts';
import { DataGrid } from '../widgets/DataGrid';
import { h, svg, setText } from '../widgets/dom';
import { icons } from '../widgets/icons';
import { button } from '../widgets/Button';
import { severityRank } from '../shell/format';
import type { BuilderEditor } from './editor';

type Row = ValidationIssue & { key: string };

export class ValidationPanel {
  readonly el: HTMLDivElement;
  readonly grid: DataGrid<Row>;
  private readonly counts: HTMLSpanElement;
  private readonly source: HTMLSpanElement;

  constructor(private readonly ed: BuilderEditor, validateNow: () => void) {
    this.el = h('div.bld-valid');
    const bar = h('div.panel-toolbar');
    this.counts = h('span.bld-vcounts');
    this.source = h('span.dim.bld-vsource');
    bar.append(this.counts, h('span.grow'), this.source, h('span.sep'),
      button({ icon: 'ack', text: 'Validate Now', small: true, title: 'Run validation now (F7)', onClick: validateNow }));
    this.grid = new DataGrid<Row>({
      columns: [
        {
          key: 'severity', title: '', width: 24, align: 'center', sortKey: (r) => severityRank(r.severity), tooltip: 'Severity',
          render: (cell, r) => {
            if (cell.dataset.sev === r.severity) return;
            cell.dataset.sev = r.severity;
            cell.textContent = '';
            cell.append(svg(icons[r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'info']));
            cell.title = r.severity;
          },
        },
        { key: 'code', title: 'Code', width: 150, mono: true },
        { key: 'assetId', title: 'Asset', width: 84, mono: true, text: (r) => r.assetId ?? '' },
        { key: 'message', title: 'Message', width: 560 },
      ],
      rowId: (r) => r.key,
      emptyText: 'No issues. The plant is valid.',
      storageKey: 'svdtl.grid.builderIssues.v1',
      initialSort: { key: 'severity', dir: 'asc' },
      onSelect: (r) => this.go(r),
      onActivate: (r) => { this.go(r); if (r?.assetId) ed.emit('activate', r.assetId); },
    });
    const box = h('div.bld-valid-grid');
    box.append(this.grid.el);
    this.el.append(bar, box);
    ed.on('issues', () => this.refresh());
    this.refresh();
  }

  dispose(): void { this.grid.dispose(); }

  private go(r: Row | null): void {
    if (!r?.assetId || !this.ed.asset(r.assetId)) return;
    this.ed.select([r.assetId]);
    this.ed.emit('reveal', r.assetId);
  }

  private refresh(): void {
    const ed = this.ed;
    const rows = ed.issues.map((i, k) => ({ ...i, key: `${k}:${i.code}:${i.assetId ?? ''}` }));
    this.grid.setRows(rows);
    const c = ed.issues.filter((i) => i.severity === 'critical').length;
    const w = ed.issues.filter((i) => i.severity === 'warning').length;
    this.counts.textContent = '';
    const chip = (icon: 'critical' | 'warning', n: number, label: string) => {
      const s = h('span.bld-vchip');
      s.append(svg(icons[icon]), h('span', { text: `${n} ${label}${n === 1 ? '' : 's'}` }));
      if (!n) s.classList.add('zero');
      return s;
    };
    this.counts.append(chip('critical', c, 'error'), chip('warning', w, 'warning'));
    const src = ed.validationSource;
    setText(this.source, src === 'pending' ? 'Validating…'
      : src === 'server' ? 'Server validator (POST /api/plant/validate)'
      : src === 'local' ? `Local validator${ed.validationNote ? ' — ' + ed.validationNote : ''}` : '');
  }
}
