import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AssetDef, AssetState, ResourceKind } from '../net/contracts';
import type { Panel, PanelContext, PanelFactory } from '../panels/panel';
import type { TwinStore } from '../state/store';
import { cssVar } from '../charts/theme';
import { buildAsset, StackLight, type AssetView } from './assets';
import { easeInOut, fitDistance, presetDirection, type ViewPreset } from './camera';
import { applyDevParams } from './dev';
import { bracketGeometry, buildFlowLines, buildGrid, buildSafetyLines, floorExtent, footprintGeometry } from './floor';
import { AxisGizmo } from './gizmo';
import { Kit } from './kit';
import { PART, partWorldPosition } from './placement';
import { isAbnormal, lensOn, STATE_LABEL, stateColor } from './status';
import { instantiateFitted, meshCache } from './meshes';
import { lineZones, resourceWait, shiftDimmed, shiftOf } from './v03';
import './viewport.css';

const SELECT_COLOR = 0x0f62fe;
const FRAME_MS = 1000 / 60;

interface PartVis {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  assetId: string;
  robot: boolean;
}

interface AssetExtras {
  view: AssetView;
  label: CSS2DObject;
  labelDot: HTMLElement;
  outline: THREE.LineSegments;
  outlineMat: THREE.LineBasicMaterial;
  lastState?: AssetState['state'];
  prog: { from: number; to: number; t0: number; shown: number };
  /** Children of the root built by the procedural model (detached when a custom mesh loads). */
  procedural: THREE.Object3D[];
  /** v0.3: fitted glTF instance once loaded. */
  custom: THREE.Object3D | null;
  /** v0.3: resource-wait glyph above the asset. */
  res: CSS2DObject;
  resKind: ResourceKind | null;
  dimmed: boolean;
}

/** v0.3 line zone: floor tint + border + name label. */
interface ZoneVis { fill: THREE.MeshBasicMaterial; edge: THREE.LineBasicMaterial; label: HTMLElement; index: number }

interface Tween { p0: THREE.Vector3; p1: THREE.Vector3; t0v: THREE.Vector3; t1v: THREE.Vector3; start: number; dur: number }

class ViewportPanel implements Panel {
  readonly id = 'viewport';
  readonly title = '3D Viewport';

