#!/usr/bin/env node
/**
 * Turns downloaded car models into what the car rig expects.
 *
 * Models arrive from different artists in different states: node hierarchies
 * with baked rotations and centimetre scales, wheels merged in left/right
 * pairs, or the whole car in one mesh with a dozen material slots. The rig
 * needs one thing from all of them — four nodes named wheel_fl / fr / rl / rr
 * whose pivots sit at the wheel centres — and it recognises parts by
 * material name. This pass produces exactly that:
 *
 *   1. bake every node transform into the vertices (metres, Y up, +Z forward)
 *   2. drop geometry the game replaces (separate clear-coat shells, ground)
 *   3. find the four tyres, then pull everything inside each wheel's cylinder
 *      — tyre, rim, disc, caliper, hub — out onto its own centred node
 *   4. rename materials to the rig's vocabulary (paint, glass, tyre, rim …)
 *   5. simplify the heaviest models to a sensible budget
 *
 * Runs between fetch and optimise; already-prepared files are skipped.
 *
 *   node scripts/prepare-cars.mjs [--force] [--only urus]
 */

import { readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, simplify, weld } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARS = join(ROOT, 'public', 'assets', 'models', 'cars');
const FORCE = process.argv.includes('--force');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const TYRE_RE = /tire|tyre|rubber|gum/i;

/**
 * Per-model recipes. Anything not listed here is left alone (the Ferrari and
 * the Khronos concept already have proper wheel nodes).
 */
const RECIPES = {
  'porsche911.glb': {
    forward: '+z',
    scale: 1,
    // The artist modelled the clear coat as a second shell over the paint;
    // the game's paint material carries its own clear coat.
    dropMaterials: ['coat'],
    // Wheels are on their own nodes, merged left+right — split by volume.
    wheelNodes: /^Cylinder\.00[01]/,
    wheelPart: (mat) => ({ rubber: 'tyre', silver: 'rim', plastic: 'hub', 'Material.001': 'disc' })[mat] ?? mat,
    materials: { lights: 'headlight', window: 'glass', tex_shiny: 'taillight' },
    simplify: { ratio: 0.5, error: 0.0008 },
  },
  'datsun240k.glb': {
    forward: '+z',
    scale: 1,
    // One mesh for the whole car: the wheels are carved out of it by volume.
    wheelNodes: null,
    wheelExclude: /paint|glass|headlights|license|stickers/,
    wheelPart: (mat) => ({ tire: 'tyre', alloy: 'rim', chrome: 'rim', black_matte: 'hub', black_paint: 'hub' })[mat] ?? 'hub',
    materials: { headlights: 'headlight', red_glass: 'brakelight', orange_glass: 'indicator' },
    simplify: { ratio: 0.55, error: 0.0008 },
  },
  // The grand prix car arrives as loose glTF at roughly twice life size, so
  // this recipe both packs it and shrinks it. Scale is set from the wheelbase
  // — 7.17 units between the axle centres against the real car's 3.60 m —
  // which lands the track and the 720 mm wheels on their real dimensions too.
  'f1.glb': {
    source: 'f1-src/F1.gltf',
    forward: '+z',
    scale: 0.502,
    // The cockpit is modelled down to the pedals, the seat belts and the
    // legends on the steering wheel. None of it is visible from outside the
    // car and all of it is triangles, so it goes.
    dropMaterials: [
      'gp21_pedals', 'gp21_cockpit_details', 'gp21_cockpit_metal', 'gp21_cockpit_pull',
      'gp21_cinture', 'cockpit_legs_support', 'sf21_sw_buttons', 'sf21_sw_badges',
      'gp21_LCD', 'GP21_CLEARLED', 'gp21_sw_carbon', 'gp21_sw_resin', 'buttons_brown2',
      'sw_brown', 'cables_black', 'cables_red', 'cables_brown', 'gp21_bolt1',
      'gp21_bolt2', 'gp21_bolt3', 'led_blue', 'led_red', 'led_green',
    ],
    // A second, motion-blurred copy of every wheel, meant for renders. Left
    // in, it doubles the wheel geometry and z-fights with the real rim.
    dropNodes: /^(RIM_BLUR|Camera)/i,
    // Not \b after the corner: the next character is an underscore, which is
    // a word character, so there is no boundary there to match.
    wheelNodes: /^(WHEEL|RIM|TYRE|HUB)_(LF|RF|LR|RR)(_|$)/,
    tyreMaterials: /^Wheels/i,
    wheelPart: (mat, node) => {
      if (/caliper/i.test(`${mat} ${node}`)) return 'caliper';
      if (/^TYRE_/i.test(node) || /^Wheels/i.test(mat)) return 'tyre';
      if (/nut|bolt/i.test(mat)) return 'hub';
      return 'rim';
    },
    // The livery lives in the chassis texture, so the chassis material must
    // *not* be called paint — the rig would replace it with a flat colour and
    // the car would lose every sponsor on it. Only the rain light is renamed.
    materials: { '2022_light': 'rearlight' },
    simplify: { ratio: 0.22, error: 0.0009 },
  },
  'urus.glb': {
    forward: '+z',
    scale: 0.01, // centimetres
    wheelNodes: /TiresGum|Whl_HD|Universal_Caliper|^wheel003/,
    wheelPart: (mat, node) => {
      if (/Caliper/i.test(node)) return 'caliper';
      if (/Whl_HD/i.test(node)) return 'hub';
      return { TiresGum: 'tyre', RimsChrome: 'rim', Chrome: 'rim', BreakDiscs: 'disc' }[mat] ?? 'hub';
    },
    materials: {
      WhiteCar: 'paint',
      emitbrake: 'brakelight',
      LightsFrontLed: 'headlight',
      Glass: 'glass',
      LightsGlassFront: 'glass',
      LightsGlassBack: 'glass',
      Mirror: 'mirror',
    },
    simplify: { ratio: 0.7, error: 0.0008 },
  },
};

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
await MeshoptSimplifier.ready;

