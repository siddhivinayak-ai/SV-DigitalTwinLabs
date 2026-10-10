// TEMPORARY dev hooks for v0.3 visual checks (feature/ui-library). They only act on explicit URL params:
//   ?devPlant=v03            replace the plant with contracts/examples/plant.v03.json through store.apply
//                            (a live plant replacement), with kpi.v03.json and synthetic asset states.
//     &devOffShift=1         …at 16:00 sim clock with CNC-A Off (shift dimming) instead of Starved
//     &devMesh=1             …point CNC-A's mesh at the bundled reactor.glb fixture
//   ?devPlant=lines          Demo mode: the sample line with lines, an operator pool, shifts and a custom mesh,
//                            plus per-line / resource KPIs derived from the mock's asset KPIs.
//   ?devMeshLib=1            open Tools → Mesh Library… once the plant is loaded
import plantV03 from '../../../contracts/examples/plant.v03.json';
import kpiV03 from '../../../contracts/examples/kpi.v03.json';
import type { AssetState, AssetStateKind, KpiReport, LineKpi, PlantModel, SnapshotData } from '../net/contracts';
import type { TwinSource } from '../net/source';
import type { TwinStore } from '../state/store';

export function snapshotFromStore(store: TwinStore, plant: PlantModel): SnapshotData {
  return {
    plant,
    sim: { ...store.sim },
    assets: [...store.assets.values()].filter((a) => plant.assets.some((d) => d.id === a.id)),
    sensors: [...store.sensors].map(([id, v]) => ({ id, v })),
    parts: store.parts.filter((p) => plant.assets.some((d) => d.id === p.assetId)),
    ...(store.kpi ? { kpi: store.kpi } : {}),
    alarms: [...store.alarms.values()],
    events: [...store.events],
    connections: [...store.connections.values()],
  };
}

function state(id: string, s: AssetStateKind, extra: Partial<AssetState> = {}): AssetState {
  return { id, state: s, stateSinceMs: 0, load: s === 'running' ? 0.8 : 0, wear: 0.24, wip: 0, good: 0, scrap: 0, cycleProgress: 0, ...extra };
}

export function installDevPlantHooks(store: TwinStore, source: TwinSource, fixtureMeshUrl: string, openLibrary: () => void): void {
  if (typeof location === 'undefined') return;
  const q = new URLSearchParams(location.search);
  const mode = q.get('devPlant');
  if (q.get('devMeshLib')) {
    const go = () => setTimeout(openLibrary, 400);
    if (store.plant) go(); else { const off = store.on('snapshot', () => { off(); go(); }); }
  }
  if (mode === 'v03') installV03(store, source, q, fixtureMeshUrl);
  if (mode === 'lines' && source.kind === 'mock') installLines(store, source, fixtureMeshUrl);
}

/** Live plant replacement check: first the mock's sample line, then (after 1.2 s) the v0.3 example. */
function installV03(store: TwinStore, source: TwinSource, q: URLSearchParams, meshUrl: string): void {
  const offShift = !!q.get('devOffShift');
  const apply = () => {
    source.disconnect(); // freeze: the example plant has no simulation behind it
    const plant = structuredClone(plantV03) as unknown as PlantModel;
    if (q.get('devMesh')) for (const a of plant.assets) if (a.mesh) a.mesh = meshUrl;
    const kpi = structuredClone((kpiV03 as unknown as { data: KpiReport }).data);
    const hours = offShift ? 10 : 2;
    kpi.simTimeMs = hours * 3_600_000;
    // the example KPI names bottlenecks from another plant; point them at assets that exist here
    kpi.line.bottleneckAssetId = 'CNC-A';
    kpi.lines![0].kpi.bottleneckAssetId = 'CNC-A';
    kpi.lines![1].kpi.bottleneckAssetId = 'SRC-B';
    const snap: SnapshotData = {
      plant,
      sim: { state: 'running', speed: 1, simTimeMs: hours * 3_600_000, tick: hours * 36_000, seed: plant.seed, mode: 'simulate' },
      assets: [
        state('SRC-A', 'running'), state('CNC-A', offShift ? 'off' : 'starved', { wip: 0, good: 41 }),
        state('SRC-B', 'running'), state('SNK', 'idle', { good: 98 }),
      ],
      sensors: [],
      parts: [],
      kpi,
      alarms: [],
      events: [],
    };
    store.apply({ type: 'snapshot', t: snap.sim.simTimeMs, seq: store.lastSeq + 1, data: snap });
  };
  const off = store.on('snapshot', () => { off(); setTimeout(apply, 1200); });
}

