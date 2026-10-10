// Saved what-if scenarios: "Save scenario…" name prompt, the "Saved Scenarios" list dialog
// (Open / Re-run / Delete), and the hook the What-If dialog uses to wire both in.
import type { Scenario, WhatIfRequest, WhatIfResult } from '../net/contracts';
import type { PanelContext } from '../panels/panel';
import { Dialog, type DialogButton } from '../widgets/Dialog';
import { DataGrid } from '../widgets/DataGrid';
import { h, setText } from '../widgets/dom';
import { postStatus } from '../shell/status';
import { connectedTwinApi } from './api';
import { defaultScenarioName, scenarioOverrideRows, scenarioRows, type ScenarioRow } from './logic';
import './connections.css';

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/** Modal name prompt; resolves with the saved scenario, or null when cancelled. */
export function openSaveScenarioDialog(ctx: PanelContext, request: WhatIfRequest, result: WhatIfResult | undefined): Promise<Scenario | null> {
  const api = connectedTwinApi(ctx.source);
  return new Promise((resolve) => {
    let saved: Scenario | null = null;
    const name = h('input.field', { type: 'text', spellcheck: 'false', maxlength: 120 });
    name.value = defaultScenarioName(scenarioOverrideRows({ request }));
    name.style.width = '100%';
    const err = h('div.err');
    const n = scenarioOverrideRows({ request }).length;
    const body = h('div.cx-dlg', { style: 'width:380px' },
      h('div.form-grid', null, h('label', { text: 'Scenario name:' }), name),
      h('p.dlg-note', { text: `${n} override${n === 1 ? '' : 's'} · ${(request.durationS / 3600).toFixed(0)} h horizon · seed ${request.seed ?? '—'}${result ? ' · result included' : ''}` }),
      err);
    Dialog.open({
      title: 'Save Scenario', icon: 'whatIf', body,
      onClose: () => resolve(saved),
      buttons: [
        {
          id: 'save', text: 'Save', isDefault: true,
          onClick: async (d) => {
            const nm = name.value.trim();
            if (!nm) { setText(err, 'Enter a name.'); name.focus(); return false; }
            d.setBusy(true);
            try {
              saved = await api.saveScenario({ name: nm, request, ...(result ? { result } : {}) });
              postStatus(`Scenario "${saved.name}" saved`, 'ok');
              return true;
            } catch (e) {
              setText(err, `Save failed: ${errText(e)}`);
              postStatus('Saving the scenario failed', 'error');
              return false;
            } finally {
              d.setBusy(false);
            }
          },
        },
        { id: 'cancel', text: 'Cancel', isCancel: true },
      ],
    });
    name.select();
  });
}

function confirmBox(title: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let yes = false;
    const body = h('div', { style: 'max-width:340px;padding:4px 6px', text });
    Dialog.open({
      title, icon: 'warning', body, onClose: () => resolve(yes),
      buttons: [
        { id: 'yes', text: 'Delete', isDefault: true, onClick: () => { yes = true; } },
        { id: 'no', text: 'Cancel', isCancel: true },
      ],
    });
  });
}

export interface ScenarioListActions {
  /** Load overrides (and the stored result) into a What-If dialog. */
  open(s: Scenario): void;
  /** Load and run again against the current model. */
  rerun(s: Scenario): void;
}

