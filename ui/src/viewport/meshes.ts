// Custom glTF/GLB asset meshes (v0.3 `asset.mesh`). Loads once per URL, hands out clones that share
// geometry/materials, and frees GPU resources for URLs the current plant no longer uses.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fitMeshToBox } from './v03';
import type { Vec3 } from '../net/contracts';

interface Entry { promise: Promise<THREE.Object3D>; scene?: THREE.Object3D; disposed: boolean }

export class MeshCache {
  private readonly loader = new GLTFLoader();
  private readonly entries = new Map<string, Entry>();

  /** Load (or reuse) a template scene for a URL. Rejects on network/parse errors. */
  load(url: string): Promise<THREE.Object3D> {
    let e = this.entries.get(url);
    if (!e) {
      const entry: Entry = { disposed: false, promise: Promise.resolve(null as unknown as THREE.Object3D) };
      entry.promise = this.loader.loadAsync(url).then((gltf) => {
        const scene = gltf.scene ?? gltf.scenes?.[0];
        if (!scene) throw new Error('glTF has no scene');
        if (entry.disposed) { disposeObject(scene); throw new Error('mesh evicted while loading'); }
        entry.scene = scene;
        return scene;
      });
      entry.promise.catch(() => { if (this.entries.get(url) === entry) this.entries.delete(url); }); // allow retry on next rebuild
      this.entries.set(url, (e = entry));
    }
    return e.promise;
  }

  /** Dispose cached meshes whose URL is not in `keep` (call on plant rebuild). */
  retain(keep: Set<string>): void {
    for (const url of [...this.entries.keys()]) if (!keep.has(url)) this.evict(url);
  }

  /** Drop one URL (e.g. deleted in the Mesh Library). */
  evict(url: string): void {
    const e = this.entries.get(url);
    if (!e) return;
    e.disposed = true;
    if (e.scene) disposeObject(e.scene);
    this.entries.delete(url);
  }

  dispose(): void {
    for (const url of [...this.entries.keys()]) this.evict(url);
  }
}

/** Shared cache: the Mesh Library evicts deleted meshes from it. */
export const meshCache = new MeshCache();

/**
 * Clone a template and fit it into the asset size box (asset-local frame; the asset root already carries
 * position and rotationY). Returns the wrapper group and the fitted height.
 */
export function instantiateFitted(template: THREE.Object3D, size: Vec3, assetId: string): { group: THREE.Group; height: number } {
  const inst = template.clone(true);
  inst.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inst, true);
  const fit = box.isEmpty()
    ? fitMeshToBox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, size)
    : fitMeshToBox(box.min, box.max, size);
  const group = new THREE.Group();
  group.name = 'custom-mesh';
  group.scale.setScalar(fit.scale);
  group.position.set(fit.offset.x, fit.offset.y, fit.offset.z);
  group.add(inst);
  group.traverse((o) => {
    o.userData.assetId = assetId;
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  return { group, height: fit.fitted.y };
}

/** Dispose every geometry, material and texture under an object. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v && typeof v === 'object' && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      mat.dispose();
    }
  });
}
