import * as THREE from 'three';
import type { AssetDef, AssetState } from '../net/contracts';
import { cssVar } from '../charts/theme';
import type { Kit } from './kit';
import { bufferSlot, CONVEYOR, INSPECTION, machineTableH, machineVariant, PALLET_H, rackLayout, robotTargets } from './placement';
import { ROBOT, robotPose, robotReadyPose, solveArm, type Joints, type ToolPose } from './robot';
import { lensOn, litLens, stateColor, type Lens } from './status';

/** Per-frame inputs for asset animation. */
export interface FrameInfo {
  dt: number;          // wall seconds since last frame
  t: number;           // wall seconds (monotonic)
  state?: AssetState;
  simSpeed: number;    // sim seconds per wall second (0 when paused)
  /** Smoothed cycle progress (machines/robots), interpolated between ticks. */
  progress: number;
}

export interface AssetView {
  def: AssetDef;
  /** Positioned + rotated root (asset-local frame). */
  root: THREE.Group;
  /** Local bounds of the asset including its stack light. */
  bounds: THREE.Box3;
  light: StackLight;
  /** Robot only: grip point that carries the part. */
  grip?: THREE.Object3D;
  animate(f: FrameInfo): void;
}

const LENS_ORDER: Lens[] = ['blue', 'green', 'amber', 'red']; // bottom → top
const LENS_STATE = { red: 'fault', amber: 'starved', green: 'running', blue: 'maintenance' } as const;

/** Four-tier stack light (top→bottom red, amber, green, blue) on a pole. ISA-101 colour lives only here. */
export class StackLight {
  readonly group = new THREE.Group();
  private readonly lenses = new Map<Lens, { mat: THREE.MeshStandardMaterial; glow: THREE.Sprite; color: THREE.Color }>();
  private current: Lens | null = null;
  private on = false;
  readonly top: number;

  constructor(kit: Kit, parent: THREE.Object3D, x: number, z: number, baseY: number, glowTex: THREE.Texture) {
    parent.add(this.group);
    this.group.position.set(x, baseY, z);
    const poleH = 0.18;
    kit.cyl(this.group, 0.022, poleH, kit.mats.steelDark, 0, poleH / 2, 0, 'y', 8);
    kit.cyl(this.group, 0.05, 0.03, kit.mats.paintDark, 0, poleH + 0.015, 0, 'y', 12);
    let y = poleH + 0.03;
    const h = 0.075;
    for (const lens of LENS_ORDER) {
      const color = new THREE.Color(stateColor(LENS_STATE[lens], cssVar));
      const mat = kit.mat({ color: color.clone().multiplyScalar(0.28), roughness: 0.35, metalness: 0, transparent: true, opacity: 0.92 });
      kit.cyl(this.group, 0.048, h - 0.006, mat, 0, y + h / 2, 0, 'y', 12, { cast: false });
      const smat = kit.own(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85 }));
      const glow = new THREE.Sprite(smat);
      glow.scale.setScalar(0.42);
      glow.position.set(0, y + h / 2, 0);
      glow.visible = false;
      glow.userData.noPick = true;
      this.group.add(glow);
      this.lenses.set(lens, { mat, glow, color });
      y += h;
    }
    kit.cyl(this.group, 0.05, 0.025, kit.mats.paintDark, 0, y + 0.0125, 0, 'y', 12);
    this.top = baseY + y + 0.025;
  }

  /** Re-read the --s-* tokens (theme change). */
  refreshColors(): void {
    for (const [lens, l] of this.lenses) {
      l.color.set(stateColor(LENS_STATE[lens], cssVar));
      (l.glow.material as THREE.SpriteMaterial).color.copy(l.color);
    }
    this.current = null;
  }

  set(state: AssetState['state'] | undefined, t: number): void {
    const lit = litLens(state);
    const on = lit != null && lensOn(state, t);
    if (lit === this.current && on === this.on) return;
    this.current = lit;
    this.on = on;
    for (const [lens, l] of this.lenses) {
      const active = lens === lit && on;
      l.mat.color.copy(l.color).multiplyScalar(active ? 1 : 0.26);
      l.mat.emissive.copy(l.color).multiplyScalar(active ? 0.95 : 0);
      l.glow.visible = active;
    }
  }
}

// ---------------------------------------------------------------------------------------------

interface Ctx { kit: Kit; glow: THREE.Texture; assets: readonly AssetDef[] }
type Built = { light: StackLight; grip?: THREE.Object3D; animate?: (f: FrameInfo) => void };

