// Simulation → Inject Fault…: pick an asset and a repair duration.
import type { PanelContext } from '../panels/panel';
import { Dialog } from '../widgets/Dialog';
import { ComboBox } from '../widgets/ComboBox';
import { NumericInput } from '../widgets/NumericInput';
import { groupBox, checkbox } from '../widgets/GroupBox';
import { Led } from '../widgets/Led';
import { h } from '../widgets/dom';
import { runCommand } from '../shell/actions';
import { formatDuration } from '../shell/format';

const FAULTABLE = new Set(['machine', 'robot', 'inspection', 'conveyor', 'source', 'buffer']);

export function openInjectFaultDialog(ctx: PanelContext, assetId?: string | null): Dialog | null {
  const { store, source } = ctx;
  const plant = store.plant;
  if (!plant) return null;
  const assets = plant.assets.filter((a) => FAULTABLE.has(a.kind));
  const initial = assets.find((a) => a.id === assetId) ?? assets.find((a) => a.kind === 'machine') ?? assets[0];
  const mttr = (id: string) => store.assetDef(id)?.params.mttrS ?? 300;

  const led = new Led('off');
  const stateText = h('span');
  const combo = new ComboBox<string>({
    items: assets.map((a) => ({ value: a.id, label: `${a.id} — ${a.name}` })),
    value: initial.id,
    width: 260,
    onChange: (id) => { refreshState(id); if (useMttr.input.checked) dur.setValue(mttr(id)); },
  });
  const dur = new NumericInput({ value: mttr(initial.id), min: 1, max: 86_400, step: 30, width: 100 });
  const useMttr = checkbox('Use asset MTTR', true);
  const durHint = h('span.dim');
  useMttr.input.addEventListener('change', () => {
    dur.setDisabled(useMttr.input.checked);
    if (useMttr.input.checked) dur.setValue(mttr(combo.value!));
  });
  dur.setDisabled(true);
  const refreshState = (id: string) => {
    const st = store.assets.get(id)?.state ?? 'off';
    led.set(st);
    stateText.textContent = st.toUpperCase();
    durHint.textContent = `≈ ${formatDuration(mttr(id) * 1000)} nominal`;
  };
  refreshState(initial.id);

  const target = groupBox('Target',
    h('div.form-grid', null,
      h('label', { text: 'Asset:' }), combo.el,
      h('label', { text: 'Current state:' }), h('div.dlg-row', null, led.el, stateText)));
  const fault = groupBox('Fault',
    h('div.form-grid', null,
      h('label', { text: 'Repair time (s):' }), h('div.dlg-row', null, dur.el, durHint),
      h('span'), useMttr.el));
  const note = h('p.dlg-note', { text: 'The asset enters FAULT immediately, raises a critical alarm and recovers after the repair time. Upstream assets will block and downstream assets will starve.' });
  const body = h('div', null, target, fault, note);
  body.style.width = '380px';

  return Dialog.open({
    title: 'Inject Fault',
    icon: 'fault',
    body,
    buttons: [
      {
        id: 'ok', text: 'Inject', isDefault: true,
        onClick: async (dlg) => {
          if (!dur.valid) return false;
          dlg.setBusy(true);
          const ack = await runCommand(source, { action: 'asset.fault', assetId: combo.value!, durationS: dur.value });
          dlg.setBusy(false);
          return ack.ok;
        },
      },
      { id: 'cancel', text: 'Cancel', isCancel: true },
    ],
  });
}