  private readonly store: TwinStore;
  private host!: HTMLElement;
  private root!: HTMLDivElement;
  private renderer!: THREE.WebGLRenderer;
  private labels!: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  /** Distance fog in the background colour so the floor fades out instead of ending in a hard edge. */
  private readonly fog = new THREE.Fog(0xc8ccd2, 60, 200);
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 600);
  private controls!: OrbitControls;
  private readonly gizmo = new AxisGizmo();
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.5);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.1);

  // plant-dependent content (rebuilt on snapshot)
  private kit: Kit | null = null;
  private readonly plantGroup = new THREE.Group();
  private readonly envGroup = new THREE.Group();
  private readonly floorMat = new THREE.MeshStandardMaterial({ color: 0x9da3ab, roughness: 0.95, metalness: 0 });
  private readonly safetyMat = new THREE.MeshBasicMaterial({ color: 0xf2c200, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  private readonly flowMat = new THREE.MeshBasicMaterial({ color: 0x3f5f86, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
  private gridMats: THREE.LineBasicMaterial[] = [];
  private gridGroup: THREE.Object3D | null = null;
  private flowMesh: THREE.Object3D | null = null;
  private readonly assets = new Map<string, AssetExtras>();
  private defs = new Map<string, AssetDef>();
  private plantBox = new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 2, 5));

  // parts
  private readonly partGeo = new THREE.BoxGeometry(PART.x, PART.y, PART.z);
  private readonly partEdges = new THREE.EdgesGeometry(this.partGeo);
  private readonly partMat = new THREE.MeshStandardMaterial({ color: 0xd2dce6, roughness: 0.35, metalness: 0.35, flatShading: true });
  private readonly partEdgeMat = new THREE.LineBasicMaterial({ color: 0x3a4048, transparent: true, opacity: 0.55 });
  private readonly parts = new Map<number, PartVis>();
  private readonly pool: THREE.Mesh[] = [];
  private tickInterval = 200;
  private lastTickAt = 0;

  // selection / hover
  private selGroup: THREE.Group | null = null;
  private readonly selLineMat = new THREE.LineBasicMaterial({ color: SELECT_COLOR, depthTest: false, transparent: true });
  private readonly selFootMat = new THREE.LineBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.9 });
  private readonly selPlateMat = new THREE.MeshBasicMaterial({ color: SELECT_COLOR, transparent: true, opacity: 0.12, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private hoverDirty = false;
  private hovered: string | null = null;
  private pointerIn = false;
  private pointerClient = { x: 0, y: 0 };
  private down: { x: number; y: number; b: number } | null = null;
  private tooltip!: HTMLDivElement;
  private coord!: HTMLDivElement;

  // view state
  private showLabels = true;
  private showGrid = true;
  private showFlow = true;
  private showLines = true;
  private zoneGroup: THREE.Group | null = null;
  private zones: ZoneVis[] = [];
  /** Dimmed (shift-Off) material variants, keyed by the original material. */
  private readonly dimMats = new Map<THREE.Material, THREE.Material>();
  private tween: Tween | null = null;
  private visible = true;
  private raf = 0;
  private lastFrame = 0;
  private readonly clock0 = performance.now();
  private width = 0;
  private height = 0;
  private readonly hudButtons = new Map<string, HTMLButtonElement>();
  private readonly unsubs: (() => void)[] = [];
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private needsFit = true;

  constructor(ctx: PanelContext) {
    this.store = ctx.store;
  }

  mount(host: HTMLElement): void {
    this.host = host;
    this.root = el('div', 'vp');
    host.appendChild(this.root);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = false;
    this.renderer.domElement.className = 'vp-canvas';
    this.root.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'vp-labels';
    this.root.appendChild(this.labels.domElement);

    this.scene.fog = this.fog;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.envGroup, this.plantGroup);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 250;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('start', this.onControlsStart);

    this.buildHud();
    this.tooltip = el('div', 'vp-tip');
    this.tooltip.hidden = true;
    this.coord = el('div', 'vp-coord');
    this.root.append(this.tooltip, this.coord);

    const cv = this.renderer.domElement;
    cv.addEventListener('pointermove', this.onPointerMove);
    cv.addEventListener('pointerdown', this.onPointerDown);
    cv.addEventListener('pointerup', this.onPointerUp);
    cv.addEventListener('pointerleave', this.onPointerLeave);
    cv.addEventListener('dblclick', this.onDblClick);
    cv.addEventListener('contextmenu', preventDefault);

    this.unsubs.push(
      this.store.on('snapshot', () => this.rebuild()),
      this.store.on('tick', () => this.onTick()),
      this.store.on('selection', () => this.updateSelection()),
      this.store.on('theme', () => this.applyTheme()),
    );

    this.ro = new ResizeObserver(() => this.resize(this.host.clientWidth, this.host.clientHeight));
    this.ro.observe(host);
    this.io = new IntersectionObserver((e) => (this.visible = e.some((x) => x.isIntersecting)));
    this.io.observe(host);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.applyTheme();
    this.resize(host.clientWidth, host.clientHeight);
    if (this.store.plant) this.rebuild();
    this.raf = requestAnimationFrame(this.frame);
    applyDevParams(this.store, (id) => this.focusAsset(id, false));
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.needsFit && this.store.plant) this.setView('iso', false);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    this.unsubs.length = 0;
    this.ro?.disconnect();
    this.io?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    const cv = this.renderer.domElement;
    cv.removeEventListener('pointermove', this.onPointerMove);
    cv.removeEventListener('pointerdown', this.onPointerDown);
    cv.removeEventListener('pointerup', this.onPointerUp);
    cv.removeEventListener('pointerleave', this.onPointerLeave);
    cv.removeEventListener('dblclick', this.onDblClick);
    cv.removeEventListener('contextmenu', preventDefault);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.clearPlant();
    meshCache.retain(new Set());
    for (const m of this.pool) m.removeFromParent();
    this.pool.length = 0;
    this.controls.dispose();
    this.gizmo.dispose();
    for (const d of [this.partGeo, this.partEdges, this.partMat, this.partEdgeMat, this.floorMat, this.safetyMat, this.flowMat,
      this.selLineMat, this.selFootMat, this.selPlateMat]) d.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.root.remove();
  }

  // ------------------------------------------------------------------ scene construction

  private clearPlant(): void {
    this.clearSelection();
    for (const a of this.assets.values()) {
      a.label.element.remove();
      a.res.element.remove();
      a.outline.geometry.dispose();
      a.outlineMat.dispose();
      // a.custom shares geometry/materials with the cached template (freed by meshCache.retain)
    }
    this.assets.clear();
    for (const m of this.dimMats.values()) m.dispose();
    this.dimMats.clear();
    for (const z of this.zones) { z.fill.dispose(); z.edge.dispose(); z.label.remove(); }
    this.zones = [];
    this.zoneGroup = null;
    this.plantGroup.clear();
    // floor, grid, safety tape and flow arrows own their geometry
    this.envGroup.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) g.dispose();
    });
    this.gridMats.forEach((m) => m.dispose());
    this.gridMats = [];
    this.gridGroup = null;
    this.flowMesh = null;
    this.envGroup.clear();
    this.kit?.dispose();
    this.kit = null;
    for (const p of this.parts.values()) this.releasePart(p);
    this.parts.clear();
  }

  private rebuild(): void {
    const plant = this.store.plant;
    this.clearPlant();
    if (!plant) return;
    const kit = (this.kit = new Kit());
    const glow = kit.glowTexture();
    this.defs = new Map(plant.assets.map((a) => [a.id, a]));
    const box = new THREE.Box3();
    // v0.3 custom meshes: keep cached templates the new plant still uses, free the rest
    meshCache.retain(new Set(plant.assets.map((a) => a.mesh).filter((u): u is string => !!u)));
    for (const def of plant.assets) {
      const view = buildAsset(def, { kit, glow, assets: plant.assets });
      const procedural = [...view.root.children];
      view.light.group.userData.noDim = true;
      this.plantGroup.add(view.root);
      view.root.updateMatrixWorld(true);
      box.union(view.bounds.clone().applyMatrix4(view.root.matrixWorld));

      const lblEl = el('div', 'vp-lbl');
      const dot = el('span', 'vp-lbl-dot');
      lblEl.append(dot, document.createTextNode(def.id));
      const label = new CSS2DObject(lblEl);
      label.position.set(0, view.bounds.max.y + 0.22, 0);
      label.center.set(0.5, 1);
      view.root.add(label);

      const ob = view.bounds.clone().expandByScalar(0.035);
      ob.min.y = 0.01;
      const size = ob.getSize(new THREE.Vector3());
      const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const edges = new THREE.EdgesGeometry(boxGeo);
      boxGeo.dispose();
      const outlineMat = new THREE.LineBasicMaterial({ color: 0xe8a317, transparent: true, opacity: 0.95 });
      const outline = new THREE.LineSegments(edges, outlineMat);
      outline.position.copy(ob.getCenter(new THREE.Vector3()));
      outline.visible = false;
      outline.userData.noPick = true;
      outline.userData.noDim = true;
      view.root.add(outline);

      const resEl = el('div', 'vp-res');
      resEl.hidden = true;
      const res = new CSS2DObject(resEl);
      res.position.copy(label.position);
      res.center.set(0.5, 1);
      view.root.add(res);

      const extras: AssetExtras = {
        view, label, labelDot: dot, outline, outlineMat, prog: { from: 0, to: 0, t0: 0, shown: 0 },
        procedural, custom: null, res, resKind: null, dimmed: false,
      };
      this.assets.set(def.id, extras);
      if (def.mesh) void this.loadMesh(extras, def.mesh);
    }
    if (!box.isEmpty()) this.plantBox = box;

    // floor + grid + tape + flow
    const ext = floorExtent(plant.assets, 30);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ext.x1 - ext.x0, ext.z1 - ext.z0), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((ext.x0 + ext.x1) / 2, 0, (ext.z0 + ext.z1) / 2);
    floor.receiveShadow = true;
    floor.userData.noPick = true;
    const grid = buildGrid(ext, new THREE.Color(cssVar('--vp-grid', '#7c838c')));
    this.gridMats = [grid.minor, grid.major];
    this.gridGroup = grid.group;
    this.gridGroup.visible = this.showGrid;
    this.flowMesh = buildFlowLines(plant.assets, this.flowMat);
    this.flowMesh.visible = this.showFlow;
    this.envGroup.add(floor, grid.group, buildSafetyLines(plant.assets, this.safetyMat), this.flowMesh);
    this.buildZones();

    // shadow frustum around the plant
    const c = this.plantBox.getCenter(new THREE.Vector3());
    const r = this.plantBox.getSize(new THREE.Vector3()).length() / 2 + 2;
    this.sun.position.set(c.x - r * 0.35, r * 1.1, c.z + r * 0.55);
    this.sun.target.position.copy(c);
    const sc = this.sun.shadow.camera;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 0.5; sc.far = r * 3.5;
    sc.updateProjectionMatrix();

    this.applyLabelVisibility();
    this.syncToggles();
    this.applyTheme();
    this.onTick();
    this.updateSelection();
    this.setView('iso', false);
  }

  // ------------------------------------------------------------------ live data

  private onTick(): void {
    const now = performance.now();
    if (this.lastTickAt) {
      const dt = now - this.lastTickAt;
      if (dt > 20 && dt < 2000) this.tickInterval = Math.min(600, Math.max(60, this.tickInterval * 0.8 + dt * 0.2));
    }
    this.lastTickAt = now;
    const plant = this.store.plant;
    if (!plant) return;

    // asset state → outline, label dot; cycle progress for animation
    for (const [id, a] of this.assets) {
      const st = this.store.assets.get(id);
      if (st?.state !== a.lastState) this.applyState(a, st?.state);
      this.applyV03Cues(a, st?.state);
      const p = st?.cycleProgress ?? 0;
      const pr = a.prog;
      pr.from = p + 0.25 < pr.shown ? p : pr.shown; // new cycle: restart instead of running backwards
      pr.shown = pr.from;
      pr.to = p;
      pr.t0 = now;
    }

    // parts: recycle meshes by id; FIFO rank gives the buffer slot
    const seen = new Set<number>();
    const rank = new Map<string, number>();
    for (const p of this.store.parts) {
      const def = this.defs.get(p.assetId);
      if (!def) continue;
      seen.add(p.id);
      const r = rank.get(p.assetId) ?? 0;
      rank.set(p.assetId, r + 1);
      const w = partWorldPosition(def, p.progress, { assets: plant.assets, slotIndex: def.kind === 'buffer' ? r : undefined });
      let vis = this.parts.get(p.id);
      if (!vis) {
        const mesh = this.acquirePart();
        mesh.position.set(w.x, w.y, w.z);
        vis = { mesh, from: mesh.position.clone(), to: mesh.position.clone(), t0: now, assetId: p.assetId, robot: false };
        this.parts.set(p.id, vis);
      }
      vis.assetId = p.assetId;
      vis.robot = def.kind === 'robot';
      vis.from.copy(vis.mesh.position);
      vis.to.set(w.x, w.y, w.z);
      vis.t0 = now;
      vis.mesh.rotation.y = THREE.MathUtils.degToRad(def.rotationY || 0);
    }
    for (const [id, vis] of this.parts) if (!seen.has(id)) { this.releasePart(vis); this.parts.delete(id); }

    if (this.hovered) this.updateTooltip();
  }

  private applyState(a: AssetExtras, s: AssetState['state'] | undefined): void {
    a.lastState = s;
    const col = stateColor(s, cssVar);
    a.labelDot.style.background = col;
    a.outlineMat.color.set(col);
    a.outlineMat.opacity = 0.95;
    a.outline.visible = isAbnormal(s);
  }

  // ------------------------------------------------------------------ v0.3: custom meshes

  private async loadMesh(a: AssetExtras, url: string): Promise<void> {
    const id = a.view.def.id;
    try {
      const template = await meshCache.load(url);
      if (this.assets.get(id) !== a || !this.kit) return; // plant was rebuilt meanwhile
      this.applyMesh(a, template);
    } catch (e) {
      if (this.assets.get(id) === a) console.warn(`[viewport] mesh '${url}' for ${id} could not be loaded; keeping the procedural model.`, e);
    }
  }

  /** Swap the procedural model for a fitted glTF instance, keeping a floor-standing stack light. */
  private applyMesh(a: AssetExtras, template: THREE.Object3D): void {
    const kit = this.kit!;
    const { view } = a;
    const def = view.def;
    let fitted: { group: THREE.Group; height: number };
    try {
      fitted = instantiateFitted(template, def.size, def.id);
    } catch (e) {
      console.warn(`[viewport] mesh for ${def.id} could not be instantiated; keeping the procedural model.`, e);
      return;
    }
    const wasDimmed = a.dimmed;
    if (wasDimmed) this.applyDim(a, false);
    for (const c of a.procedural) c.removeFromParent(); // geometry is owned by the Kit and freed with it
    a.procedural = [];
    view.root.add(fitted.group);
    a.custom = fitted.group;

    // stack light on a slim post at the rear-right corner of the size box
    const sx = def.size.x / 2, sz = def.size.z / 2;
    const px = sx - 0.06, pz = -sz + 0.06, postH = Math.max(0.3, fitted.height);
    const post = kit.cyl(view.root, 0.022, postH, kit.mats.steelDark, px, postH / 2, pz, 'y', 8);
    post.userData.assetId = def.id;
    const light = new StackLight(kit, view.root, px, pz, postH, kit.glowTexture());
    light.group.userData.noDim = true;
    light.group.traverse((o) => (o.userData.assetId = def.id));
    view.light = light;
    view.grip = undefined;
    view.animate = () => {};
    view.bounds = new THREE.Box3(new THREE.Vector3(-sx, 0, -sz), new THREE.Vector3(sx, Math.max(def.size.y, fitted.height, light.top), sz));

    // label, resource glyph and status outline follow the new bounds
    a.label.position.set(0, view.bounds.max.y + 0.22, 0);
    a.res.position.copy(a.label.position);
    const ob = view.bounds.clone().expandByScalar(0.035);
    ob.min.y = 0.01;
    const size = ob.getSize(new THREE.Vector3());
    const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
    a.outline.geometry.dispose();
    a.outline.geometry = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    a.outline.position.copy(ob.getCenter(new THREE.Vector3()));

    light.refreshColors();
    this.applyState(a, this.store.assets.get(def.id)?.state);
    if (wasDimmed) this.applyDim(a, true);
    if (this.store.selection === def.id) this.updateSelection();
  }

  // ------------------------------------------------------------------ v0.3: shift dimming, resource wait

  private applyV03Cues(a: AssetExtras, s: AssetState['state'] | undefined): void {
    const plant = this.store.plant;
    const def = a.view.def;
    const dim = shiftDimmed(plant, def, s, this.store.sim.simTimeMs);
    if (dim !== a.dimmed) this.applyDim(a, dim);
    const kind = resourceWait(plant, def, s);
    if (kind !== a.resKind) {
      a.resKind = kind;
      const e = a.res.element;
      e.hidden = !kind;
      if (kind) {
        const r = plant?.resources?.find((x) => x.id === def.resourceId);
        e.innerHTML = `<i>${RES_GLYPH[kind]}</i>`;
        e.title = `Waiting for ${r?.name ?? def.resourceId} (${kind})`;
      }
    }
  }

  /** Grey the model out (stack light, outline and selection excluded) by swapping in dimmed material variants. */
  private applyDim(a: AssetExtras, on: boolean): void {
    a.dimmed = on;
    a.label.element.classList.toggle('dim', on);
    const visit = (o: THREE.Object3D) => {
      if (o.userData.noDim || o === this.selGroup) return;
      const m = o as THREE.Mesh;
      if ((m.isMesh || (o as THREE.LineSegments).isLineSegments) && m.material && !Array.isArray(m.material)) {
        if (on) {
          if (!m.userData.baseMat) m.userData.baseMat = m.material;
          m.material = this.dimVariant(m.userData.baseMat as THREE.Material);
        } else if (m.userData.baseMat) {
          m.material = m.userData.baseMat as THREE.Material;
          delete m.userData.baseMat;
        }
      }
      for (const c of o.children) visit(c);
    };
    visit(a.view.root);
  }

  private dimVariant(base: THREE.Material): THREE.Material {
    let d = this.dimMats.get(base);
    if (d) return d;
    d = base.clone();
    const bg = new THREE.Color(cssVar('--vp-bg', '#c8ccd2'));
    const c = (d as THREE.MeshStandardMaterial).color;
    if (c) c.lerp(bg, 0.62);
    const em = (d as THREE.MeshStandardMaterial).emissive;
    if (em) em.multiplyScalar(0.15);
    if ((d as THREE.LineBasicMaterial).isLineBasicMaterial) d.opacity *= 0.45;
    this.dimMats.set(base, d);
    return d;
  }

  private refreshDim(): void {
    const dimmed = [...this.assets.values()].filter((a) => a.dimmed);
    for (const a of dimmed) this.applyDim(a, false);
    for (const m of this.dimMats.values()) m.dispose();
    this.dimMats.clear();
    for (const a of dimmed) this.applyDim(a, true);
  }

  // ------------------------------------------------------------------ v0.3: line zones

  private buildZones(): void {
    const plant = this.store.plant;
    if (!plant) return;
    const zones = lineZones(plant);
    if (!zones.length) return;
    const g = new THREE.Group();
    g.name = 'line-zones';
    for (const z of zones) {
      const w = z.x1 - z.x0, d = z.z1 - z.z0;
      const fill = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, d), fill);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set((z.x0 + z.x1) / 2, 0.003, (z.z0 + z.z1) / 2);
      plane.userData.noPick = true;
      plane.renderOrder = -1;
      const edge = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false });
      const y = 0.006;
      const pts = [z.x0, y, z.z0, z.x1, y, z.z0, z.x1, y, z.z1, z.x0, y, z.z1, z.x0, y, z.z0];
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const border = new THREE.Line(lg, edge);
      border.userData.noPick = true;
      const lbl = el('div', 'vp-zone');
      lbl.textContent = z.name;
      lbl.title = `${z.name} (${z.lineId}) - ${z.assets} asset${z.assets === 1 ? '' : 's'}`;
      const lo = new CSS2DObject(lbl);
      lo.position.set(z.x0, 0, z.z1);
      lo.center.set(0, 1);
      g.add(plane, border, lo);
      this.zones.push({ fill, edge, label: lbl, index: z.index });
    }
    g.visible = this.showLines;
    this.zoneGroup = g;
    this.envGroup.add(g);
  }

  private applyZoneTheme(): void {
    const dark = document.documentElement.dataset.theme === 'dark';
    for (const z of this.zones) {
      const col = cssVar(`--plot-${(z.index % 7) + 1}`, ZONE_FALLBACK[z.index % 7]);
      z.fill.color.set(col);
      z.fill.opacity = dark ? 0.16 : 0.13;
      z.edge.color.set(col);
      z.label.style.borderLeftColor = col;
    }
  }

  private acquirePart(): THREE.Mesh {
    const m = this.pool.pop();
    if (m) { m.visible = true; return m; }
    const mesh = new THREE.Mesh(this.partGeo, this.partMat);
    mesh.castShadow = true;
    mesh.userData.noPick = true;
    const e = new THREE.LineSegments(this.partEdges, this.partEdgeMat);
    e.userData.noPick = true;
    mesh.add(e);
    this.scene.add(mesh);
    return mesh;
  }

  private releasePart(p: PartVis): void {
    p.mesh.visible = false;
    this.pool.push(p.mesh);
  }

  // ------------------------------------------------------------------ frame loop

  private readonly gripTmp = new THREE.Vector3();

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (!this.visible || document.hidden || this.width < 2 || this.height < 2) return;
    if (this.lastFrame && now - this.lastFrame < FRAME_MS - 2) return; // 60 fps cap on high-refresh displays
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    const t = (now - this.clock0) / 1000;
    const simSpeed = this.store.sim.state === 'running' ? this.store.sim.speed : 0;

    if (this.tween) {
      const k = easeInOut((now - this.tween.start) / this.tween.dur);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, k);
      this.controls.target.lerpVectors(this.tween.t0v, this.tween.t1v, k);
      if (k >= 1) this.tween = null;
    }
    this.controls.update();
    const camDist = this.camera.position.distanceTo(this.controls.target);
    this.fog.near = camDist * 1.25;
    this.fog.far = camDist * 3.2;

    for (const a of this.assets.values()) {
      const st = this.store.assets.get(a.view.def.id);
      const pr = a.prog;
      const u = Math.min(1, (now - pr.t0) / this.tickInterval);
      pr.shown = pr.from + (pr.to - pr.from) * u;
      a.view.animate({ dt, t, state: st, simSpeed, progress: pr.shown });
      a.view.light.set(st?.state, t);
      if (a.outline.visible && st?.state === 'fault') a.outlineMat.opacity = lensOn('fault', t) ? 0.95 : 0.2;
    }

    // parts: linear interpolation across one tick interval (constant velocity, no jumps on asset change);
    // parts held by a robot follow its gripper.
    const kGrip = 1 - Math.exp(-16 * dt);
    for (const p of this.parts.values()) {
      const g = p.robot ? this.assets.get(p.assetId)?.view.grip : undefined;
      if (g) {
        g.getWorldPosition(this.gripTmp);
        this.gripTmp.y -= PART.y / 2 + 0.02;
        p.mesh.position.lerp(this.gripTmp, kGrip);
        continue;
      }
      const u = Math.min(1, (now - p.t0) / this.tickInterval);
      p.mesh.position.lerpVectors(p.from, p.to, u);
    }

    if (this.hoverDirty) { this.hoverDirty = false; this.pickHover(); }

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.gizmo.render(this.renderer, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  // ------------------------------------------------------------------ camera

  private setView(preset: ViewPreset, animate = true): void {
    const dir = preset === 'fit'
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3().copy(presetDirection(preset));
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.copy(presetDirection('iso'));
    this.frameBox(this.plantBox, dir, 1.05, animate);
    this.needsFit = this.width < 2;
  }

  private frameBox(box: THREE.Box3, dir: THREE.Vector3, margin: number, animate: boolean): void {
    const d = fitDistance(box, dir, this.camera.fov, this.camera.aspect, margin);
    const c = box.getCenter(new THREE.Vector3());
    const pos = c.clone().addScaledVector(dir, d);
    if (!animate) {
      this.tween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(c);
      this.controls.update();
      return;
    }
    this.tween = { p0: this.camera.position.clone(), p1: pos, t0v: this.controls.target.clone(), t1v: c, start: performance.now(), dur: 450 };
  }

  private focusAsset(id: string, animate = true): void {
    const a = this.assets.get(id);
    if (!a) return;
    a.view.root.updateMatrixWorld(true);
    const box = a.view.bounds.clone().applyMatrix4(a.view.root.matrixWorld);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.25) { dir.y = 0.45; dir.normalize(); }
    this.frameBox(box, dir, 1.9, animate);
  }

  // ------------------------------------------------------------------ selection

  private clearSelection(): void {
    if (!this.selGroup) return;
    this.selGroup.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g) g.dispose(); });
    this.selGroup.removeFromParent();
    this.selGroup = null;
  }

  private updateSelection(): void {
    this.clearSelection();
    for (const [id, a] of this.assets) a.label.element.classList.toggle('sel', id === this.store.selection);
    const a = this.store.selection ? this.assets.get(this.store.selection) : undefined;
    if (!a) return;
    const b = a.view.bounds.clone().expandByScalar(0.08);
    b.min.y = 0;
    const g = new THREE.Group();
    const brackets = new THREE.LineSegments(bracketGeometry(b), this.selLineMat);
    brackets.renderOrder = 10;
    const foot = new THREE.Line(footprintGeometry(b, 0.012), this.selFootMat);
    const size = b.getSize(new THREE.Vector3());
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.z), this.selPlateMat);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set((b.min.x + b.max.x) / 2, 0.008, (b.min.z + b.max.z) / 2);
    g.add(brackets, foot, plate);
    g.traverse((o) => (o.userData.noPick = true));
    a.view.root.add(g);
    this.selGroup = g;
  }

  // ------------------------------------------------------------------ picking & tooltip

  private pickAt(clientX: number, clientY: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.plantGroup.children, true);
    for (const h of hits) {
      const o = h.object;
      if (!(o as THREE.Mesh).isMesh || o.userData.noPick || !o.visible) continue;
      return (o.userData.assetId as string | undefined) ?? null;
    }
    return null;
  }

  private readonly floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly floorHit = new THREE.Vector3();

  private pickHover(): void {
    if (!this.pointerIn) return;
    const id = this.pickAt(this.pointerClient.x, this.pointerClient.y);
    const hit = this.raycaster.ray.intersectPlane(this.floorPlane, this.floorHit);
    this.coord.textContent = hit ? `X ${fmtCoord(hit.x)}   Z ${fmtCoord(hit.z)}  m` : '';
    if (id !== this.hovered) {
      this.hovered = id;
      this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    }
    this.updateTooltip();
  }

  private updateTooltip(): void {
    const id = this.hovered;
    const def = id ? this.defs.get(id) : undefined;
    if (!def || !this.pointerIn) { this.tooltip.hidden = true; return; }
    const st = this.store.assets.get(def.id);
    const s = st?.state ?? 'idle';
    const since = st ? Math.max(0, (this.store.sim.simTimeMs - st.stateSinceMs) / 1000) : 0;
    this.tooltip.innerHTML =
      `<div class="vp-tip-h"><b>${esc(def.id)}</b><span>${esc(def.kind)}</span></div>` +
      `<div class="vp-tip-n">${esc(def.name)}</div>` +
      `<div class="vp-tip-s"><i style="background:${stateColor(s, cssVar)}"></i>${STATE_LABEL[s]}<span class="num">${fmtDur(since)}</span></div>` +
      this.tipV03(def, s) +
      (st ? `<div class="vp-tip-g"><span>WIP</span><b class="num">${st.wip}</b><span>Good</span><b class="num">${st.good}</b><span>Scrap</span><b class="num">${st.scrap}</b>` +
        `<span>Load</span><b class="num">${(st.load * 100).toFixed(0)} %</b><span>Wear</span><b class="num">${(st.wear * 100).toFixed(1)} %</b></div>` : '');
    this.tooltip.hidden = false;
    const r = this.root.getBoundingClientRect();
    let x = this.pointerClient.x - r.left + 14, y = this.pointerClient.y - r.top + 18;
    const tw = this.tooltip.offsetWidth, th = this.tooltip.offsetHeight;
    if (x + tw > r.width - 4) x = this.pointerClient.x - r.left - tw - 10;
    if (y + th > r.height - 4) y = this.pointerClient.y - r.top - th - 10;
    this.tooltip.style.transform = `translate(${Math.max(2, x)}px, ${Math.max(2, y)}px)`;
  }

  /** v0.3 tooltip rows: line, resource, shift (with the reason for Off / Starved). */
  private tipV03(def: AssetDef, s: AssetState['state']): string {
    const plant = this.store.plant;
    const rows: string[] = [];
    const line = def.lineId ? plant?.lines?.find((l) => l.id === def.lineId) : undefined;
    if (def.lineId) rows.push(`<span>Line</span><b>${esc(line?.name ?? def.lineId)}</b>`);
    if (def.resourceId) {
      const r = plant?.resources?.find((x) => x.id === def.resourceId);
      const wait = resourceWait(plant, def, s);
      rows.push(`<span>Resource</span><b${wait ? ' class="warn"' : ''}>${esc(r ? `${r.name} x${r.count}` : def.resourceId)}${wait ? ' (waiting)' : ''}</b>`);
    }
    if (def.shiftId) {
      const sh = shiftOf(plant, def);
      const off = shiftDimmed(plant, def, s, this.store.sim.simTimeMs);
      const win = sh ? ` ${pad2(sh.startHour)}-${pad2(sh.endHour)} h` : '';
      rows.push(`<span>Shift</span><b>${esc(sh?.name ?? def.shiftId)}${win}${off ? ' (off shift)' : ''}</b>`);
    }
    if (def.mesh) rows.push(`<span>Mesh</span><b>${this.assets.get(def.id)?.custom ? 'custom glTF' : 'procedural (fallback)'}</b>`);
    return rows.length ? `<div class="vp-tip-x">${rows.join('')}</div>` : '';
  }

  private readonly onControlsStart = (): void => { this.tween = null; };
  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pointerIn = true;
    this.pointerClient = { x: e.clientX, y: e.clientY };
    this.hoverDirty = true;
  };
  private readonly onPointerLeave = (): void => {
    this.pointerIn = false;
    this.hovered = null;
    this.tooltip.hidden = true;
    this.coord.textContent = '';
  };
  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY, b: e.button };
  };
  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || d.b !== 0 || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    this.store.select(this.pickAt(e.clientX, e.clientY));
  };
  private readonly onDblClick = (e: MouseEvent): void => {
    const id = this.pickAt(e.clientX, e.clientY);
    if (id) { this.store.select(id); this.focusAsset(id); } else this.setView('fit');
  };
  private readonly onVisibility = (): void => { this.lastFrame = 0; };

  // ------------------------------------------------------------------ HUD

  private buildHud(): void {
    const hud = el('div', 'vp-hud');
    const btn = (key: string, text: string, title: string, fn: () => void, toggle = false) => {
      const b = el('button', 'vp-btn');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      if (toggle) b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', fn);
      hud.appendChild(b);
      this.hudButtons.set(key, b);
    };
    const sep = () => hud.appendChild(el('span', 'vp-sep'));
    btn('iso', 'Iso', 'Isometric view', () => this.setView('iso'));
    btn('top', 'Top', 'Plan view (top)', () => this.setView('top'));
    btn('front', 'Front', 'Front elevation', () => this.setView('front'));
    btn('fit', 'Fit', 'Zoom to fit all (or double-click empty space)', () => this.setView('fit'));
    sep();
    btn('labels', 'Labels', 'Show asset id labels', () => { this.showLabels = !this.showLabels; this.applyLabelVisibility(); }, true);
    btn('grid', 'Grid', 'Show 1 m floor grid', () => { this.showGrid = !this.showGrid; if (this.gridGroup) this.gridGroup.visible = this.showGrid; this.syncToggles(); }, true);
    btn('flow', 'Flow', 'Show material-flow arrows', () => { this.showFlow = !this.showFlow; if (this.flowMesh) this.flowMesh.visible = this.showFlow; this.syncToggles(); }, true);
    btn('lines', 'Lines', 'Show production-line zones (plants with lines)', () => { this.showLines = !this.showLines; if (this.zoneGroup) this.zoneGroup.visible = this.showLines; this.syncToggles(); }, true);
    this.root.appendChild(hud);
  }

  private syncToggles(): void {
    this.hudButtons.get('labels')?.setAttribute('aria-pressed', String(this.showLabels));
    this.hudButtons.get('grid')?.setAttribute('aria-pressed', String(this.showGrid));
    this.hudButtons.get('flow')?.setAttribute('aria-pressed', String(this.showFlow));
    const lines = this.hudButtons.get('lines');
    if (lines) {
      lines.setAttribute('aria-pressed', String(this.showLines && this.zones.length > 0));
      lines.disabled = this.zones.length === 0;
    }
  }

  private applyLabelVisibility(): void {
    // asset id labels only; line-zone names and resource glyphs have their own toggles/conditions
    this.labels.domElement.classList.toggle('no-ids', !this.showLabels);
    this.syncToggles();
  }

  // ------------------------------------------------------------------ theme

  private applyTheme(): void {
    const bg = new THREE.Color(cssVar('--vp-bg', '#c8ccd2'));
    this.scene.background = bg;
    this.fog.color.copy(bg);
    this.floorMat.color.set(cssVar('--vp-floor', '#9da3ab'));
    const grid = cssVar('--vp-grid', '#7c838c');
    this.gridMats.forEach((m) => m.color.set(grid));
    const dark = document.documentElement.dataset.theme === 'dark';
    this.hemi.intensity = dark ? 1.1 : 1.5;
    this.hemi.groundColor.set(dark ? 0x30343a : 0x8a8f96);
    this.sun.intensity = dark ? 1.6 : 2.1;
    this.flowMat.color.set(dark ? 0x6f95c4 : 0x3f5f86);
    this.flowMat.opacity = dark ? 0.6 : 0.5;
    this.safetyMat.color.set(dark ? 0xb89400 : 0xf2c200);
    for (const a of this.assets.values()) {
      a.view.light.refreshColors();
      this.applyState(a, this.store.assets.get(a.view.def.id)?.state);
    }
    this.applyZoneTheme();
    this.refreshDim();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmtCoord(v: number): string {
  return (v < 0 ? '' : '+') + v.toFixed(2);
}

function fmtDur(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)} s`;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m < 60 ? `${m}:${String(s).padStart(2, '0')}` : `${Math.floor(m / 60)} h ${m % 60} m`;
}

function pad2(h: number): string {
  return String(h).padStart(2, '0');
}

const ZONE_FALLBACK = ['#0072bd', '#d95319', '#edb120', '#7e2f8e', '#77ac30', '#4dbeee', '#a2142f'];

/** 12px resource glyphs (operator figure, AGV, tool). */
const RES_GLYPH: Record<ResourceKind, string> = {
  operator: '<svg viewBox="0 0 12 12" width="12" height="12"><circle cx="6" cy="2.6" r="1.9" fill="currentColor"/><path d="M2.2 11.5V8a3.8 3.8 0 0 1 7.6 0v3.5z" fill="currentColor"/></svg>',
  agv: '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1" y="4" width="10" height="4.5" fill="currentColor"/><rect x="3" y="2" width="4" height="2" fill="currentColor"/><circle cx="3.2" cy="9.6" r="1.4" fill="currentColor"/><circle cx="8.8" cy="9.6" r="1.4" fill="currentColor"/></svg>',
  tool: '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M8.2 1a2.8 2.8 0 0 0-2.7 3.5L1.3 8.7a1.2 1.2 0 0 0 1.7 1.7l4.2-4.2A2.8 2.8 0 0 0 10.7 3.5L9.2 5 7.4 4.6 7 2.8 8.5 1.3A2.8 2.8 0 0 0 8.2 1z" fill="currentColor"/></svg>',
};

function preventDefault(e: Event): void {
  e.preventDefault();
}

export const createViewportPanel: PanelFactory = (ctx) => new ViewportPanel(ctx);