export function buildAsset(def: AssetDef, ctx: Ctx): AssetView {
  const root = new THREE.Group();
  root.name = def.id;
  root.position.set(def.position.x, def.position.y, def.position.z);
  root.rotation.y = THREE.MathUtils.degToRad(def.rotationY || 0);
  root.userData.assetId = def.id;
  let built: Built;
  switch (def.kind) {
    case 'conveyor': built = buildConveyor(def, root, ctx); break;
    case 'buffer': built = buildBuffer(def, root, ctx); break;
    case 'robot': built = buildRobot(def, root, ctx); break;
    case 'inspection': built = buildInspection(def, root, ctx); break;
    case 'source': built = buildSource(def, root, ctx); break;
    case 'sink': built = buildSink(def, root, ctx); break;
    case 'machine': {
      const v = machineVariant(def);
      built = v === 'press' ? buildPress(def, root, ctx) : v === 'pack' ? buildPack(def, root, ctx) : buildCnc(def, root, ctx);
      break;
    }
  }
  root.traverse((o) => { o.userData.assetId = def.id; });
  const sx = def.size.x / 2, sz = def.size.z / 2;
  const bounds = new THREE.Box3(new THREE.Vector3(-sx, 0, -sz), new THREE.Vector3(sx, Math.max(def.size.y, built.light.top), sz));
  if (def.kind === 'robot') { const r = ROBOT.upper * 0.5 + 0.6; bounds.min.set(-r, 0, -r); bounds.max.set(r, Math.max(def.size.y, built.light.top) + 0.2, r); }
  return { def, root, bounds, light: built.light, grip: built.grip, animate: built.animate ?? (() => {}) };
}

// ---------------------------------------------------------------- CNC mill (enclosure + window + spindle)

function buildCnc(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  const x0 = -SX / 2, x1 = SX / 2, z0 = -SZ / 2, z1 = SZ / 2;
  const cab = Math.min(0.62, SX * 0.22);          // control cabinet column on +X
  const xm = x1 - cab;                            // enclosure/cabinet split
  const t = 0.05;
  const tableH = machineTableH('cnc', SY);
  const plinth = 0.12;
  kit.boxB(g, x0, 0, z0, x1, plinth, z1, M.paintDark, { edges: true });
  // shell: back, left side, roof, cabinet
  kit.boxB(g, x0, plinth, z0, xm, SY - 0.1, z0 + t, M.paint, { edges: true });
  kit.boxB(g, x0, plinth, z0, x0 + t, SY - 0.1, z1, M.paint, { edges: true });
  kit.boxB(g, x0, SY - 0.1, z0, xm, SY, z1, M.paint, { edges: true, cast: true });
  kit.boxB(g, xm, plinth, z0, x1, SY, z1, M.paint, { edges: true });
  // front: apron below the window, header above, pillars, sliding doors with windows
  const winY0 = tableH + 0.12, winY1 = SY - 0.32;
  kit.boxB(g, x0, plinth, z1 - t, xm, winY0, z1, M.paint, { edges: true });
  kit.boxB(g, x0, winY1, z1 - t, xm, SY - 0.1, z1, M.paint, { edges: true });
  kit.boxB(g, x0, plinth, z1 - 0.2, x0 + 0.02, SY - 0.1, z1, M.paint);
  const doorW = (xm - x0) / 2;
  for (let i = 0; i < 2; i++) {
    const dx0 = x0 + i * doorW, dx1 = dx0 + doorW;
    kit.boxB(g, dx0, winY0, z1 - t, dx0 + 0.09, winY1, z1, M.paint, { edges: true });
    kit.boxB(g, dx1 - 0.09, winY0, z1 - t, dx1, winY1, z1, M.paint, { edges: true });
    kit.boxB(g, dx0 + 0.09, winY0, z1 - t * 0.5, dx1 - 0.09, winY1, z1 - t * 0.3, M.glass, { cast: false, receive: false });
    kit.box(g, 0.03, 0.42, 0.04, M.steel, i === 0 ? dx1 - 0.16 : dx0 + 0.16, (winY0 + winY1) / 2, z1 + 0.02);
  }
  // hazard strip on the apron, door rail
  kit.boxB(g, x0 + 0.05, plinth + 0.02, z1, xm - 0.05, plinth + 0.09, z1 + 0.004, M.hazard, { cast: false });
  kit.boxB(g, x0, winY1, z1, xm, winY1 + 0.05, z1 + 0.04, M.steelDark);
  // cabinet: HMI pendant, vents
  kit.boxB(g, xm + 0.08, tableH + 0.35, z1, x1 - 0.08, tableH + 0.85, z1 + 0.04, M.paintDark, { edges: true });
  kit.boxB(g, xm + 0.11, tableH + 0.42, z1 + 0.04, x1 - 0.11, tableH + 0.78, z1 + 0.045, M.screen, { cast: false });
  for (let i = 0; i < 4; i++) kit.boxB(g, xm + 0.1, 0.3 + i * 0.07, z1, x1 - 0.1, 0.33 + i * 0.07, z1 + 0.01, M.steelDark, { cast: false });
  kit.cyl(g, 0.035, 0.03, M.lens, x1 - 0.14, tableH + 0.25, z1 + 0.015, 'z', 12); // e-stop body
  // interior: bed, fixture, column, spindle head
  const bedX0 = x0 + 0.25, bedX1 = xm - 0.25;
  kit.boxB(g, bedX0, plinth, z0 + 0.3, bedX1, tableH - 0.06, z1 - 0.35, M.paintDark, { edges: true });
  kit.boxB(g, bedX0 + 0.15, tableH - 0.06, z0 + 0.45, bedX1 - 0.15, tableH, z1 - 0.5, M.steel, { edges: true });
  kit.box(g, 0.42, 0.06, 0.34, M.steelDark, -0.15, tableH + 0.03, 0, {});
  const colX = (bedX0 + bedX1) / 2 - 0.15;
  kit.boxB(g, colX - 0.32, tableH, z0 + t, colX + 0.32, SY - 0.12, z0 + 0.42, M.paint, { edges: true });
  const head = new THREE.Group();
  head.position.set(-0.15, 0, 0);
  g.add(head);
  const headTop = SY - 0.16;
  kit.boxB(head, -0.2, headTop - 0.48, -0.55, 0.2, headTop, 0.18, M.paint, { edges: true });
  kit.cyl(head, 0.09, 0.2, M.steelDark, 0, headTop - 0.58, 0, 'y', 16);
  const tool = new THREE.Group();
  tool.position.set(0, headTop - 0.68, 0);
  head.add(tool);
  kit.cyl(tool, 0.035, 0.12, M.steel, 0, -0.01, 0, 'y', 6);
  kit.cyl(tool, 0.018, 0.1, M.steel, 0, -0.11, 0, 'y', 6);
  const headRest = 0, headWork = -(headTop - 0.68 - 0.18 - (tableH + 0.24));
  const light = new StackLight(kit, g, x1 - cab / 2, z0 + 0.15, SY, glow);
  let headY = 0;
  return {
    light,
    animate(f) {
      const running = f.state?.state === 'running' && f.simSpeed > 0;
      const target = running ? headWork + 0.04 * Math.sin(f.t * 3.1) : headRest;
      headY += (target - headY) * Math.min(1, f.dt * 4);
      head.position.y = headY;
      head.position.x = -0.15 + (running ? 0.07 * Math.sin(f.t * 1.3) : 0);
      if (running) tool.rotation.y += f.dt * 50;
    },
  };
}

