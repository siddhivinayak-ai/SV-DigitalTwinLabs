import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { AssetDef, AssetState } from '../net/contracts';
import type { Panel, PanelContext, PanelFactory } from '../panels/panel';
import type { TwinStore } from '../state/store';
import { cssVar } from '../charts/theme';
import { buildAsset, type AssetView } from './assets';
import { easeInOut, fitDistance, presetDirection, type ViewPreset } from './camera';
import { applyDevParams } from './dev';
import { bracketGeometry, buildFlowLines, buildGrid, buildSafetyLines, floorExtent, footprintGeometry } from './floor';
import { AxisGizmo } from './gizmo';
import { Kit } from './kit';
import { PART, partWorldPosition } from './placement';
import { isAbnormal, lensOn, STATE_LABEL, stateColor } from './status';
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
}

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
      a.outline.geometry.dispose();
      a.outlineMat.dispose();
    }
    this.assets.clear();
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
    for (const def of plant.assets) {
      const view = buildAsset(def, { kit, glow, assets: plant.assets });
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
      view.root.add(outline);

      this.assets.set(def.id, { view, label, labelDot: dot, outline, outlineMat, prog: { from: 0, to: 0, t0: 0, shown: 0 } });
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

    // shadow frustum around the plant
    const c = this.plantBox.getCenter(new THREE.Vector3());
    const r = this.plantBox.getSize(new THREE.Vector3()).length() / 2 + 2;
    this.sun.position.set(c.x - r * 0.35, r * 1.1, c.z + r * 0.55);
    this.sun.target.position.copy(c);
    const sc = this.sun.shadow.camera;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 0.5; sc.far = r * 3.5;
    sc.updateProjectionMatrix();

    this.applyLabelVisibility();
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
    if (this.showLabels) this.labels.render(this.scene, this.camera);
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
    this.root.appendChild(hud);
  }

  private syncToggles(): void {
    this.hudButtons.get('labels')?.setAttribute('aria-pressed', String(this.showLabels));
    this.hudButtons.get('grid')?.setAttribute('aria-pressed', String(this.showGrid));
    this.hudButtons.get('flow')?.setAttribute('aria-pressed', String(this.showFlow));
  }

  private applyLabelVisibility(): void {
    this.labels.domElement.style.display = this.showLabels ? '' : 'none';
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

function preventDefault(e: Event): void {
  e.preventDefault();
}

export const createViewportPanel: PanelFactory = (ctx) => new ViewportPanel(ctx);