/* ------------------------------------------------------------------ bake */

/**
 * Applies every node's world transform to its geometry and flattens the
 * hierarchy, so that from here on a vertex's coordinates are the car's.
 */
function bake(doc, recipe) {
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  const global = new THREE.Matrix4().makeScale(recipe.scale, recipe.scale, recipe.scale);
  if (recipe.forward === '-z') global.multiply(new THREE.Matrix4().makeRotationY(Math.PI));

  const meshNodes = [];
  scene.traverse((node) => {
    if (node.getMesh()) meshNodes.push(node);
  });

  const world = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const seen = new Set();

  for (const node of meshNodes) {
    let mesh = node.getMesh();
    // A mesh shared between nodes is baked once per node, so copy it first.
    if (seen.has(mesh)) mesh = mesh.clone();
    seen.add(mesh);
    node.setMesh(mesh);

    world.fromArray(node.getWorldMatrix()).premultiply(global);
    normalMatrix.getNormalMatrix(world);

    for (const prim of mesh.listPrimitives()) {
      for (const semantic of ['POSITION', 'NORMAL', 'TANGENT']) {
        let acc = prim.getAttribute(semantic);
        if (!acc) continue;
        // Attributes shared with other primitives must not be transformed twice.
        if (acc.listParents().filter((p) => p.propertyType === 'Primitive').length > 1) {
          acc = acc.clone();
          prim.setAttribute(semantic, acc);
        }
        const n = acc.getCount();
        const el = new Array(acc.getElementSize()).fill(0);
        for (let i = 0; i < n; i++) {
          acc.getElement(i, el);
          v.set(el[0], el[1], el[2]);
          if (semantic === 'POSITION') v.applyMatrix4(world);
          else v.applyMatrix3(normalMatrix).normalize();
          el[0] = v.x;
          el[1] = v.y;
          el[2] = v.z;
          acc.setElement(i, el);
        }
      }
    }
  }

  // Flatten: every mesh node becomes a direct child of the scene at identity.
  for (const node of meshNodes) {
    const parent = node.getParentNode();
    if (parent) parent.removeChild(node);
    else scene.removeChild(node);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    // Children were baked on their own; detach them so they are not moved twice.
    for (const child of node.listChildren()) node.removeChild(child);
    scene.addChild(node);
  }
  for (const node of scene.listChildren()) {
    if (!node.getMesh() && !meshNodes.includes(node)) scene.removeChild(node);
  }
}

/* ---------------------------------------------------------------- wheels */

function trianglesOf(prim) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  const count = idx ? idx.getCount() : pos.getCount();
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = idx ? idx.getScalar(i) : i;
  return out;
}

function centroid(pos, tri, i, out) {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  pos.getElement(tri[i], a);
  pos.getElement(tri[i + 1], b);
  pos.getElement(tri[i + 2], c);
  out[0] = (a[0] + b[0] + c[0]) / 3;
  out[1] = (a[1] + b[1] + c[1]) / 3;
  out[2] = (a[2] + b[2] + c[2]) / 3;
  return out;
}