// ---------------------------------------------------------------- belt conveyor

function beltTexture(kit: Kit): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2c2f33'; g.fillRect(0, 0, 64, 16);
  g.fillStyle = '#3d4146'; for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 3, 16);
  const t = kit.own(new THREE.CanvasTexture(c));
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildConveyor(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  const L = SX, bw = SZ * 0.72, H = SY;
  const tex = beltTexture(kit);
  tex.repeat.set(L / 0.5, 1);
  const beltMat = kit.mat({ color: 0xffffff, map: tex, roughness: 0.9, metalness: 0 });
  kit.boxB(g, -L / 2 + 0.05, H - CONVEYOR.beltThk, -bw / 2, L / 2 - 0.05, H, bw / 2, beltMat, { cast: true });
  // end drums
  for (const sx of [-1, 1]) kit.cyl(g, 0.06, bw + 0.02, M.steel, sx * (L / 2 - 0.06), H - 0.06, 0, 'z', 14);
  // side frames (channel) with guide rail
  for (const sz of [-1, 1]) {
    const zc = sz * (bw / 2 + 0.035);
    kit.boxB(g, -L / 2, H - 0.16, zc - 0.03, L / 2, H + 0.015, zc + 0.03, M.steel, { edges: true });
    kit.boxB(g, -L / 2 + 0.1, H + 0.06, zc - 0.012, L / 2 - 0.1, H + 0.085, zc + 0.012, M.steelDark, { cast: false });
    for (let x = -L / 2 + 0.4; x <= L / 2 - 0.3; x += 1.2) kit.boxB(g, x - 0.01, H + 0.015, zc - 0.008, x + 0.01, H + 0.06, zc + 0.008, M.steelDark, { cast: false });
  }
  // return rollers
  for (let x = -L / 2 + 0.5; x < L / 2 - 0.3; x += 1.0) kit.cyl(g, 0.03, bw, M.steelDark, x, H - 0.22, 0, 'z', 8, { cast: false });
  // legs + braces
  const n = Math.max(2, Math.ceil(L / 1.6) + 1);
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + 0.15 + (i * (L - 0.3)) / (n - 1);
    for (const sz of [-1, 1]) {
      const zc = sz * (bw / 2 + 0.035);
      kit.boxB(g, x - 0.025, 0.02, zc - 0.025, x + 0.025, H - 0.16, zc + 0.025, M.steelDark);
      kit.boxB(g, x - 0.06, 0, zc - 0.06, x + 0.06, 0.02, zc + 0.06, M.steelDark, { cast: false });
    }
    kit.boxB(g, x - 0.02, 0.22, -bw / 2, x + 0.02, 0.26, bw / 2, M.steelDark, { cast: false });
  }
  // drive: gearbox + motor at the outfeed end, operator side
  const dx = L / 2 - 0.12, dz = bw / 2 + 0.07;
  kit.boxB(g, dx - 0.1, H - 0.2, dz, dx + 0.1, H - 0.02, dz + 0.16, M.paintDark, { edges: true });
  kit.cyl(g, 0.065, 0.26, M.paintDark, dx, H - 0.11, dz + 0.29, 'z', 12);
  kit.cyl(g, 0.07, 0.03, M.steelDark, dx, H - 0.11, dz + 0.43, 'z', 12);
  // stack light post at the infeed end, back side
  kit.boxB(g, -L / 2 + 0.1, H - 0.16, -bw / 2 - 0.12, -L / 2 + 0.14, H + 0.32, -bw / 2 - 0.08, M.steelDark);
  const light = new StackLight(kit, g, -L / 2 + 0.12, -bw / 2 - 0.1, H + 0.32, glow);
  const speed = def.params.speedMps ?? 0.25;
  return {
    light,
    animate(f) {
      if (f.state?.state === 'running' && f.simSpeed > 0) tex.offset.x -= (speed * f.simSpeed * f.dt) / 0.5;
    },
  };
}

