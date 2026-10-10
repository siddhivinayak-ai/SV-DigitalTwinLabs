import { describe, expect, it } from 'vitest';
import plantV03 from '../../../contracts/examples/plant.v03.json';
import type { PlantModel } from '../net/contracts';
import { formatBytes, HttpMeshBackend, meshContentType, meshUsers, withAssetMesh } from './api';

const plant = plantV03 as unknown as PlantModel;
const bytes = (s: string) => new TextEncoder().encode(s);

describe('mesh upload content type', () => {
  it('sniffs GLB magic and JSON glTF regardless of the extension', () => {
    expect(meshContentType('x.bin', bytes('glTF\u0002\u0000'))).toBe('model/gltf-binary');
    expect(meshContentType('x.glb', bytes('  \n{"asset":{}}'))).toBe('model/gltf+json');
    expect(meshContentType('x.gltf', new Uint8Array([0xef, 0xbb, 0xbf, 0x7b]))).toBe('model/gltf+json');
  });
  it('rejects other content and falls back to the extension without bytes', () => {
    expect(meshContentType('x.glb', bytes('PK\u0003\u0004'))).toBeNull();
    expect(meshContentType('a.GLB')).toBe('model/gltf-binary');
    expect(meshContentType('a.gltf')).toBe('model/gltf+json');
    expect(meshContentType('a.obj')).toBeNull();
  });
});

describe('plant mesh edits', () => {
  it('sets and clears one asset mesh on a copy', () => {
    const next = withAssetMesh(plant, 'SRC-A', '/api/meshes/z/file');
    expect(next.assets.find((a) => a.id === 'SRC-A')!.mesh).toBe('/api/meshes/z/file');
    expect(plant.assets.find((a) => a.id === 'SRC-A')!.mesh).toBeUndefined();
    const cleared = withAssetMesh(plant, 'CNC-A', null);
    expect('mesh' in cleared.assets.find((a) => a.id === 'CNC-A')!).toBe(false);
    expect(() => withAssetMesh(plant, 'NOPE', null)).toThrow(/Unknown asset/);
  });
  it('finds users of a mesh', () => {
    expect(meshUsers(plant, '/api/meshes/a41b7e/file')).toEqual(['CNC-A']);
    expect(meshUsers(null, 'x')).toEqual([]);
  });
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(38624)).toBe('37.7 KB');
    expect(formatBytes(1843200)).toBe('1.8 MB');
  });
});

describe('HttpMeshBackend', () => {
  it('lists, deletes and PUTs the plant, surfacing validation issues', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).endsWith('/plant')) {
        return new Response(JSON.stringify({ title: 'Plant has critical issues', status: 422, issues: [{ severity: 'critical', code: 'MESH_URL', message: 'bad' }] }),
          { status: 422, headers: { 'content-type': 'application/problem+json' } });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('[{"id":"a","name":"a.glb","url":"/api/meshes/a/file","sizeBytes":1}]', { headers: { 'content-type': 'application/json' } });
    };
    const b = new HttpMeshBackend('/api', fake as typeof fetch);
    expect((await b.list())[0].id).toBe('a');
    await b.remove('a b');
    expect(calls[1]).toMatchObject(['/api/meshes/a%20b', { method: 'DELETE' }]);
    await expect(b.applyPlant(plant)).rejects.toThrow(/MESH_URL: bad/);
    expect(calls[2][1]!.method).toBe('PUT');
  });
});
