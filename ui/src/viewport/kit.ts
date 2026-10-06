import * as THREE from 'three';

/**
 * Shared low-poly building blocks for the procedural plant: unit geometries scaled per mesh,
 * a small flat-shaded material library, and bookkeeping so dispose() frees everything it made.
 */
export type MatName =
  | 'paint' | 'paintDark' | 'steel' | 'steelDark' | 'belt' | 'rubber' | 'glass' | 'pallet' | 'carton'
  | 'billet' | 'part' | 'screen' | 'deck' | 'hazard' | 'lens' | 'cable';

export interface BoxOpts { edges?: boolean; cast?: boolean; receive?: boolean; pick?: boolean }

export class Kit {
  readonly box1 = new THREE.BoxGeometry(1, 1, 1);
  readonly boxEdges = new THREE.EdgesGeometry(this.box1);
  private readonly cyls = new Map<number, THREE.CylinderGeometry>();
  private readonly owned: { dispose(): void }[] = [];
  readonly edgeMat = new THREE.LineBasicMaterial({ color: 0x1e2226, transparent: true, opacity: 0.32 });
  readonly mats: Record<MatName, THREE.MeshStandardMaterial>;

  constructor() {
    const m = (color: number, roughness = 0.7, metalness = 0.05, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness, flatShading: true, ...extra });
    this.mats = {
      paint: m(0xc4c8cb, 0.62),          // RAL 7035 light grey
      paintDark: m(0x41474d, 0.7),       // RAL 7016 anthracite
      steel: m(0xa3aab1, 0.42, 0.35),
      steelDark: m(0x5f666d, 0.5, 0.3),
      belt: m(0x2a2d31, 0.92),
      rubber: m(0x1b1d20, 0.95),
      glass: m(0x7d97a8, 0.08, 0.1, { transparent: true, opacity: 0.26, depthWrite: false }),
      pallet: m(0x8f887b, 0.95),
      carton: m(0xa79a80, 0.9),
      billet: m(0x8b9198, 0.45, 0.45),
      part: m(0xdfe3e8, 0.35, 0.35),
      screen: m(0x14202b, 0.35, 0, { emissive: new THREE.Color(0x1f4d73), emissiveIntensity: 0.55 }),
      deck: m(0x9aa0a6, 0.6, 0.2),
      hazard: m(0xffffff, 0.8, 0, { map: this.hazardTexture() }),
      lens: m(0x333333, 0.3),
      cable: m(0x23262a, 0.9),
    };
  }

  /** Track an object (geometry/material/texture) for disposal. */
  own<T extends { dispose(): void }>(o: T): T {
    this.owned.push(o);
    return o;
  }

  cylGeo(seg: number): THREE.CylinderGeometry {
    let g = this.cyls.get(seg);
    if (!g) this.cyls.set(seg, (g = new THREE.CylinderGeometry(1, 1, 1, seg, 1)));
    return g;
  }

  private finish<T extends THREE.Mesh>(mesh: T, o: BoxOpts): T {
    mesh.castShadow = o.cast ?? true;
    mesh.receiveShadow = o.receive ?? true;
    if (o.pick === false) mesh.userData.noPick = true;
    return mesh;
  }

  /** Axis-aligned box from min/max corners (local to `parent`). */
  boxB(parent: THREE.Object3D, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: THREE.Material, o: BoxOpts = {}): THREE.Mesh {
    const mesh = new THREE.Mesh(this.box1, mat);
    mesh.scale.set(Math.max(1e-3, Math.abs(x1 - x0)), Math.max(1e-3, Math.abs(y1 - y0)), Math.max(1e-3, Math.abs(z1 - z0)));
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    if (o.edges) mesh.add(new THREE.LineSegments(this.boxEdges, this.edgeMat));
    parent.add(mesh);
    return this.finish(mesh, o);
  }

  /** Box by centre and size. */
  box(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, o: BoxOpts = {}): THREE.Mesh {
    return this.boxB(parent, x - w / 2, y - h / 2, z - d / 2, x + w / 2, y + h / 2, z + d / 2, mat, o);
  }

  /** Cylinder of radius r and length h centred at (x,y,z) along an axis. */
  cyl(parent: THREE.Object3D, r: number, h: number, mat: THREE.Material, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 16, o: BoxOpts = {}): THREE.Mesh {
    const mesh = new THREE.Mesh(this.cylGeo(seg), mat);
    mesh.scale.set(r, h, r);
    if (axis === 'x') mesh.rotation.z = Math.PI / 2;
    if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return this.finish(mesh, o);
  }

  /** Material owned by one asset (lenses, animated bits). */
  mat(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    return this.own(new THREE.MeshStandardMaterial({ flatShading: true, ...params }));
  }

  private hazardTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f2c200';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#1c1c1c';
    for (let i = -64; i < 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 16, 0); g.lineTo(i + 16 + 64, 64); g.lineTo(i + 64, 64); g.fill(); }
    const t = this.own(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  /** Radial glow sprite texture for lit lenses. */
  glowTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const t = this.own(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  dispose(): void {
    this.box1.dispose();
    this.boxEdges.dispose();
    this.cyls.forEach((g) => g.dispose());
    this.cyls.clear();
    this.edgeMat.dispose();
    for (const m of Object.values(this.mats)) { m.map?.dispose(); m.dispose(); }
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }
}