// ---------------------------------------------------------------- buffer rack

function buildBuffer(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  const L = rackLayout(def);
  const x0 = -SX / 2, x1 = SX / 2, z0 = -SZ * 0.4, z1 = SZ * 0.4;
  for (const x of [x0, x1]) for (const z of [z0, z1]) {
    kit.boxB(g, x - 0.035, 0, z - 0.035, x + 0.035, SY, z + 0.035, M.paintDark, { edges: true });
    kit.boxB(g, x - 0.07, 0, z - 0.07, x + 0.07, 0.015, z + 0.07, M.steelDark, { cast: false });
  }
  for (const x of [x0, x1]) for (let y = 0.25; y < SY - 0.1; y += 0.3) kit.boxB(g, x - 0.012, y, z0, x + 0.012, y + 0.02, z1, M.steelDark, { cast: false });
  const levels = [...L.shelfY, SY - 0.04];
  levels.forEach((y, li) => {
    for (const z of [z0, z1]) kit.boxB(g, x0, y - 0.07, z - 0.03, x1, y, z + 0.03, M.paintDark, { edges: true });
    if (li < L.shelfY.length) kit.boxB(g, x0 + 0.03, y, z0, x1 - 0.03, y + 0.022, z1, M.deck, { edges: true });
  });
  // slot markers on the decks
  for (let i = 0; i < L.levels * L.cols; i++) {
    const s = bufferSlot(def, i);
    kit.boxB(g, s.x - 0.17, s.y - 0.09 - 0.002, -0.15, s.x + 0.17, s.y - 0.09 + 0.002, 0.15, M.paintDark, { cast: false });
  }
  const light = new StackLight(kit, g, x1, z0, SY, glow);
  return { light };
}

// ---------------------------------------------------------------- 6-axis robot

