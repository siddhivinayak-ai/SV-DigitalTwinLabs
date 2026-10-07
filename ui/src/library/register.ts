// v0.3 UI library integration (feature/ui-library): one call from main.ts wires the Mesh Library into the
// shell's Tools menu and installs the opt-in dev hooks. The shell asks for `libraryMenuEntries()`.
import type { PanelContext } from '../panels/panel';
import type { MenuEntry } from '../widgets/Menu';
import type { PlantModel } from '../net/contracts';
import { DemoMeshBackend, HttpMeshBackend, type MeshBackend } from './api';
import { openMeshLibraryDialog } from './MeshLibraryDialog';
import { installDevPlantHooks, snapshotFromStore } from './devPlant';
import reactorUrl from './__fixtures__/reactor.glb?url';

let ctx: PanelContext | null = null;
let backend: MeshBackend | null = null;

/** Register the library UI. Call once, before the source connects. */
export function registerLibraryUi(c: PanelContext): void {
  ctx = c;
  const { store, source } = c;
  backend = source.kind === 'live'
    ? new HttpMeshBackend()
    : new DemoMeshBackend(
      [{ id: 'demo-reactor', name: 'reactor.glb', url: reactorUrl, sizeBytes: 38624 }],
      (plant: PlantModel) => {
        const snap = snapshotFromStore(store, plant);
        store.apply({ type: 'snapshot', t: store.sim.simTimeMs, seq: store.lastSeq + 1, data: snap });
        return snap;
      },
    );
  installDevPlantHooks(store, source, reactorUrl, openMeshLibrary);
}

export function openMeshLibrary(): void {
  if (ctx && backend) openMeshLibraryDialog(ctx, backend);
}

/** Entries the shell appends to the Tools menu (empty until registerLibraryUi ran). */
export function libraryMenuEntries(): MenuEntry[] {
  if (!ctx) return [];
  return ['sep', { label: '&Mesh Library…', action: openMeshLibrary }];
}
