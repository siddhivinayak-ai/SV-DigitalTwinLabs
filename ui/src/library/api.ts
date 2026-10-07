// Mesh Library REST client (docs/V0.3-PlantBuilder.md §4) plus a small in-browser backend for Demo mode.
// Pure helpers (content-type sniffing, plant patching, formatting) are unit-tested.
import type { MeshInfo, PlantModel, SnapshotData } from '../net/contracts';
import { ApiError, problemMessage, type ProblemDetails } from '../net/api';

export type MeshContentType = 'model/gltf-binary' | 'model/gltf+json';

/** Content type for an upload: sniff the GLB magic / JSON brace first, then fall back to the extension. */
export function meshContentType(name: string, head?: Uint8Array): MeshContentType | null {
  if (head && head.length >= 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46) return 'model/gltf-binary'; // "glTF"
  if (head && head.length) {
    let i = 0;
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3; // UTF-8 BOM
    while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
    if (head[i] === 0x7b) return 'model/gltf+json'; // "{"
    if (i < head.length) return null; // neither magic: the server would reject it (400)
  }
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'glb' ? 'model/gltf-binary' : ext === 'gltf' ? 'model/gltf+json' : null;
}

export const MAX_MESH_BYTES = 20 * 1024 * 1024;

/** "1.8 MB", "38.0 KB", "512 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A copy of the plant with one asset's mesh set (or removed when `url` is null). Throws for unknown assets. */
export function withAssetMesh(plant: PlantModel, assetId: string, url: string | null): PlantModel {
  const next = structuredClone(plant);
  const a = next.assets.find((x) => x.id === assetId);
  if (!a) throw new Error(`Unknown asset '${assetId}'`);
  if (url) a.mesh = url; else delete a.mesh;
  return next;
}

/** Asset ids in the plant that use a mesh URL. */
export function meshUsers(plant: PlantModel | null | undefined, url: string): string[] {
  return plant?.assets.filter((a) => a.mesh === url).map((a) => a.id) ?? [];
}

export interface MeshBackend {
  readonly kind: 'http' | 'demo';
  list(): Promise<MeshInfo[]>;
  upload(file: Blob, name: string, onProgress?: (frac: number) => void): Promise<MeshInfo>;
  remove(id: string): Promise<void>;
  /** Apply a plant (live: PUT /api/plant). Resolves with the server snapshot. */
  applyPlant(plant: PlantModel): Promise<SnapshotData | null>;
}

async function readError(res: Response): Promise<ApiError> {
  const type = res.headers.get('content-type') ?? '';
  const body: unknown = type.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  let msg = problemMessage(res.status, res.statusText, body);
  const issues = (body as { issues?: { severity: string; code: string; message: string }[] } | null)?.issues;
  if (Array.isArray(issues) && issues.length) {
    const crit = issues.filter((i) => i.severity === 'critical');
    msg += `\n${(crit.length ? crit : issues).slice(0, 6).map((i) => `• ${i.code}: ${i.message}`).join('\n')}`;
  }
  return new ApiError(msg, res.status, type.includes('json') ? (body as ProblemDetails) : undefined);
}

/** Live server backend. */
export class HttpMeshBackend implements MeshBackend {
  readonly kind = 'http' as const;
  constructor(private readonly base = '/api', private readonly fetchImpl: typeof fetch = (i, init) => fetch(i, init)) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(`Server unreachable (${(e as Error)?.message ?? e})`, 0);
    }
    if (!res.ok) throw await readError(res);
    return res;
  }

  async list(): Promise<MeshInfo[]> {
    return (await (await this.call('GET', '/meshes')).json()) as MeshInfo[];
  }

  upload(file: Blob, name: string, onProgress?: (frac: number) => void): Promise<MeshInfo> {
    return new Promise((resolve, reject) => {
      void file.slice(0, 64).arrayBuffer().then((buf) => {
        const type = meshContentType(name, new Uint8Array(buf));
        if (!type) { reject(new ApiError('Not a glTF file: expected a .glb (glTF magic) or a .gltf JSON document', 400)); return; }
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${this.base}/meshes?name=${encodeURIComponent(name)}`);
        xhr.setRequestHeader('Content-Type', type);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
        xhr.onerror = () => reject(new ApiError('Server unreachable (upload failed)', 0));
        xhr.onload = () => {
          let body: unknown = xhr.responseText;
          try { body = JSON.parse(xhr.responseText); } catch { /* text */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(body as MeshInfo);
          else reject(new ApiError(problemMessage(xhr.status, xhr.statusText, body), xhr.status));
        };
        xhr.send(file);
      }, reject);
    });
  }

  async remove(id: string): Promise<void> {
    await this.call('DELETE', `/meshes/${encodeURIComponent(id)}`);
  }

  async applyPlant(plant: PlantModel): Promise<SnapshotData | null> {
    return (await (await this.call('PUT', '/plant', plant)).json()) as SnapshotData;
  }
}

/**
 * Demo-mode backend: meshes live in this browser tab as object URLs; "applying" a plant re-applies the
 * current state as a snapshot with the new plant (the mock simulation itself is not changed).
 */
export class DemoMeshBackend implements MeshBackend {
  readonly kind = 'demo' as const;
  private readonly items: MeshInfo[] = [];
  private seq = 0;

  constructor(seed: MeshInfo[] = [], private readonly apply: (plant: PlantModel) => SnapshotData | null = () => null) {
    this.items.push(...seed);
  }

  async list(): Promise<MeshInfo[]> { return [...this.items]; }

  async upload(file: Blob, name: string, onProgress?: (frac: number) => void): Promise<MeshInfo> {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    if (!meshContentType(name, head)) throw new ApiError('Not a glTF file: expected a .glb (glTF magic) or a .gltf JSON document', 400);
    if (file.size > MAX_MESH_BYTES) throw new ApiError('File is larger than 20 MB', 413);
    onProgress?.(1);
    const info: MeshInfo = { id: `demo${++this.seq}`, name, url: URL.createObjectURL(file), sizeBytes: file.size };
    this.items.push(info);
    return info;
  }

  async remove(id: string): Promise<void> {
    const i = this.items.findIndex((m) => m.id === id);
    if (i < 0) throw new ApiError(`Mesh '${id}' not found`, 404);
    const [m] = this.items.splice(i, 1);
    if (m.url.startsWith('blob:')) URL.revokeObjectURL(m.url);
  }

  async applyPlant(plant: PlantModel): Promise<SnapshotData | null> { return this.apply(plant); }
}