function buildRobot(def: AssetDef, g: THREE.Group, { kit, glow, assets }: Ctx): Built {
  const M = kit.mats;
  const R = ROBOT;
  // floor plate + pedestal + base
  kit.boxB(g, -0.42, 0, -0.42, 0.42, 0.04, 0.42, M.steelDark, { edges: true });
  kit.cyl(g, 0.28, 0.32, M.paintDark, 0, 0.2, 0, 'y', 16);
  kit.cyl(g, 0.3, R.baseH - 0.36, M.paint, 0, (0.36 + R.baseH) / 2, 0, 'y', 16);
  const j1 = new THREE.Group(); j1.position.y = R.baseH; g.add(j1);
  kit.cyl(j1, 0.26, 0.12, M.paint, 0, 0.06, 0, 'y', 16);
  kit.boxB(j1, -0.18, 0.1, -0.2, R.shoulderR + 0.14, R.shoulderH - R.baseH + 0.12, 0.2, M.paint, { edges: true });
  kit.cyl(j1, 0.1, 0.24, M.paintDark, -0.14, 0.32, -0.26, 'z', 12); // J2 motor
  const j2 = new THREE.Group(); j2.position.set(R.shoulderR, R.shoulderH - R.baseH, 0); j1.add(j2);
  kit.cyl(j2, 0.16, 0.48, M.paintDark, 0, 0, 0, 'z', 16);
  kit.boxB(j2, -0.11, 0, -0.12, 0.11, R.upper, 0.12, M.paint, { edges: true });
  const j3 = new THREE.Group(); j3.position.set(0, R.upper, 0); j2.add(j3);
  kit.cyl(j3, 0.13, 0.36, M.paintDark, 0, 0, 0, 'z', 16);
  kit.boxB(j3, -0.22, -0.12, -0.13, 0.25, 0.12, 0.13, M.paint, { edges: true });
  kit.cyl(j3, 0.08, 0.2, M.paintDark, -0.3, 0, 0, 'x', 12); // J3/J4 motor pack
  const j4 = new THREE.Group(); j3.add(j4);
  kit.cyl(j4, 0.075, R.fore - 0.3, M.paint, 0.25 + (R.fore - 0.3) / 2, 0, 0, 'x', 12);
  const j5 = new THREE.Group(); j5.position.set(R.fore, 0, 0); j4.add(j5);
  kit.boxB(j5, -0.1, -0.07, -0.09, 0.03, 0.07, -0.05, M.paint);
  kit.boxB(j5, -0.1, -0.07, 0.05, 0.03, 0.07, 0.09, M.paint);
  kit.cyl(j5, 0.065, 0.14, M.paintDark, 0, 0, 0, 'z', 12);
  const j6 = new THREE.Group(); j6.position.set(0.07, 0, 0); j5.add(j6);
  kit.cyl(j6, 0.05, 0.05, M.steelDark, 0.025, 0, 0, 'x', 12);
  kit.boxB(j6, 0.05, -0.06, -0.12, 0.12, 0.06, 0.12, M.steelDark, { edges: true });
  const fingers: THREE.Mesh[] = [];
  for (const s of [-1, 1]) fingers.push(kit.boxB(j6, 0.12, -0.025, s * 0.1 - 0.015, R.tool - 0.07 + 0.11, 0.025, s * 0.1 + 0.015, M.steel));
  const grip = new THREE.Object3D(); grip.position.set(R.tool - 0.07, 0, 0); j6.add(grip);
  // cable loop along the upper arm
  kit.cyl(j2, 0.022, R.upper * 0.8, M.cable, -0.14, R.upper * 0.45, 0, 'y', 6, { cast: false });
  // controller cabinet behind the robot
  const cab = new THREE.Group(); cab.position.set(0.0, 0, -0.72); g.add(cab);
  kit.boxB(cab, -0.3, 0, -0.18, 0.3, 1.05, 0.18, M.paintDark, { edges: true });
  kit.boxB(cab, -0.2, 0.75, 0.18, 0.05, 0.92, 0.185, M.screen, { cast: false });
  const light = new StackLight(kit, cab, 0.22, 0.05, 1.05, glow);

  const { pick, place } = robotTargets(def, assets);
  const cur: Joints = solveArm(robotReadyPose(pick));
  const setJoints = () => {
    j1.rotation.y = cur.j1; j2.rotation.z = cur.j2; j3.rotation.z = cur.j3;
    j4.rotation.x = cur.j4; j5.rotation.z = cur.j5; j6.rotation.x = cur.j6;
  };
  setJoints();
  let grip01 = 0;
  return {
    light,
    grip,
    animate(f) {
      const s = f.state?.state;
      let pose: ToolPose | null;
      if (s === 'running') pose = robotPose(f.progress, pick, place);
      else if (s === 'blocked') pose = robotPose(1, pick, place);
      else if (s === 'starved' || s === 'idle') pose = robotReadyPose(pick);
      else pose = null; // fault / maintenance / off: hold position
      if (!pose) return;
      const tgt = solveArm(pose);
      const swing = Math.min(1, Math.max(0, (f.progress - 0.22) / 0.4));
      tgt.j4 = s === 'running' ? 0.25 * Math.sin(swing * Math.PI) : 0;
      tgt.j6 = s === 'running' ? (Math.PI / 2) * swing : 0;
      const a = 1 - Math.exp(-10 * Math.min(f.dt, 0.1));
      cur.j1 += (tgt.j1 - cur.j1) * a; cur.j2 += (tgt.j2 - cur.j2) * a; cur.j3 += (tgt.j3 - cur.j3) * a;
      cur.j4 += (tgt.j4 - cur.j4) * a; cur.j5 += (tgt.j5 - cur.j5) * a; cur.j6 += (tgt.j6 - cur.j6) * a;
      setJoints();
      const closed = s === 'running' && f.progress > 0.06 && f.progress < 0.84 ? 1 : s === 'blocked' ? 1 : 0;
      grip01 += (closed - grip01) * a;
      fingers.forEach((m, i) => { m.position.z = (i ? 1 : -1) * (0.1 - 0.04 * grip01); });
    },
  };
}

// ---------------------------------------------------------------- vision inspection (gantry + camera)