/** Analysis → Saved Scenarios… / What-If → Open saved…: list with Open, Re-run, Delete. */
export function openScenarioListDialog(ctx: PanelContext, actions: ScenarioListActions): Dialog {
  const api = connectedTwinApi(ctx.source);
  const count = h('span.count');
  const err = h('span.err');
  let busy = false;
  let dlg: Dialog;

  const grid = new DataGrid<ScenarioRow>({
    storageKey: 'svdtl.grid.scenarios.v1',
    framed: true,
    emptyText: 'No saved scenarios. Run a what-if and press "Save scenario…".',
    rowId: (r) => r.id,
    onSelect: () => sync(),
    onActivate: (r) => void fetchAnd(r, 'open'),
    columns: [
      { key: 'name', title: 'Name', width: 250 },
      { key: 'created', title: 'Saved', width: 112, mono: true, sortKey: (r) => r.createdMs },
      { key: 'duration', title: 'Horizon', width: 64, align: 'right', sortKey: (r) => r.durationS },
      { key: 'overrides', title: 'Overrides', width: 66, align: 'right', sortKey: (r) => r.overrides },
      { key: 'id', title: 'Id', width: 84, mono: true },
    ],
  });
  let rows: ScenarioRow[] = [];

  const sync = () => {
    const has = !!grid.selection && rows.some((r) => r.id === grid.selection);
    for (const id of ['open', 'rerun', 'delete']) { const b = dlg?.buttons.get(id); if (b) b.disabled = busy || !has; }
  };

  const load = async (keep?: string | null) => {
    setText(err, '');
    setText(count, 'Loading…');
    try {
      rows = scenarioRows(await api.scenarios());
      grid.setRows(rows);
      setText(count, `${rows.length} saved`);
      const sel = keep && rows.some((r) => r.id === keep) ? keep : rows[0]?.id ?? null;
      grid.select(sel);
    } catch (e) {
      setText(count, '');
      setText(err, `Could not load scenarios: ${errText(e)}`);
    }
    sync();
  };

  const selected = () => rows.find((r) => r.id === grid.selection);

  const fetchAnd = async (r: ScenarioRow | undefined, what: 'open' | 'rerun'): Promise<boolean> => {
    if (!r || busy) return false;
    busy = true; sync();
    try {
      const s = await api.scenario(r.id);
      dlg.close();
      if (what === 'open') actions.open(s); else actions.rerun(s);
      return true;
    } catch (e) {
      setText(err, `Could not open "${r.name}": ${errText(e)}`);
      return false;
    } finally {
      busy = false; sync();
    }
  };

  const remove = async (r: ScenarioRow | undefined) => {
    if (!r) return;
    if (!(await confirmBox('Delete Scenario', `Delete the saved scenario "${r.name}"? This cannot be undone.`))) return;
    try {
      await api.deleteScenario(r.id);
      postStatus(`Scenario "${r.name}" deleted`, 'ok');
      const i = rows.findIndex((x) => x.id === r.id);
      await load(rows[i + 1]?.id ?? rows[i - 1]?.id ?? null);
    } catch (e) {
      setText(err, `Delete failed: ${errText(e)}`);
    }
  };

  const gridHost = h('div.cx-grid', null, grid.el);
  const body = h('div.cx-dlg', { style: 'width:600px' },
    gridHost,
    h('div.dlg-row', null, count, h('span.grow'), err),
    h('p.dlg-note', { text: 'Open loads the overrides, run settings and stored result into the What-If dialog. Re-run loads them and simulates again against the current model.' }));

  const buttons: DialogButton[] = [
    { id: 'refresh', text: 'Refresh', left: true, onClick: () => { void load(grid.selection); return false; } },
    { id: 'delete', text: 'Delete', left: true, onClick: () => { void remove(selected()); return false; } },
    { id: 'open', text: 'Open', isDefault: true, onClick: () => { void fetchAnd(selected(), 'open'); return false; } },
    { id: 'rerun', text: 'Re-run', onClick: () => { void fetchAnd(selected(), 'rerun'); return false; } },
    { id: 'close', text: 'Close', isCancel: true },
  ];
  dlg = Dialog.open({ title: 'Saved Scenarios', icon: 'whatIf', body, width: 628, buttons, onClose: () => grid.dispose() });
  sync();
  grid.el.focus();
  void load();
  return dlg;
}

/** What the What-If dialog exposes to the scenario hook. */
export interface WhatIfHost {
  currentRequest(): WhatIfRequest;
  /** Replace overrides and settings; show the stored result (or the placeholder). */
  load(s: Scenario): void;
  /** Press Run. */
  run(): void;
}

/**
 * Adds "Save scenario…" (enabled after a run) and "Open saved…" to the What-If dialog.
 * Usage inside openWhatIfDialog: create, spread `buttons` into the dialog, call bind(dlg) after
 * Dialog.open and afterRun(req, res) when a run succeeds.
 */
export function whatIfScenarioHook(ctx: PanelContext, host: WhatIfHost) {
  let last: { req: WhatIfRequest; res: WhatIfResult } | null = null;
  let dlg: Dialog | null = null;
  const note = h('span.wi-saved');
  const setSaveEnabled = () => { const b = dlg?.buttons.get('saveScenario'); if (b) b.disabled = !last; };

  const loadSaved = (s: Scenario, rerun = false) => {
    host.load(s);
    last = !rerun && s.result ? { req: s.request, res: s.result } : null;
    setText(note, rerun ? `Re-running “${s.name}”` : `Loaded “${s.name}”`);
    setSaveEnabled();
    if (rerun) host.run();
  };

  const buttons: DialogButton[] = [
    {
      id: 'openScenario', text: 'Open saved…', left: true,
      onClick: () => {
        openScenarioListDialog(ctx, { open: (s) => loadSaved(s), rerun: (s) => loadSaved(s, true) });
        return false;
      },
    },
    {
      id: 'saveScenario', text: 'Save scenario…', left: true,
      onClick: () => {
        if (!last) return false;
        void openSaveScenarioDialog(ctx, last.req, last.res).then((s) => { if (s) setText(note, `Saved as “${s.name}”`); });
        return false;
      },
    },
  ];

  return {
    buttons,
    bind(d: Dialog) {
      dlg = d;
      d.buttons.get('saveScenario')?.closest('.dialog-buttons')?.querySelector('.spacer')?.before(note);
      setSaveEnabled();
    },
    afterRun(req: WhatIfRequest, res: WhatIfResult) { last = { req, res }; setSaveEnabled(); },
    /** Re-apply the Save button state (Dialog.setBusy(false) re-enables every button). */
    refresh() { setSaveEnabled(); },
    /** Load a saved scenario (from the menu's list dialog); optionally run it again. */
    loadSaved,
  };
}
