#!/usr/bin/env node
/**
 * Packs the whole game into one self-contained HTML file.
 *
 * The target is a sandboxed page that can run scripts but never fetch: no
 * models, textures or HDRIs from anywhere, no decoder workers, no wasm. So
 * every asset goes into the page as base64, and the models are re-encoded so
 * they need no decoder at all — quantised (KHR_mesh_quantization, which
 * three.js reads natively) instead of Draco, with their textures turned into
 * data: URIs so the loader never has to create a blob for them either.
 *
 *   node scripts/build-artifact.mjs        → artifact/apex.html
 */

import { execSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Format, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { decodeRGBE, encodeRGBE, resampleRGB } from './rgbe.mjs';
import draco3d from 'draco3dgltf';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'public', 'assets');
const OUT_DIR = join(ROOT, 'artifact');
const OUT = join(OUT_DIR, 'apex.html');

const LIMIT_MB = 16;

/* ----------------------------------------------------------- inventory --- */

const MODELS = [
  // The concept car simplifies well: 213k → ~102k triangles with no visible
  // change from a chase camera. The Ferrari is unwelded triangle soup —
  // every vertex owned by one face, with its own normal and its own patch
  // of the baked-AO UV layout — so nothing welds and the simplifier can
  // collapse almost nothing. `rebuild` throws those attributes away, welds
  // on position alone, simplifies, and recomputes smooth normals: 5.1 MB of
  // geometry becomes 1.4 MB, at the cost of the baked ambient occlusion
  // (which the screen-space AO covers) and a little crispness on panel
  // creases. That is what makes room for four cars in one page.
  { path: 'models/cars/ferrari.glb', texture: 1024, rebuild: true, simplify: { ratio: 0.35, error: 0.004 } },
  { path: 'models/cars/concept.glb', texture: 512, simplify: { ratio: 0.36, error: 0.0015 } },
  { path: 'models/cars/porsche911.glb', texture: 768, simplify: { ratio: 0.42, error: 0.0012 } },
  // The grand prix car is the headline of the garage and has to be in here,
  // but it is also by far the heaviest thing in it. Cut hard — a single-file
  // page has 16 MB for everything, and the wings and the tyres carry the
  // silhouette rather than the texture resolution does.
  //
  // The Urus is the price of it. Every car in the garage is on the served
  // build; this list is what fits in one page, and a 2.2-tonne SUV is the
  // one whose absence is least felt on a circuit.
  { path: 'models/cars/f1.glb', texture: 384, simplify: { ratio: 0.22, error: 0.002 } },
  ...['tree3', 'tree4', 'bush1', 'bush2', 'bush3', 'bush4', 'bush5', 'rocks1', 'rocks2', 'rocks3', 'rocks4'].map(
    (n) => ({ path: `models/scenery/${n}.glb`, texture: 256, simplify: null }),
  ),
  // Trackside props: what makes the far side of the barrier somewhere rather
  // than nowhere. All of them fit now — the whole set is two hundred
  // kilobytes once the optimiser has capped its textures, which is less than
  // one of the three that used to carry a 4269-pixel map for a wooden crate.
  ...[
    'cottage', 'inn', 'sawmill', 'well', 'wagon', 'fence', 'wall', 'lightpost', 'barrel', 'car',
    // The single-file build cannot carry a Draco decoder, so geometry ships
    // raw here — a prop that is twelve kilobytes on the hosted site is a
    // hundred and thirty in the page. The set is chosen for what is visible
    // from the road; the yard clutter is left to the hosted build.
  ].map((n) => ({ path: `models/props/${n}.glb`, texture: 192, simplify: null })),
];

const TEXTURES = [
  'asphalt_basecolor', 'asphalt_normal', 'asphalt_roughness',
  'kerb_basecolor', 'kerb_normal', 'kerb_roughness',
  'concrete_basecolor', 'concrete_normal', 'concrete_roughness',
  'grass_basecolor', 'grass_normal',
  'gravel_basecolor', 'gravel_normal', 'gravel_metalrough',
  'flake_normal', 'smoke', 'skid', 'spark', 'tree_canopy', 'water_normals',
].map((n) => `textures/${n}.webp`);

// One sky for every circuit; the loader falls back to it when a circuit asks
// for one that is not embedded. It is resampled down: a dome this soft is
// blurred on screen anyway, and the 1k original is a fifth of the budget.
const HDRIS = [{ path: 'hdri/venice_sunset_1k.hdr', width: 768 }];

// The recordings the audio engine plays.
const SOUNDS = ['sounds/engine.mp3', 'sounds/tyres.mp3', 'sounds/crash.mp3'];

// Car thumbnails for the picker, as data: URIs like the textures.
const THUMBS = ['rosso', 'concept', 'porsche', 'urus'].map((id) => `thumbs/${id}.webp`);