function buildInspection(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  const H = INSPECTION.tableH;
  const L = SX * 0.92, bw = 0.5;
  // short belt section
  kit.boxB(g, -L / 2, H - 0.04, -bw / 2, L / 2, H, bw / 2, M.belt);
  for (const sz of [-1, 1]) {
    kit.boxB(g, -L / 2, H - 0.14, sz * (bw / 2 + 0.03) - 0.025, L / 2, H + 0.012, sz * (bw / 2 + 0.03) + 0.025, M.steel, { edges: true });
    for (const sx of [-1, 1]) kit.boxB(g, sx * (L / 2 - 0.1) - 0.025, 0, sz * (bw / 2 + 0.03) - 0.025, sx * (L / 2 - 0.1) + 0.025, H - 0.14, sz * (bw / 2 + 0.03) + 0.025, M.steelDark);
  }
  // gantry posts + beam (spanning Z)
  const pz = SZ / 2 - 0.08, top = SY - 0.12;
  for (const sz of [-1, 1]) {
    kit.boxB(g, -0.06, 0, sz * pz - 0.06, 0.06, top, sz * pz + 0.06, M.paint, { edges: true });
    kit.boxB(g, -0.14, 0, sz * pz - 0.14, 0.14, 0.02, sz * pz + 0.14, M.steelDark, { cast: false });
  }
  kit.boxB(g, -0.09, top, -pz - 0.06, 0.09, SY, pz + 0.06, M.paint, { edges: true });
  // camera + lens + ring light
  const camY = H + 0.62;
  kit.boxB(g, -0.03, camY + 0.18, -0.03, 0.03, top, 0.03, M.steelDark);
  kit.boxB(g, -0.11, camY + 0.02, -0.09, 0.11, camY + 0.2, 0.09, M.paintDark, { edges: true });
  kit.cyl(g, 0.045, 0.1, M.rubber, 0, camY - 0.03, 0, 'y', 12);
  const ringMat = kit.mat({ color: 0xd8dde2, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.15, roughness: 0.4 });
  const ring = new THREE.Mesh(kit.own(new THREE.TorusGeometry(0.13, 0.025, 6, 16)), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, camY - 0.14, 0);
  g.add(ring);
  // reject bin on the operator side
  const bz = bw / 2 + 0.12;
  kit.boxB(g, 0.2, 0, bz, 0.7, 0.42, bz + 0.38, M.paintDark, { edges: true });
  kit.boxB(g, 0.24, 0.42, bz + 0.04, 0.66, 0.425, bz + 0.34, M.rubber, { cast: false });
  // panel PC
  kit.boxB(g, -L / 2 - 0.02, H + 0.15, pz - 0.1, -L / 2 + 0.03, H + 0.5, pz + 0.12, M.paintDark, { edges: true });
  const light = new StackLight(kit, g, 0, pz, SY, glow);
  return {
    light,
    animate(f) {
      const s = f.state?.state;
      const flash = s === 'running' && Math.abs(f.progress - 0.5) < 0.06;
      ringMat.emissiveIntensity += ((flash ? 1.6 : s === 'running' ? 0.35 : 0.08) - ringMat.emissiveIntensity) * Math.min(1, f.dt * 12);
    },
  };
}

// ---------------------------------------------------------------- source / sink (pallet, dock)

function pallet(kit: Kit, g: THREE.Object3D, w: number, d: number): void {
  const M = kit.mats;
  for (const x of [-w / 2 + 0.06, 0, w / 2 - 0.06]) kit.boxB(g, x - 0.05, 0, -d / 2, x + 0.05, 0.1, d / 2, M.pallet, { edges: true });
  for (let i = 0; i < 6; i++) { const z = -d / 2 + 0.05 + (i * (d - 0.1)) / 5; kit.boxB(g, -w / 2, 0.1, z - 0.05, w / 2, PALLET_H, z + 0.05, M.pallet, { edges: true }); }
}

function buildSource(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  const pw = Math.min(1.2, SX * 0.78), pd = Math.min(1.0, SZ * 0.66);
  pallet(kit, g, pw, pd);
  // billets: 3 x 3 x 2
  for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (k === 1 && i === 2 && j > 0) continue;
    const x = -pw / 2 + 0.2 + i * ((pw - 0.4) / 2), z = -pd / 2 + 0.17 + j * ((pd - 0.34) / 2);
    kit.box(g, 0.3, 0.22, 0.24, M.billet, x, PALLET_H + 0.11 + k * 0.225 + 0.002, z, { edges: true });
  }
  // feeder portal frame
  const fx = SX / 2 - 0.05, fz = SZ / 2 - 0.05;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.boxB(g, sx * fx - 0.04, 0, sz * fz - 0.04, sx * fx + 0.04, SY, sz * fz + 0.04, M.paint, { edges: true });
  for (const sz of [-1, 1]) kit.boxB(g, -fx, SY - 0.1, sz * fz - 0.045, fx, SY, sz * fz + 0.045, M.paint, { edges: true });
  kit.boxB(g, -0.12, SY - 0.1, -fz, 0.12, SY - 0.02, fz, M.steelDark, { edges: true });
  kit.boxB(g, -0.1, SY - 0.3, -0.1, 0.1, SY - 0.1, 0.1, M.paintDark, { edges: true });
  const light = new StackLight(kit, g, fx, -fz, SY, glow);
  return { light };
}

