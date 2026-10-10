// Generates reactor.glb: a small, hand-built glTF 2.0 binary (no deps) used to test the viewport mesh
// path and the Mesh Library. Modelled in millimetres with an off-centre origin on purpose, so the
// viewport has to scale, centre and ground it.  Run: node src/library/__fixtures__/make-fixture.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const prims = []; // { pos:number[], nrm:number[], mat:number }

function tri(p, n, a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  for (const q of [a, b, c]) { p.push(...q); n.push(nx, ny, nz); }
}
function quad(p, n, a, b, c, d) { tri(p, n, a, b, c); tri(p, n, a, c, d); }

function box(x0, y0, z0, x1, y1, z1, mat) {
  const p = [], n = [];
  const v = (x, y, z) => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
  quad(p, n, v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)); // +z
  quad(p, n, v(1, 0, 0), v(0, 0, 0), v(0, 1, 0), v(1, 1, 0)); // -z
  quad(p, n, v(1, 0, 1), v(1, 0, 0), v(1, 1, 0), v(1, 1, 1)); // +x
  quad(p, n, v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)); // -x
  quad(p, n, v(0, 1, 1), v(1, 1, 1), v(1, 1, 0), v(0, 1, 0)); // +y
  quad(p, n, v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)); // -y
  prims.push({ pos: p, nrm: n, mat });
}

/** Vertical frustum (r0 at y0, r1 at y1) around (cx, cz) with caps. */
function frustum(cx, cz, y0, y1, r0, r1, seg, mat, caps = true) {
  const p = [], n = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const P = (r, a, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    quad(p, n, P(r0, a1, y0), P(r0, a0, y0), P(r1, a0, y1), P(r1, a1, y1));
    if (caps) {
      if (r1 > 0) tri(p, n, [cx, y1, cz], P(r1, a1, y1), P(r1, a0, y1));
      if (r0 > 0) tri(p, n, [cx, y0, cz], P(r0, a0, y0), P(r0, a1, y0));
    }
  }
  prims.push({ pos: p, nrm: n, mat });
}

// origin offset (mm): the asset is modelled around (2400, 0, -800)
const OX = 2400, OZ = -800;
box(OX - 900, 0, OZ - 650, OX + 900, 120, OZ + 650, 0);                // skid
frustum(OX - 250, OZ, 120, 1500, 520, 520, 20, 1);                       // vessel
frustum(OX - 250, OZ, 1500, 1820, 520, 120, 20, 1);                      // dome
frustum(OX - 250, OZ, 1820, 1980, 90, 90, 12, 2);                        // nozzle
for (const [dx, dz] of [[-420, -420], [420, -420], [-420, 420], [420, 420]]) frustum(OX - 250 + dx, OZ + dz, 120, 700, 45, 45, 8, 2); // legs
box(OX + 420, 120, OZ - 300, OX + 860, 1300, OZ + 300, 3);              // control cabinet
box(OX + 440, 900, OZ + 300, OX + 840, 1200, OZ + 312, 4);              // HMI screen
box(OX + 270, 900, OZ - 60, OX + 420, 1020, OZ + 60, 2);                // pipe to cabinet
frustum(OX - 250, OZ, 1000, 1060, 540, 540, 20, 2);                      // band

const materials = [
  { name: 'skid', pbrMetallicRoughness: { baseColorFactor: [0.24, 0.27, 0.30, 1], metallicFactor: 0.2, roughnessFactor: 0.8 } },
  { name: 'stainless', pbrMetallicRoughness: { baseColorFactor: [0.78, 0.80, 0.82, 1], metallicFactor: 0.6, roughnessFactor: 0.35 } },
  { name: 'pipe', pbrMetallicRoughness: { baseColorFactor: [0.45, 0.48, 0.52, 1], metallicFactor: 0.5, roughnessFactor: 0.5 } },
  { name: 'cabinet', pbrMetallicRoughness: { baseColorFactor: [0.16, 0.38, 0.62, 1], metallicFactor: 0.05, roughnessFactor: 0.6 } },
  { name: 'screen', pbrMetallicRoughness: { baseColorFactor: [0.05, 0.08, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.3 }, emissiveFactor: [0.08, 0.25, 0.4] },
];

const bufs = [], accessors = [], views = [];
let offset = 0;
const meshPrims = prims.map((pr) => {
  const out = {};
  for (const [key, data] of [['POSITION', pr.pos], ['NORMAL', pr.nrm]]) {
    const f = new Float32Array(data);
    const b = Buffer.from(f.buffer);
    views.push({ buffer: 0, byteOffset: offset, byteLength: b.length, target: 34962 });
    const acc = { bufferView: views.length - 1, componentType: 5126, count: data.length / 3, type: 'VEC3' };
    if (key === 'POSITION') {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], data[i + k]); max[k] = Math.max(max[k], data[i + k]); }
      acc.min = min; acc.max = max;
    }
    accessors.push(acc);
    out[key] = accessors.length - 1;
    bufs.push(b);
    offset += b.length;
  }
  return { attributes: out, material: pr.mat };
});

const gltf = {
  asset: { version: '2.0', generator: 'svdtl make-fixture.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  // scale node: millimetres → metres is NOT applied here on purpose (fit math must handle any unit)
  nodes: [{ name: 'Reactor', mesh: 0 }],
  meshes: [{ name: 'Reactor', primitives: meshPrims }],
  materials,
  buffers: [{ byteLength: offset }],
  bufferViews: views,
  accessors,
};

const json = Buffer.from(JSON.stringify(gltf));
const jsonPad = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const bin = Buffer.concat(bufs);
const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
const total = 12 + 8 + jsonPad.length + 8 + binPad.length;
const head = Buffer.alloc(12);
head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4, 'ascii'); return b; };
const glb = Buffer.concat([head, ch(jsonPad.length, 'JSON'), jsonPad, ch(binPad.length, 'BIN\0'), binPad]);
const out = fileURLToPath(new URL('./reactor.glb', import.meta.url));
writeFileSync(out, glb);
console.log(`wrote ${out} (${glb.length} bytes)`);
