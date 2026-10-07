import * as THREE from 'three';

/** Mini XYZ axis triad rendered in a corner of the main canvas (red X, green Y, blue Z, CAD convention). */
export class AxisGizmo {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);
  private readonly disposables: { dispose(): void }[] = [];
  size = 84;

  constructor() {
    const axes: [THREE.Vector3, string, string][] = [
      [new THREE.Vector3(1, 0, 0), '#e0453a', 'X'],
      [new THREE.Vector3(0, 1, 0), '#5aa531', 'Y'],
      [new THREE.Vector3(0, 0, 1), '#2f7fe0', 'Z'],
    ];
    const shaft = this.track(new THREE.CylinderGeometry(0.045, 0.045, 1, 8));
    const cone = this.track(new THREE.ConeGeometry(0.13, 0.3, 12));
    const hub = this.track(new THREE.SphereGeometry(0.09, 12, 8));
    const hubMat = this.track(new THREE.MeshBasicMaterial({ color: 0x8a8f96 }));
    this.scene.add(new THREE.Mesh(hub, hubMat));
    for (const [dir, color, label] of axes) {
      const mat = this.track(new THREE.MeshBasicMaterial({ color }));
      const g = new THREE.Group();
      const s = new THREE.Mesh(shaft, mat); s.position.y = 0.5;
      const c = new THREE.Mesh(cone, mat); c.position.y = 1.12;
      g.add(s, c);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.scene.add(g);
      const sprite = new THREE.Sprite(this.track(new THREE.SpriteMaterial({ map: this.labelTexture(label, color), depthTest: false })));
      sprite.position.copy(dir).multiplyScalar(1.5);
      sprite.scale.setScalar(0.5);
      this.scene.add(sprite);
    }
  }

  private track<T extends { dispose(): void }>(o: T): T {
    this.disposables.push(o);
    return o;
  }

  private labelTexture(text: string, color: string): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.font = 'bold 44px Tahoma, Segoe UI, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.strokeText(text, 32, 34);
    g.fillStyle = color;
    g.fillText(text, 32, 34);
    const t = this.track(new THREE.CanvasTexture(c));
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Render into the bottom-left corner after the main pass (depth cleared, colour kept). */
  render(renderer: THREE.WebGLRenderer, main: THREE.Camera): void {
    this.camera.quaternion.copy(main.quaternion);
    this.camera.position.set(0, 0, 4).applyQuaternion(main.quaternion);
    const m = 6;
    renderer.clearDepth();
    renderer.setViewport(m, m, this.size, this.size);
    renderer.render(this.scene, this.camera);
    const size = renderer.getSize(new THREE.Vector2());
    renderer.setViewport(0, 0, size.x, size.y);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