function buildSink(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  // dock plate with bumpers
  kit.boxB(g, -SX / 2, 0, -SZ / 2, SX / 2, 0.012, SZ / 2, M.steelDark, { cast: false, edges: true });
  kit.boxB(g, -SX / 2, 0.012, -SZ / 2, -SX / 2 + 0.08, 0.016, SZ / 2, M.hazard, { cast: false });
  for (const sz of [-1, 1]) kit.boxB(g, SX / 2 - 0.12, 0, sz * (SZ / 2 - 0.25) - 0.12, SX / 2, 0.3, sz * (SZ / 2 - 0.25) + 0.12, M.rubber);
  const pw = Math.min(1.2, SX * 0.75), pd = Math.min(1.0, SZ * 0.62);
  const p = new THREE.Group(); p.position.y = 0.012; g.add(p);
  pallet(kit, p, pw, pd);
  // cartons appear as good parts accumulate (2 layers x 3 x 2)
  const cartons: THREE.Mesh[] = [];
  for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    const m = kit.box(p, 0.36, 0.3, 0.44, M.carton, -pw / 2 + 0.2 + i * ((pw - 0.4) / 2), PALLET_H + 0.15 + k * 0.305, -pd / 2 + 0.25 + j * (pd - 0.5), { edges: true });
    m.visible = false;
    cartons.push(m);
  }
  kit.boxB(g, -SX / 2 + 0.05, 0, SZ / 2 - 0.12, -SX / 2 + 0.11, SY, SZ / 2 - 0.06, M.paint, { edges: true });
  const light = new StackLight(kit, g, -SX / 2 + 0.08, SZ / 2 - 0.09, SY, glow);
  let shown = -1;
  return {
    light,
    animate(f) {
      const good = f.state?.good ?? 0;
      const n = Math.min(cartons.length, Math.floor(good / 4) % (cartons.length + 1));
      if (n !== shown) { shown = n; cartons.forEach((c, i) => (c.visible = i < n)); }
    },
  };
}

// ---------------------------------------------------------------- press-fit assembly cell

function buildPress(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  const T = machineTableH('press', SY);
  const tw = SX * 0.62, td = SZ * 0.6;
  kit.boxB(g, -tw / 2, 0, -td / 2, tw / 2, T - 0.05, td / 2, M.paintDark, { edges: true });
  kit.boxB(g, -tw / 2 - 0.03, T - 0.05, -td / 2 - 0.03, tw / 2 + 0.03, T, td / 2 + 0.03, M.steel, { edges: true });
  kit.box(g, 0.4, 0.06, 0.34, M.steelDark, 0, T + 0.03, 0.05);
  // C-frame column at the back
  const cz0 = -td / 2 + 0.02, cz1 = cz0 + 0.3;
  kit.boxB(g, -0.22, T, cz0, 0.22, SY - 0.05, cz1, M.paint, { edges: true });
  kit.boxB(g, -0.22, SY - 0.42, cz1, 0.22, SY - 0.05, 0.3, M.paint, { edges: true });
  kit.cyl(g, 0.11, 0.3, M.paintDark, 0, SY + 0.08, 0.05, 'y', 14); // hydraulic cylinder
  const ram = new THREE.Group(); g.add(ram);
  kit.cyl(ram, 0.05, 0.4, M.steel, 0, SY - 0.6, 0.05, 'y', 12);
  kit.box(ram, 0.22, 0.06, 0.2, M.steelDark, 0, SY - 0.82, 0.05);
  // guarding: light-curtain posts at the front, mesh panels at the sides
  for (const sx of [-1, 1]) {
    kit.boxB(g, sx * (tw / 2 + 0.05) - 0.03, 0, td / 2 + 0.02, sx * (tw / 2 + 0.05) + 0.03, SY - 0.2, td / 2 + 0.08, M.paintDark);
    kit.boxB(g, sx * (tw / 2 + 0.05) - 0.012, T + 0.05, td / 2 + 0.081, sx * (tw / 2 + 0.05) + 0.012, SY - 0.3, td / 2 + 0.083, M.hazard, { cast: false });
    kit.boxB(g, sx * SX / 2 - 0.02, 0, -SZ / 2, sx * SX / 2 + 0.02, SY * 0.9, SZ / 2 - 0.25, M.glass, { cast: false, receive: false });
    kit.boxB(g, sx * SX / 2 - 0.03, SY * 0.9 - 0.04, -SZ / 2, sx * SX / 2 + 0.03, SY * 0.9, SZ / 2 - 0.25, M.paint);
    for (const z of [-SZ / 2, SZ / 2 - 0.25]) kit.boxB(g, sx * SX / 2 - 0.03, 0, z - 0.03, sx * SX / 2 + 0.03, SY * 0.9, z + 0.03, M.paint);
  }
  kit.boxB(g, -SX / 2, 0, -SZ / 2 - 0.02, SX / 2, SY * 0.9, -SZ / 2 + 0.02, M.glass, { cast: false, receive: false });
  kit.boxB(g, -SX / 2, SY * 0.9 - 0.04, -SZ / 2 - 0.03, SX / 2, SY * 0.9, -SZ / 2 + 0.03, M.paint);
  // two-hand control station
  kit.boxB(g, tw / 2 + 0.2, 0, td / 2 + 0.12, tw / 2 + 0.26, T + 0.1, td / 2 + 0.18, M.steelDark);
  kit.boxB(g, tw / 2 + 0.05, T + 0.1, td / 2 + 0.05, tw / 2 + 0.42, T + 0.22, td / 2 + 0.28, M.paintDark, { edges: true });
  const light = new StackLight(kit, g, 0.15, cz0 + 0.15, SY, glow);
  let ramY = 0;
  return {
    light,
    animate(f) {
      const running = f.state?.state === 'running';
      const stroke = running ? Math.max(0, Math.sin(Math.min(1, Math.max(0, (f.progress - 0.3) / 0.4)) * Math.PI)) : 0;
      const target = -0.22 * stroke;
      ramY += (target - ramY) * Math.min(1, f.dt * 10);
      ram.position.y = ramY;
    },
  };
}