/** Surface maps above this size are halved for the single-file build … */
const TEXTURE_CAP = 512;
/** … except the road normal, which you look at for the whole lap. 768² is
 *  85 px per metre at the 9 m tile — sharp — and 350 KB under the 1024². */
const CAPS = {
  'textures/asphalt_normal.webp': 768,
  'textures/flake_normal.webp': 256,
  // The sea's waves are sampled at two scales over a plane kilometres
  // across; nobody has ever seen a single texel of it.
  'textures/water_normals.webp': 256,
};

/* -------------------------------------------------------------- models --- */

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
await MeshoptSimplifier.ready;

/** Area-weighted smooth normals over an indexed primitive, in place. */
function smoothNormals(doc, prim) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  if (!pos || !idx) return;
  const n = pos.getCount();
  const acc = new Float32Array(n * 3);
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  for (let i = 0; i < idx.getCount(); i += 3) {
    const ia = idx.getScalar(i);
    const ib = idx.getScalar(i + 1);
    const ic = idx.getScalar(i + 2);
    pos.getElement(ia, a);
    pos.getElement(ib, b);
    pos.getElement(ic, c);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    // The cross product's length is twice the area: bigger faces weigh more.
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [ia, ib, ic]) {
      acc[k * 3] += nx;
      acc[k * 3 + 1] += ny;
      acc[k * 3 + 2] += nz;
    }
  }
  for (let k = 0; k < n; k++) {
    const l = Math.hypot(acc[k * 3], acc[k * 3 + 1], acc[k * 3 + 2]) || 1;
    acc[k * 3] /= l;
    acc[k * 3 + 1] /= l;
    acc[k * 3 + 2] /= l;
  }
  prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(acc));
}

async function packModel({ path, texture, simplify: simp, rebuild = false }) {
  const doc = await io.read(join(ASSETS, path));
  doc.setLogger(new Logger(Logger.Verbosity.ERROR));

  // The committed models are Draco-compressed. Reading one leaves the
  // extension attached to the document, and the writer would then insist on
  // re-encoding — the whole point here is a model that needs no decoder.
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
  }

  if (rebuild) {
    // Position is the only attribute that survives; everything that stopped
    // the vertices welding goes, and the material that read the baked AO
    // through those UVs loses it.
    for (const m of doc.getRoot().listMeshes()) {
      for (const p of m.listPrimitives()) {
        for (const semantic of p.listSemantics()) if (semantic !== 'POSITION') p.setAttribute(semantic, null);
      }
    }
    for (const m of doc.getRoot().listMaterials()) m.setOcclusionTexture(null);
  }

  const steps = [
    dedup({ propertyTypes: ['Accessor', 'Texture', 'Mesh'] }),
    // keepAttributes: false drops vertex data no material reads — tangents on
    // a material with no normal map are a quarter of a vertex's bytes.
    prune({ keepLeaves: true, keepAttributes: false }),
    rebuild ? weld({ tolerance: 0.0003 }) : weld(),
  ];
  if (simp) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: simp.ratio, error: simp.error }));
  await doc.transform(...steps);

  if (rebuild) {
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) smoothNormals(doc, p);
  }

  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texture, texture], quality: 82 }),
    quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12, quantizeColor: 8 }),
  );

  // Write as separate JSON + resources, then assemble a GLB by hand: the
  // geometry buffer becomes the binary chunk, and every image becomes a
  // data: URI in the JSON — so the loader neither fetches nor makes blobs.
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLTF, basename: 'm' });

  for (const image of json.images ?? []) {
    const bytes = resources[image.uri];
    const mime = image.mimeType ?? (image.uri.endsWith('.webp') ? 'image/webp' : 'image/png');
    image.uri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    delete image.bufferView;
  }

  if ((json.buffers ?? []).length !== 1) throw new Error(`${path}: expected one buffer`);
  const bin = Buffer.from(resources[json.buffers[0].uri]);
  delete json.buffers[0].uri;
  json.buffers[0].byteLength = bin.length;

  let tris = 0;
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
  }
  return { glb: glbPack(json, bin), tris: Math.round(tris) };
}

