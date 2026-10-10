// Tools → Mesh Library…: list, upload, delete and copy glTF/GLB meshes, and assign one to the selected
// asset (a plant edit: PUT /api/plant after confirmation, which resets the simulation to t = 0).
import type { MeshInfo } from '../net/contracts';
import type { PanelContext } from '../panels/panel';
import { Dialog } from '../widgets/Dialog';
import { DataGrid } from '../widgets/DataGrid';
import { button } from '../widgets/Button';
import { h } from '../widgets/dom';
import { postStatus } from '../shell/status';
import { meshCache } from '../viewport/meshes';
import { formatBytes, MAX_MESH_BYTES, meshUsers, withAssetMesh, type MeshBackend } from './api';
import './library.css';

export function openMeshLibraryDialog(ctx: PanelContext, backend: MeshBackend): Dialog {
  const { store } = ctx;
  let rows: MeshInfo[] = [];
  let selected: MeshInfo | null = null;
  let busy = false;

  const grid = new DataGrid<MeshInfo>({
    columns: [
      { key: 'name', title: 'Name', width: 170, sortable: true },
      { key: 'size', title: 'Size', width: 70, align: 'right', mono: true, sortable: true, text: (m) => formatBytes(m.sizeBytes), sortKey: (m) => m.sizeBytes },
      { key: 'url', title: 'URL', width: 210, mono: true, sortable: true, text: (m) => m.url },
      { key: 'used', title: 'Used by', width: 110, sortable: true, text: (m) => meshUsers(store.plant, m.url).join(', ') || '—' },
    ],
    rowId: (m) => m.id,
    onSelect: (m) => { selected = m; sync(); },
    onActivate: (m) => { selected = m; void copyUrl(); },
    emptyText: 'No meshes uploaded yet. Click Upload… to add a .glb or .gltf file.',
    storageKey: 'svdtl.grid.meshes.v1',
    initialSort: { key: 'name', dir: 'asc' },
    framed: true,
  });

  const file = h('input', { type: 'file', accept: '.glb,.gltf,model/gltf-binary,model/gltf+json' });
  file.hidden = true;
  const bUpload = button({ text: 'Upload…', icon: 'plus', small: true, title: 'Upload a .glb / .gltf file (≤ 20 MB)', onClick: () => file.click() });
  const bDelete = button({ text: 'Delete', icon: 'clear', small: true, title: 'Delete the selected mesh from the server', onClick: () => void remove() });
  const bCopy = button({ text: 'Copy URL', icon: 'link', small: true, title: 'Copy the mesh URL (for asset.mesh in the Plant Builder)', onClick: () => void copyUrl() });
  const bAssign = button({ text: 'Assign to Selected Asset…', small: true, onClick: () => void assign(false) });
  const bClear = button({ text: 'Remove Mesh from Asset…', small: true, onClick: () => void assign(true) });
  const bRefresh = button({ text: 'Refresh', icon: 'reset', small: true, onClick: () => void refresh() });

  const status = h('span.ml-status', { text: '' });
  const bar = h('i');
  const prog = h('div.ml-prog', null, bar);
  prog.hidden = true;
  const target = h('div.ml-target');

  const body = h('div.ml', null,
    h('div.ml-tb', null, bUpload, bDelete, bCopy, h('span.ml-sep'), bAssign, bClear, h('span.ml-fill'), bRefresh, file),
    h('div.ml-grid', null, grid.el),
    h('div.ml-foot', null, prog, status),
    target,
    h('p.dlg-note', {
      text: backend.kind === 'demo'
        ? 'Demo mode: meshes are kept in this browser tab only, and assigning one changes the local plant view (the mock simulation is not affected).'
        : 'Meshes are fitted to each asset\'s size box in the 3D view (centred, on the floor). Assigning a mesh is a plant edit: it applies the live plant with PUT /api/plant, which resets the simulation to t = 0. The Plant Builder can also set asset.mesh.',
    }),
  );

  const setStatus = (text: string, kind: 'ok' | 'error' | 'info' = 'info') => {
    status.textContent = text;
    status.className = `ml-status ${kind}`;
  };

  const selectedAsset = () => (store.selection ? store.assetDef(store.selection) : undefined);

  const sync = () => {
    const a = selectedAsset();
    bDelete.disabled = busy || !selected;
    bCopy.disabled = !selected;
    bUpload.disabled = busy;
    bRefresh.disabled = busy;
    bAssign.disabled = busy || !selected || !a || a.mesh === selected?.url;
    bClear.disabled = busy || !a?.mesh;
    target.textContent = '';
    target.append(
      h('span', { text: 'Selected asset: ' }),
      a ? h('b', { text: `${a.id}` }) : h('i', { text: '(none — select an asset in the Plant Explorer or 3D view)' }),
      a ? h('span', { text: ` ${a.name} · ${a.kind} · size ${a.size.x}×${a.size.y}×${a.size.z} m · mesh: ` }) : '',
      a ? h('code', { text: a.mesh ?? '(procedural)' }) : '',
    );
  };

  const setBusy = (on: boolean) => { busy = on; sync(); };

  const refresh = async (keep?: string) => {
    setBusy(true);
    try {
      rows = await backend.list();
      grid.setRows(rows);
      const keepId = keep ?? selected?.id;
      selected = rows.find((m) => m.id === keepId) ?? rows[0] ?? null;
      grid.select(selected?.id ?? null);
      setStatus(`${rows.length} mesh${rows.length === 1 ? '' : 'es'}`, 'info');
    } catch (e) {
      rows = [];
      grid.setRows(rows);
      setStatus(`Could not list meshes: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (f) void upload(f);
  });

  const upload = async (f: File) => {
    if (f.size > MAX_MESH_BYTES) { setStatus(`${f.name} is ${formatBytes(f.size)}; the limit is 20 MB.`, 'error'); return; }
    setBusy(true);
    prog.hidden = false;
    bar.style.width = '0%';
    setStatus(`Uploading ${f.name} (${formatBytes(f.size)})…`);
    try {
      const info = await backend.upload(f, f.name, (p) => { bar.style.width = `${(p * 100).toFixed(0)}%`; });
      bar.style.width = '100%';
      await refresh(info.id);
      setStatus(`Uploaded ${info.name} → ${info.url}`, 'ok');
      postStatus(`Mesh uploaded: ${info.name}`, 'ok');
    } catch (e) {
      setStatus(`Upload failed: ${(e as Error).message}`, 'error');
    } finally {
      prog.hidden = true;
      setBusy(false);
    }
  };

  const remove = async () => {
    const m = selected;
    if (!m) return;
    const users = meshUsers(store.plant, m.url);
    const ok = await confirmBox('Delete Mesh',
      `Delete ${m.name} (${formatBytes(m.sizeBytes)}) from the server?` +
      (users.length ? `\n\nIt is used by ${users.join(', ')} in the live plant; those assets fall back to their procedural model.` : ''), 'Delete');
    if (!ok) return;
    setBusy(true);
    try {
      await backend.remove(m.id);
      meshCache.evict(m.url);
      selected = null;
      await refresh();
      setStatus(`Deleted ${m.name}`, 'ok');
    } catch (e) {
      setStatus(`Delete failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.url);
      setStatus(`Copied ${selected.url}`, 'ok');
    } catch {
      setStatus(`Copy failed — URL: ${selected.url}`, 'error');
    }
  };

  const assign = async (clear: boolean) => {
    const a = selectedAsset();
    const plant = store.plant;
    if (!a || !plant || (!clear && !selected)) return;
    const url = clear ? null : selected!.url;
    const what = clear ? `Remove the custom mesh from ${a.id} (${a.name})?` : `Assign ${selected!.name} to ${a.id} (${a.name})?`;
    const how = backend.kind === 'demo'
      ? 'Demo mode: only this browser\'s plant view changes.'
      : 'This is a plant edit: the live plant is applied with PUT /api/plant. The simulation resets to t = 0 (run state is kept) and every connected client receives the new plant.';
    if (!(await confirmBox(clear ? 'Remove Mesh' : 'Assign Mesh', `${what}\n\n${how}`, clear ? 'Remove' : 'Apply'))) return;
    setBusy(true);
    setStatus(clear ? 'Applying plant…' : `Applying plant with ${a.id}.mesh = ${url}…`);
    try {
      await backend.applyPlant(withAssetMesh(plant, a.id, url));
      setStatus(clear ? `${a.id} uses its procedural model again` : `${a.id} now uses ${selected!.name}`, 'ok');
      postStatus(clear ? `Mesh removed from ${a.id}` : `Mesh assigned to ${a.id} — plant applied`, 'ok');
      grid.setRows(rows); // refresh "Used by"
    } catch (e) {
      setStatus(`Apply failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const off = [store.on('snapshot', () => { grid.setRows(rows); sync(); }), store.on('selection', sync)];
  const dlg = Dialog.open({
    title: 'Mesh Library',
    icon: 'layout',
    body,
    width: 640,
    buttons: [{ id: 'close', text: 'Close', isDefault: true, isCancel: true }],
    onClose: () => { off.forEach((f) => f()); grid.dispose(); },
  });
  sync();
  void refresh();
  return dlg;
}

/** Modal Yes/No (resolves true on the primary button). */
function confirmBox(title: string, text: string, okText: string): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const body = h('div.ml-confirm', null, h('div', { text }));
    Dialog.open({
      title,
      icon: 'warning',
      body,
      width: 420,
      buttons: [
        { id: 'ok', text: okText, isDefault: true, onClick: () => { result = true; } },
        { id: 'cancel', text: 'Cancel', isCancel: true },
      ],
      onClose: () => resolve(result),
    });
  });
}