/**
 * Finds the four tyres and describes each wheel's cylinder.
 *
 * The tyres are located by material name, which is the one part of a model
 * artists reliably label. `tyreRe` lets a recipe say what that label is when
 * it is not one of the usual words — the grand prix car calls its rubber
 * "Wheels".
 */
function findWheels(doc, candidates, tyreRe = TYRE_RE) {
  const points = [];
  for (const { prim } of candidates) {
    const mat = prim.getMaterial()?.getName() ?? '';
    if (!tyreRe.test(mat)) continue;
    const pos = prim.getAttribute('POSITION');
    const tri = trianglesOf(prim);
    const c = [0, 0, 0];
    for (let i = 0; i < tri.length; i += 3) points.push([...centroid(pos, tri, i, c)]);
  }
  if (points.length < 40) throw new Error('could not find tyre geometry');

  const mean = points.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / points.length);
  const clusters = { fl: [], fr: [], rl: [], rr: [] };
  for (const p of points) {
    const key = `${p[2] >= mean[2] ? 'f' : 'r'}${p[0] >= mean[0] ? 'l' : 'r'}`;
    clusters[key].push(p);
  }

  const wheels = {};
  for (const [key, pts] of Object.entries(clusters)) {
    if (pts.length < 10) throw new Error(`no tyre found for ${key}`);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
    wheels[key] = {
      centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      radius: (max[1] - min[1]) / 2,
      halfWidth: (max[0] - min[0]) / 2,
    };
  }
  return wheels;
}

/**
 * Moves the triangles of `prim` that sit inside a wheel's cylinder into that
 * wheel's bucket. `loose` assigns every triangle to the nearest wheel — for
 * primitives already known to be nothing but wheel.
 */
function carve(prim, wheels, buckets, loose) {
  const pos = prim.getAttribute('POSITION');
  const tri = trianglesOf(prim);
  const keep = [];
  const moved = {};
  const c = [0, 0, 0];

  for (let i = 0; i < tri.length; i += 3) {
    centroid(pos, tri, i, c);
    let best = null;
    let bestD = Infinity;
    for (const [key, w] of Object.entries(wheels)) {
      const dx = Math.abs(c[0] - w.centre[0]);
      const dr = Math.hypot(c[1] - w.centre[1], c[2] - w.centre[2]);
      const inside = dx <= w.halfWidth * 1.25 + 0.03 && dr <= w.radius * 1.06;
      const d = dx + dr;
      if ((loose || inside) && d < bestD) {
        bestD = d;
        best = key;
      }
    }
    if (best) (moved[best] ??= []).push(tri[i], tri[i + 1], tri[i + 2]);
    else keep.push(tri[i], tri[i + 1], tri[i + 2]);
  }

  for (const [key, indices] of Object.entries(moved)) {
    (buckets[key] ??= []).push({ prim, indices });
  }
  return keep;
}

/** Builds a new primitive from a subset of another's triangles, re-based on `origin`. */
function extract(doc, prim, indices, origin, material) {
  const out = doc.createPrimitive().setMode(Primitive.Mode.TRIANGLES).setMaterial(material);
  const remap = new Map();
  const newIndex = [];
  for (const i of indices) {
    if (!remap.has(i)) remap.set(i, remap.size);
    newIndex.push(remap.get(i));
  }
  const order = [...remap.keys()];

  for (const semantic of prim.listSemantics()) {
    const src = prim.getAttribute(semantic);
    const size = src.getElementSize();
    const Ctor = src.getArray().constructor;
    const data = new Ctor(order.length * size);
    const el = new Array(size).fill(0);
    order.forEach((i, k) => {
      src.getElement(i, el);
      if (semantic === 'POSITION') {
        el[0] -= origin[0];
        el[1] -= origin[1];
        el[2] -= origin[2];
      }
      for (let j = 0; j < size; j++) data[k * size + j] = el[j];
    });
    const acc = doc.createAccessor().setType(src.getType()).setArray(data).setNormalized(src.getNormalized());
    out.setAttribute(semantic, acc);
  }
  const Idx = order.length > 65535 ? Uint32Array : Uint16Array;
  out.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Idx(newIndex)));
  return out;
}

function rewriteIndices(doc, prim, keep) {
  if (keep.length === 0) {
    prim.dispose();
    return;
  }
  const Idx = keep.some((i) => i > 65535) ? Uint32Array : Uint16Array;
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Idx(keep)));
}