function glbPack(json, bin) {
  const pad4 = (n) => (n + 3) & ~3;
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPadded = Buffer.alloc(pad4(jsonBuf.length), 0x20);
  jsonBuf.copy(jsonPadded);
  const binPadded = Buffer.alloc(pad4(bin.length), 0);
  bin.copy(binPadded);

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4; // 'glTF'
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonPadded.length, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4; // 'JSON'
  jsonPadded.copy(out, o); o += jsonPadded.length;
  out.writeUInt32LE(binPadded.length, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4; // 'BIN\0'
  binPadded.copy(out, o);
  return out;
}

/* ---------------------------------------------------------------- pack --- */

const assets = {};
const sizes = [];
const kb = (n) => `${(n / 1024).toFixed(0).padStart(5)} KB`;

console.log('· models');
for (const m of MODELS) {
  const { glb, tris } = await packModel(m);
  assets[m.path] = glb.toString('base64');
  sizes.push([m.path, glb.length]);
  console.log(`  ${m.path.padEnd(32)} ${kb(glb.length)}  ${tris.toLocaleString()} tris`);
}

console.log('· textures');
for (const t of TEXTURES) {
  let bytes = await readFile(join(ASSETS, t));
  const meta = await sharp(bytes).metadata();
  const cap = CAPS[t] ?? TEXTURE_CAP;
  if (meta.width > cap) {
    const isNormal = /normal/.test(t);
    bytes = await sharp(bytes)
      .resize(cap, cap, { kernel: 'lanczos3' })
      .webp({ quality: isNormal ? 90 : 84, effort: 6 })
      .toBuffer();
  }
  assets[t] = `data:image/webp;base64,${bytes.toString('base64')}`;
  sizes.push([t, bytes.length]);
}
console.log(`  ${TEXTURES.length} maps, ${kb(sizes.filter(([p]) => p.startsWith('textures/')).reduce((s, [, n]) => s + n, 0))}`);

console.log('· lighting');
for (const { path: h, width } of HDRIS) {
  let bytes = await readFile(join(ASSETS, h));
  const sky = decodeRGBE(bytes);
  if (width < sky.width) bytes = encodeRGBE(resampleRGB(sky, width, Math.round((sky.height * width) / sky.width)));
  assets[h] = bytes.toString('base64');
  sizes.push([h, bytes.length]);
  console.log(`  ${h.padEnd(32)} ${kb(bytes.length)}  ${Math.min(width, sky.width)} px`);
}

for (const t of THUMBS) {
  try {
    const bytes = await readFile(join(ASSETS, t));
    assets[t] = `data:image/webp;base64,${bytes.toString('base64')}`;
    sizes.push([t, bytes.length]);
  } catch {
    console.warn(`  (no thumbnail ${t})`);
  }
}

console.log('· sound');
for (const snd of SOUNDS) {
  const bytes = await readFile(join(ASSETS, snd));
  assets[snd] = bytes.toString('base64');
  sizes.push([snd, bytes.length]);
  console.log(`  ${snd.padEnd(34)} ${kb(bytes.length)}`);
}

/* --------------------------------------------------------------- build --- */

console.log('· bundling');
execSync('npx vite build', { cwd: ROOT, env: { ...process.env, ARTIFACT: '1' }, stdio: 'pipe' });

const dist = join(ROOT, 'dist-artifact');
const html = await readFile(join(dist, 'index.html'), 'utf8');

// Vite also emits the Draco decoder files it finds referenced, and with fixed
// output names those claim "app.js" before the entry does. The entry is the
// only megabyte-scale script in the directory, so pick it by size.
const files = await readdir(dist);
const scripts = [];
for (const f of files) {
  if (f.endsWith('.js')) scripts.push([f, (await stat(join(dist, f))).size]);
}
scripts.sort((a, b) => b[1] - a[1]);
const jsName = scripts[0]?.[0];
const cssName = files.find((f) => f.endsWith('.css'));
if (!jsName || !cssName || scripts[0][1] < 500_000) {
  throw new Error(`entry bundle not found (${scripts.map((x) => x.join(':')).join(', ')})`);
}
const js = await readFile(join(dist, jsName), 'utf8');
const css = await readFile(join(dist, cssName), 'utf8');

// Everything the page shows lives in <body>; the head is rebuilt below.
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[^>]*><\/script>/g, '')
  .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
  .trim();

// An inline module ends at the first "</script>", wherever it appears.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const page = [
  '<title>APEX</title>',
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />',
  // The typefaces come from Google Fonts here: a sandboxed page cannot fetch
  // font files from itself, but this stylesheet host is allowed through.
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow+Condensed:wght@400;600&display=swap" />',
  `<style>\n${css}\n</style>`,
  body,
  `<script>window.APEX_ASSETS=${JSON.stringify(assets)};</script>`,
  `<script type="module">\n${safeJs}\n</script>`,
  '',
].join('\n');

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT, page);

/* -------------------------------------------------------------- report --- */

const total = Buffer.byteLength(page);
const assetRaw = sizes.reduce((s, [, n]) => s + n, 0);
console.log(`
  code          ${kb(Buffer.byteLength(js) + Buffer.byteLength(css))}
  assets (raw)  ${kb(assetRaw)}   → as base64 ${kb(Math.round(assetRaw * 4 / 3))}
  page          ${(total / 1048576).toFixed(2)} MB of ${LIMIT_MB} MB

✔ ${OUT.replace(ROOT + '/', '')}`);

if (total > LIMIT_MB * 1048576) {
  console.error(`✖ over the ${LIMIT_MB} MB artifact limit`);
  process.exit(1);
}