// ---------------------------------------------------------------- packaging station

function buildPack(def: AssetDef, g: THREE.Group, { kit, glow }: Ctx): Built {
  const M = kit.mats;
  const { x: SX, y: SY, z: SZ } = def.size;
  const T = machineTableH('pack', SY);
  const tw = SX * 0.7, td = SZ * 0.55;
  kit.boxB(g, -tw / 2, 0, -td / 2, tw / 2, T, td / 2, M.paint, { edges: true });
  kit.boxB(g, -tw / 2, 0, td / 2, tw / 2, 0.12, td / 2 + 0.01, M.hazard, { cast: false });
  // open carton on the fixture
  const cx = 0, cz = 0.05, cw = 0.46, cd = 0.4, ch = 0.26;
  kit.boxB(g, cx - cw / 2, T, cz - cd / 2, cx + cw / 2, T + 0.012, cz + cd / 2, M.carton);
  for (const s of [-1, 1]) {
    kit.boxB(g, cx - cw / 2, T, cz + s * cd / 2 - 0.006, cx + cw / 2, T + ch, cz + s * cd / 2 + 0.006, M.carton, { edges: true });
    kit.boxB(g, cx + s * cw / 2 - 0.006, T, cz - cd / 2, cx + s * cw / 2 + 0.006, T + ch, cz + cd / 2, M.carton, { edges: true });
  }
  // portal with tape head
  const px = tw / 2 - 0.05;
  for (const s of [-1, 1]) kit.boxB(g, s * px - 0.05, T, -td / 2, s * px + 0.05, SY - 0.05, -td / 2 + 0.1, M.paint, { edges: true });
  kit.boxB(g, -px - 0.05, SY - 0.15, -td / 2, px + 0.05, SY - 0.03, -td / 2 + 0.12, M.paint, { edges: true });
  const headG = new THREE.Group(); g.add(headG);
  kit.boxB(headG, -0.1, SY - 0.15, -td / 2 + 0.1, 0.1, SY - 0.05, 0.12, M.steelDark);
  kit.boxB(headG, -0.12, SY - 0.55, 0.0, 0.12, SY - 0.15, 0.16, M.paintDark, { edges: true });
  kit.cyl(headG, 0.07, 0.04, M.carton, 0, SY - 0.32, 0.18, 'z', 14);
  // flat-carton magazine at the back
  kit.boxB(g, -tw / 2 + 0.1, T, -SZ / 2 + 0.05, tw / 2 - 0.1, T + 0.05, -td / 2 - 0.02, M.steelDark);
  for (let i = 0; i < 6; i++) kit.boxB(g, -0.4, T + 0.05 + i * 0.03, -SZ / 2 + 0.1, 0.4, T + 0.075 + i * 0.03, -td / 2 - 0.06, M.carton, { edges: i === 5 });
  const light = new StackLight(kit, g, px, -td / 2 + 0.05, SY, glow);
  let headY = 0;
  return {
    light,
    animate(f) {
      const running = f.state?.state === 'running';
      const target = running ? -0.18 * Math.max(0, Math.sin(Math.min(1, Math.max(0, (f.progress - 0.55) / 0.35)) * Math.PI)) : 0;
      headY += (target - headY) * Math.min(1, f.dt * 8);
      headG.position.y = headY;
    },
  };
}