function extractWheels(doc, recipe) {
  const root = doc.getRoot();
  const scene = root.listScenes()[0];

  // Which primitives may contribute wheel parts.
  const candidates = [];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const name = node.getName();
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()?.getName() ?? '';
      if (recipe.wheelNodes) {
        if (recipe.wheelNodes.test(name)) candidates.push({ node, prim, loose: true });
      } else if (!recipe.wheelExclude?.test(mat)) {
        candidates.push({ node, prim, loose: false });
      }
    }
  }

  const wheels = findWheels(doc, candidates, recipe.tyreMaterials);
  const buckets = {};
  // Carve first, build the wheels from the sources, and only then cut the
  // moved triangles out of the sources — a source that gives everything to
  // the wheels is disposed, and must still be readable while they are built.
  const keeps = [];
  for (const { prim, loose } of candidates) {
    keeps.push([prim, carve(prim, wheels, buckets, loose)]);
  }

  const materialCache = new Map();
  const partMaterial = (prim, nodeName) => {
    const src = prim.getMaterial();
    const part = recipe.wheelPart(src?.getName() ?? '', nodeName);
    const key = `${src?.getName()}|${part}`;
    if (!materialCache.has(key)) {
      const m = src ? src.clone() : doc.createMaterial();
      m.setName(part);
      materialCache.set(key, m);
    }
    return materialCache.get(key);
  };

  const summary = {};
  for (const key of ['fl', 'fr', 'rl', 'rr']) {
    const w = wheels[key];
    const mesh = doc.createMesh(`wheel_${key}`);
    let tris = 0;
    for (const { prim, indices } of buckets[key] ?? []) {
      const nodeName = prim.listParents().find((p) => p.propertyType === 'Mesh')?.listParents().find((p) => p.propertyType === 'Node')?.getName() ?? '';
      mesh.addPrimitive(extract(doc, prim, indices, w.centre, partMaterial(prim, nodeName)));
      tris += indices.length / 3;
    }
    const node = doc.createNode(`wheel_${key}`).setMesh(mesh).setTranslation(w.centre);
    scene.addChild(node);
    summary[key] = { tris, centre: w.centre.map((v) => +v.toFixed(3)), radius: +w.radius.toFixed(3) };
  }
  for (const [prim, keep] of keeps) rewriteIndices(doc, prim, keep);
  return summary;
}

/* ------------------------------------------------------------------ main */

async function prepare(file, recipe) {
  // A recipe may name a loose glTF to pack: the .glb is this pass's output
  // rather than its input, so there is nothing to skip on the first run.
  const packing = recipe.source && !(await stat(file).catch(() => null));
  const doc = await io.read(packing ? join(CARS, recipe.source) : file);
  const root = doc.getRoot();
  if (root.getAsset().extras?.apexPrepared && !FORCE) {
    console.log(`  ${file.split('/').pop().padEnd(20)} already prepared`);
    return;
  }

  if (recipe.dropNodes) {
    for (const node of root.listNodes()) {
      if (recipe.dropNodes.test(node.getName())) node.dispose();
    }
  }

  bake(doc, recipe);

  // Geometry the game replaces.
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()?.getName() ?? '';
      if (recipe.dropMaterials?.includes(mat)) prim.dispose();
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }

  const wheels = extractWheels(doc, recipe);

  for (const m of root.listMaterials()) {
    const to = recipe.materials?.[m.getName()];
    if (to) m.setName(to);
  }

  await doc.transform(prune({ keepLeaves: false, keepAttributes: true }), weld());
  if (recipe.simplify) {
    await doc.transform(
      simplify({ simplifier: MeshoptSimplifier, ratio: recipe.simplify.ratio, error: recipe.simplify.error }),
    );
  }

  root.getAsset().extras = { ...(root.getAsset().extras ?? {}), apexPrepared: 1 };

  let tris = 0;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3;
  const bytes = await io.writeBinary(doc);
  await writeFile(file, bytes);

  console.log(`  ${file.split('/').pop().padEnd(20)} ${(bytes.length / 1024).toFixed(0)} KB · ${Math.round(tris).toLocaleString()} tris`);
  for (const [k, w] of Object.entries(wheels)) console.log(`    wheel_${k}: ${w.tris} tris at (${w.centre.join(', ')}) r ${w.radius}`);
  console.log(`    materials: ${root.listMaterials().map((m) => m.getName()).join(', ')}`);
}

// Every recipe, plus whatever else is in the directory — a recipe that packs
// a loose source has no file of its own to be found by.
const names = [...new Set([...(await readdir(CARS)), ...Object.keys(RECIPES)])].sort();
for (const name of names) {
  const recipe = RECIPES[name];
  if (!recipe) continue;
  if (ONLY && !name.includes(ONLY)) continue;
  await prepare(join(CARS, name), recipe);
}