const LINES_PLANT_ID = 'sample-line-v03-dev';

function augmentSample(p: PlantModel, meshUrl: string): PlantModel {
  const plant = structuredClone(p);
  plant.id = LINES_PLANT_ID;
  plant.name = `${p.name} (v0.3 dev)`;
  plant.lines = [{ id: 'machining', name: 'Machining' }, { id: 'assembly', name: 'Assembly & Pack' }];
  plant.resources = [{ id: 'op-pool', name: 'Operators', kind: 'operator', count: 1 }];
  plant.calendar = { startHourOfDay: 6, shifts: [{ id: 'day', name: 'Day shift', startHour: 6, endHour: 14 }, { id: 'night', name: 'Night shift', startHour: 22, endHour: 6 }] };
  const machining = new Set(['SRC-01', 'CONV-01', 'CNC-01', 'CNC-02', 'BUF-01']);
  for (const a of plant.assets) {
    if (a.kind !== 'sink') a.lineId = machining.has(a.id) ? 'machining' : 'assembly';
    if (a.id === 'CNC-01' || a.id === 'CNC-02') a.resourceId = 'op-pool';
    if (a.id === 'PACK-01') a.shiftId = 'night';
    if (a.id === 'ASSY-01') a.mesh = meshUrl;
  }
  return plant;
}

function deriveKpi(store: TwinStore, k: KpiReport): KpiReport {
  const plant = store.plant!;
  const lines = (plant.lines ?? []).map((l) => {
    const ids = new Set(plant.assets.filter((a) => a.lineId === l.id).map((a) => a.id));
    const ks = k.assets.filter((a) => ids.has(a.assetId));
    const bn = [...ks].sort((x, y) => y.utilization - x.utilization)[0];
    const wip = [...ids].reduce((n, id) => n + (store.assets.get(id)?.wip ?? 0), 0);
    const kpi: LineKpi = {
      oee: bn?.oee ?? 0, availability: bn?.availability ?? 1, performance: bn?.performance ?? 0, quality: bn?.quality ?? 1,
      throughputPerHour: k.line.throughputPerHour * (l.id === 'machining' ? 1.04 : 1), wip,
      good: ks.reduce((n, a) => n + a.good, 0), scrap: ks.reduce((n, a) => n + a.scrap, 0),
      ...(bn ? { bottleneckAssetId: bn.assetId } : {}),
    };
    return { lineId: l.id, kpi };
  });
  const users = k.assets.filter((a) => a.assetId === 'CNC-01' || a.assetId === 'CNC-02');
  const util = users.length ? Math.min(1, users.reduce((n, a) => n + a.utilization, 0)) : 0;
  const wait = users.reduce((n, a) => n + (a.states.starved ?? 0), 0) * (k.simTimeMs / 1000);
  return { ...k, lines, resources: [{ resourceId: 'op-pool', count: 1, utilization: util, waitSeconds: wait }] };
}

function installLines(store: TwinStore, source: TwinSource, meshUrl: string): void {
  store.on('snapshot', (s) => {
    if (s.plant.id === LINES_PLANT_ID) return;
    const plant = augmentSample(s.plant, meshUrl);
    setTimeout(() => {
      store.apply({ type: 'snapshot', t: s.sim.simTimeMs, seq: store.lastSeq + 1, data: { ...s, plant } });
      // PACK-01 runs nights only; the demo starts at 06:00, so switch it off (the mock has no calendar)
      void source.command({ action: 'asset.enable', assetId: 'PACK-01', value: 0 });
    }, 0);
  });
  store.on('kpi', (k) => {
    if (k.lines || store.plant?.id !== LINES_PLANT_ID) return;
    setTimeout(() => store.apply({ type: 'kpi', t: k.simTimeMs, seq: store.lastSeq + 1, data: deriveKpi(store, k) }), 0);
  });
}
