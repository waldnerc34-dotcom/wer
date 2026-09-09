import * as THREE from 'three';

import { clamp, lerp, makeRandom, smoothstep } from '../core/MathUtils.js';
import { SURFACE } from './Track.js';

/**
 * Turns a Track into renderable geometry: the road ribbon and its wear
 * pattern, kerbs through the corners, run-off and gravel traps, barriers,
 * the surrounding terrain, and the start/finish structures.
 *
 * Everything is welded into a handful of merged meshes so a lap costs a
 * couple of dozen draw calls rather than a couple of thousand.
 */
export function buildTrack(track, mats) {
  const group = new THREE.Group();
  group.name = 'circuit';

  const road = buildRoad(track, mats);
  const kerbs = buildKerbs(track, mats);
  const lines = buildLines(track, mats);
  const runoff = buildRunoff(track, mats);
  const gravel = buildGravelTraps(track, mats);
  const terrain = buildTerrain(track, mats);
  const barriers = buildBarriers(track, mats);
  const startLine = buildStartLine(track, mats);

  group.add(terrain, runoff, gravel, road, kerbs, lines, ...barriers, ...startLine);

  for (const o of group.children) {
    o.castShadow = false;
    o.receiveShadow = true;
  }
  road.receiveShadow = true;
  kerbs.castShadow = true;
  for (const b of barriers) {
    b.castShadow = true;
    b.receiveShadow = true;
  }

  return { group, terrain, road };
}

/* ------------------------------------------------------------------- road */

/** Lateral columns across the road surface. More columns = smoother wear. */
const ROAD_COLUMNS = 16;

function buildRoad(track, mats) {
  const { count, spacing } = track;
  const cols = ROAD_COLUMNS;
  const rows = count + 1; // repeat the first row to close the loop

  const position = new Float32Array(rows * cols * 3);
  const normal = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const wear = new Float32Array(rows * cols);
  const dust = new Float32Array(rows * cols);

  const TILE = 9; // metres per texture repeat

  for (let r = 0; r < rows; r++) {
    const i = r % count;
    const s = r * spacing;
    const halfW = track.width[i] * 0.5;
    const line = track.lineOffset[i];
    const k = clamp(Math.abs(track.curvature[i]) / 0.012, 0, 1);

    // Cars fan out across the road on straights and funnel onto one line
    // through corners, so the rubber band narrows as curvature rises.
    const band = lerp(3.6, 1.9, k);
    const rubberStrength = 0.28 + 0.62 * k;

    for (let c = 0; c < cols; c++) {
      const t = c / (cols - 1);
      const lat = lerp(-halfW, halfW, t);
      const idx = r * cols + c;

      const px = track.pos[i * 3] + track.lateral[i * 3] * lat;
      const py = track.pos[i * 3 + 1] + track.lateral[i * 3 + 1] * lat;
      const pz = track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * lat;

      position[idx * 3] = px;
      position[idx * 3 + 1] = py;
      position[idx * 3 + 2] = pz;
      normal[idx * 3] = track.normal[i * 3];
      normal[idx * 3 + 1] = track.normal[i * 3 + 1];
      normal[idx * 3 + 2] = track.normal[i * 3 + 2];
      uv[idx * 2] = lat / TILE;
      uv[idx * 2 + 1] = s / TILE;

      const d = Math.abs(lat - line);
      wear[idx] = clamp(Math.exp(-((d / band) ** 2)) * rubberStrength, 0, 1);
      // Marbles collect outside the used width, worst on the outside of
      // corners where everything that leaves the line gets swept.
      const outside = clamp((d - band * 1.5) / 3.2, 0, 1);
      dust[idx] = clamp(smoothstep(outside) * (0.12 + 0.5 * k), 0, 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aWear', new THREE.BufferAttribute(wear, 1));
  geo.setAttribute('aDust', new THREE.BufferAttribute(dust, 1));
  geo.setIndex(gridIndices(rows, cols));
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, mats.road);
  mesh.name = 'road';
  return mesh;
}

/** Triangle indices for an (rows × cols) vertex grid. */
function gridIndices(rows, cols) {
  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  return new THREE.BufferAttribute(
    rows * cols > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
    1,
  );
}

/* ------------------------------------------------------------------ kerbs */

/**
 * Kerbs exist only where the track bends, and are built as a raised wedge:
 * flush at the road edge, ~70 mm proud at the outer lip, then a short skirt
 * down to the run-off.
 */
function buildKerbs(track, mats) {
  const { count, spacing } = track;
  const pos = [];
  const nrm = [];
  const uvs = [];
  const idx = [];

  const PROFILE = [
    { t: 0, h: 0.005 },
    { t: 0.35, h: 0.055 },
    { t: 1, h: 0.075 },
    { t: 1.02, h: -0.05 }, // skirt back down to grade
  ];

  for (const side of [-1, 1]) {
    let runStart = -1;
    for (let i = 0; i <= count; i++) {
      const ii = i % count;
      const w = i < count ? track.kerbWidth(track.curvature[ii]) : 0;
      const active = w > 0.01;
      if (active && runStart < 0) runStart = i;
      if ((!active || i === count) && runStart >= 0) {
        emitKerbRun(track, side, runStart, i, PROFILE, pos, nrm, uvs, idx, spacing);
        runStart = -1;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mats.kerb);
  mesh.name = 'kerbs';
  return mesh;
}

function emitKerbRun(track, side, from, to, profile, pos, nrm, uvs, idx, spacing) {
  const cols = profile.length;
  const base = pos.length / 3;
  const rows = to - from + 1;
  if (rows < 2) return;

  for (let r = 0; r < rows; r++) {
    const i = (from + r) % track.count;
    const s = (from + r) * spacing;
    const halfW = track.width[i] * 0.5;
    const kw = Math.max(0.6, track.kerbWidth(track.curvature[i]));
    // Taper the kerb in and out over its first and last two metres.
    const taper = clamp(Math.min(r, rows - 1 - r) / 3, 0, 1);

    const nx = track.normal[i * 3];
    const ny = track.normal[i * 3 + 1];
    const nz = track.normal[i * 3 + 2];

    for (let c = 0; c < cols; c++) {
      const p = profile[c];
      const lat = side * (halfW + p.t * kw);
      const h = p.h * taper;
      pos.push(
        track.pos[i * 3] + track.lateral[i * 3] * lat + nx * h,
        track.pos[i * 3 + 1] + track.lateral[i * 3 + 1] * lat + ny * h,
        track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * lat + nz * h,
      );
      nrm.push(nx, ny, nz);
      uvs.push(p.t, s / 3); // 3 m per texture tile → ~0.5 m stripes
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = base + r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      if (side > 0) idx.push(a, d, b, b, d, e);
      else idx.push(a, b, d, b, e, d);
    }
  }
}

/* ------------------------------------------------------------ white lines */

/** Continuous edge lines just inside the track boundary. */
function buildLines(track, mats) {
  const { count, spacing } = track;
  const pos = [];
  const nrm = [];
  const idx = [];
  const WIDTH = 0.14;
  const LIFT = 0.012;

  for (const side of [-1, 1]) {
    const base = pos.length / 3;
    for (let r = 0; r <= count; r++) {
      const i = r % count;
      const halfW = track.width[i] * 0.5;
      const nx = track.normal[i * 3];
      const ny = track.normal[i * 3 + 1];
      const nz = track.normal[i * 3 + 2];
      for (const off of [-WIDTH, 0]) {
        const lat = side * (halfW - 0.1) + off * side;
        pos.push(
          track.pos[i * 3] + track.lateral[i * 3] * lat + nx * LIFT,
          track.pos[i * 3 + 1] + track.lateral[i * 3 + 1] * lat + ny * LIFT,
          track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * lat + nz * LIFT,
        );
        nrm.push(nx, ny, nz);
      }
    }
    for (let r = 0; r < count; r++) {
      const a = base + r * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mats.line);
  mesh.name = 'edge-lines';
  return mesh;
}

/* ----------------------------------------------------------------- runoff */

/** Sealed run-off apron running the full lap, just outside the kerb line. */
function buildRunoff(track, mats) {
  const { count, spacing } = track;
  // Three columns per side, mirrored: [inner, mid, outer]. The two sides are
  // separate strips so the geometry never welds across the road surface.
  const PROFILE = [0, 4, 11];
  const cols = PROFILE.length * 2;
  const rows = count + 1;
  const position = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);

  for (let r = 0; r < rows; r++) {
    const i = r % count;
    const s = r * spacing;
    const halfW = track.width[i] * 0.5;
    const kw = track.kerbWidth(track.curvature[i]);

    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const side = c < PROFILE.length ? -1 : 1;
      const out = PROFILE[c % PROFILE.length];
      const lat = side * (halfW + kw + out);
      // Run-off falls away gently so water sheds off the circuit.
      const drop = -0.02 - out * 0.012;

      position[idx * 3] = track.pos[i * 3] + track.lateral[i * 3] * lat;
      position[idx * 3 + 1] = track.pos[i * 3 + 1] + track.lateral[i * 3 + 1] * lat + drop;
      position[idx * 3 + 2] = track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * lat;
      uv[idx * 2] = lat / 6;
      uv[idx * 2 + 1] = s / 6;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      // Skip the seam between the left strip and the right strip.
      if (c === PROFILE.length - 1) continue;
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mats.apron);
  mesh.name = 'runoff';
  return mesh;
}

/** Gravel traps on the outside of the quicker corners. */
function buildGravelTraps(track, mats) {
  const { count, spacing } = track;
  const pos = [];
  const uvs = [];
  const idx = [];

  let run = null;
  for (let i = 0; i <= count; i++) {
    const ii = i % count;
    const k = i < count ? track.curvature[ii] : 0;
    const active = Math.abs(k) > 0.006;
    const side = k > 0 ? -1 : 1; // trap on the outside of the bend
    if (active && (!run || run.side !== side)) {
      if (run) emitGravel(track, run, i, pos, uvs, idx, spacing);
      run = { from: i, side };
    } else if (!active && run) {
      emitGravel(track, run, i, pos, uvs, idx, spacing);
      run = null;
    }
  }
  if (run) emitGravel(track, run, count, pos, uvs, idx, spacing);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mats.gravel);
  mesh.name = 'gravel';
  return mesh;
}

function emitGravel(track, run, to, pos, uvs, idx, spacing) {
  const rows = to - run.from + 1;
  if (rows < 3) return;
  const cols = 3;
  const base = pos.length / 3;

  for (let r = 0; r < rows; r++) {
    const i = (run.from + r) % track.count;
    const s = (run.from + r) * spacing;
    const halfW = track.width[i] * 0.5;
    const kw = track.kerbWidth(track.curvature[i]);
    // Fade the trap in and out along its length.
    const taper = smoothstep(clamp(Math.min(r, rows - 1 - r) / 6, 0, 1));
    const widths = [kw + 2.4, kw + 6, kw + 10.5];
    for (let c = 0; c < cols; c++) {
      const lat = run.side * (halfW + widths[c]);
      const drop = -0.06 - widths[c] * 0.012 - (1 - taper) * 0.25;
      pos.push(
        track.pos[i * 3] + track.lateral[i * 3] * lat,
        track.pos[i * 3 + 1] + track.lateral[i * 3 + 1] * lat + drop + 0.03,
        track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * lat,
      );
      uvs.push(lat / 4, s / 4);
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = base + r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      if (run.side > 0) idx.push(a, d, b, b, d, e);
      else idx.push(a, b, d, b, e, d);
    }
  }
}

/* ---------------------------------------------------------------- terrain */

/**
 * Heightfield surrounding the circuit.
 *
 * Close to the track it matches the road surface exactly (so the shoulder
 * never floats or clips); further out it blends into rolling ground built
 * from a couple of octaves of value noise.
 */
function buildTerrain(track, mats) {
  const PAD = 420;
  const RES = 7;
  const b = track.bounds;
  const minX = b.minX - PAD;
  const minZ = b.minZ - PAD;
  const maxX = b.maxX + PAD;
  const maxZ = b.maxZ + PAD;

  const nx = Math.ceil((maxX - minX) / RES) + 1;
  const nz = Math.ceil((maxZ - minZ) / RES) + 1;

  const position = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const color = new Float32Array(nx * nz * 3);
  const q = {};
  const rand = makeRandom(7);
  const jitter = new Float32Array(nx * nz);
  for (let i = 0; i < jitter.length; i++) jitter[i] = rand();

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const x = minX + ix * RES;
      const z = minZ + iz * RES;
      const { y: base, blend } = terrainHeightAt(track, x, z, q);
      // Break up the silhouette a little, but never right beside the track.
      const y = base + (jitter[i] - 0.5) * 0.55 * blend;
      const hills = rollingGround(x, z);

      position[i * 3] = x;
      position[i * 3 + 1] = y;
      position[i * 3 + 2] = z;
      uv[i * 2] = x / 4.5;
      uv[i * 2 + 1] = z / 4.5;

      // Colour variation: scrubbier and paler away from the manicured verge.
      const dry = clamp(0.35 + hills * 0.05 + jitter[i] * 0.28, 0, 1);
      const shade = 0.86 + jitter[i] * 0.22;
      color[i * 3] = lerp(0.94, 1.1, dry) * shade;
      color[i * 3 + 1] = lerp(1.02, 0.94, dry * blend) * shade;
      color[i * 3 + 2] = lerp(0.9, 0.8, dry) * shade;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geo.setIndex(gridIndices(nz, nx));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, mats.terrain);
  mesh.name = 'terrain';
  return mesh;
}

/**
 * Ground height at an arbitrary point, shared by the terrain mesh and the
 * scenery scatter so trees never float or sink.
 *
 * Returns the height plus the blend factor between "hugging the circuit" (0)
 * and "open country" (1).
 */
export function terrainHeightAt(track, x, z, q = {}) {
  track.query(x, z, q);
  const edge = Math.abs(q.lateral) - q.width * 0.5;
  const blend = smoothstep(clamp((edge - 12) / 90, 0, 1));
  const near = q.height - 0.22;
  const far = q.centreHeight - 0.4 + rollingGround(x, z);
  return { y: lerp(near, far, blend), blend, edge, query: q };
}

/** Two octaves of smooth value noise, in metres. */
function rollingGround(x, z) {
  return (
    noise2(x * 0.0032, z * 0.0032) * 13 +
    noise2(x * 0.0091, z * 0.0091) * 4.5 +
    noise2(x * 0.021, z * 0.021) * 1.2
  );
}

function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const h = (a, b) => {
    let n = (a * 374761393 + b * 668265263) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return (((n ^ (n >>> 16)) >>> 0) / 4294967295) * 2 - 1;
  };
  return lerp(
    lerp(h(xi, yi), h(xi + 1, yi), u),
    lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u),
    v,
  );
}

/* --------------------------------------------------------------- barriers */

/**
 * Armco along both sides of the circuit, with the posts drawn as one
 * instanced mesh and the rail as a single extruded ribbon.
 */
function buildBarriers(track, mats) {
  const { count, spacing } = track;
  const POST_EVERY = Math.max(1, Math.round(3.6 / spacing));
  const OFFSET = 13.5;
  const RAIL_H = 0.62;

  const railPos = [];
  const railIdx = [];
  const postMatrices = [];
  const dummy = new THREE.Object3D();

  for (const side of [-1, 1]) {
    const base = railPos.length / 3;
    for (let r = 0; r <= count; r++) {
      const i = r % count;
      const halfW = track.width[i] * 0.5;
      const lat = side * (halfW + OFFSET);
      const bx = track.pos[i * 3] + track.lateral[i * 3] * lat;
      const by = track.pos[i * 3 + 1] - 0.3;
      const bz = track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * lat;

      // Rail cross-section: a shallow W, two ridges tall.
      for (const [dy, dOut] of [
        [RAIL_H + 0.16, 0.0],
        [RAIL_H + 0.02, 0.07],
        [RAIL_H - 0.12, 0.0],
        [RAIL_H - 0.26, 0.07],
        [RAIL_H - 0.4, 0.0],
      ]) {
        railPos.push(
          bx + track.lateral[i * 3] * dOut * side,
          by + dy,
          bz + track.lateral[i * 3 + 2] * dOut * side,
        );
      }

      if (r % POST_EVERY === 0 && r < count) {
        dummy.position.set(bx, by + 0.2, bz);
        dummy.lookAt(bx + track.tangent[i * 3], by + 0.2, bz + track.tangent[i * 3 + 2]);
        dummy.updateMatrix();
        postMatrices.push(dummy.matrix.clone());
      }
    }

    const cols = 5;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = base + r * cols + c;
        const bIdx = a + 1;
        const d = a + cols;
        const e = d + 1;
        if (side > 0) railIdx.push(a, bIdx, d, bIdx, e, d);
        else railIdx.push(a, d, bIdx, bIdx, d, e);
      }
    }
  }

  const railGeo = new THREE.BufferGeometry();
  railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railPos, 3));
  railGeo.setIndex(railIdx);
  railGeo.computeVertexNormals();
  const rail = new THREE.Mesh(railGeo, mats.armco);
  rail.name = 'armco';

  const postGeo = new THREE.BoxGeometry(0.12, 1.0, 0.12);
  postGeo.translate(0, 0.1, 0);
  const posts = new THREE.InstancedMesh(postGeo, mats.post, postMatrices.length);
  postMatrices.forEach((m, i) => posts.setMatrixAt(i, m));
  posts.instanceMatrix.needsUpdate = true;
  posts.name = 'armco-posts';

  const tyres = buildTyreWalls(track, mats);
  return tyres ? [rail, posts, tyres] : [rail, posts];
}

/** Stacked tyre walls on the outside of the slowest corners. */
function buildTyreWalls(track, mats) {
  const { count } = track;
  const geo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12, 1);
  const matrices = [];
  const dummy = new THREE.Object3D();
  const rand = makeRandom(31);

  for (let i = 0; i < count; i += 2) {
    const k = track.curvature[i];
    if (Math.abs(k) < 0.011) continue;
    const side = k > 0 ? -1 : 1;
    const halfW = track.width[i] * 0.5;
    for (let stack = 0; stack < 3; stack++) {
      for (let depth = 0; depth < 2; depth++) {
        const lat = side * (halfW + 12.4 + depth * 0.72);
        dummy.position.set(
          track.pos[i * 3] + track.lateral[i * 3] * lat,
          track.pos[i * 3 + 1] - 0.28 + 0.24 * stack + 0.12,
          track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * lat,
        );
        dummy.rotation.set(0, rand() * Math.PI, 0);
        dummy.updateMatrix();
        matrices.push(dummy.matrix.clone());
      }
    }
  }
  if (!matrices.length) return null;

  const mesh = new THREE.InstancedMesh(geo, mats.tyreWall, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'tyre-walls';
  return mesh;
}

/* ----------------------------------------------------------- start / finish */

/** The start/finish line plus the gantry that spans the circuit above it. */
function buildStartLine(track, mats) {
  const out = [];
  const i = 0;
  const halfW = track.width[i] * 0.5;
  const lat = new THREE.Vector3().fromArray(track.lateral, 0);
  const tan = new THREE.Vector3().fromArray(track.tangent, 0);
  const nrm = new THREE.Vector3().fromArray(track.normal, 0);
  const origin = new THREE.Vector3().fromArray(track.pos, 0);
  const heading = Math.atan2(tan.x, tan.z);

  // Painted line: alternating blocks across the full width.
  const BLOCKS = 24;
  const blockW = (halfW * 2) / BLOCKS;
  const geo = new THREE.BoxGeometry(blockW * 0.98, 0.02, 0.7);
  const light = new THREE.InstancedMesh(geo, mats.paintedWhite, BLOCKS);
  const dark = new THREE.InstancedMesh(geo, mats.trim, BLOCKS);
  const dummy = new THREE.Object3D();
  let nl = 0;
  let nd = 0;
  for (let b = 0; b < BLOCKS; b++) {
    const off = -halfW + blockW * (b + 0.5);
    dummy.position.copy(origin).addScaledVector(lat, off).addScaledVector(nrm, 0.02);
    dummy.rotation.set(0, heading, 0);
    dummy.updateMatrix();
    if (b % 2 === 0) light.setMatrixAt(nl++, dummy.matrix);
    else dark.setMatrixAt(nd++, dummy.matrix);
  }
  light.count = nl;
  dark.count = nd;
  light.instanceMatrix.needsUpdate = true;
  dark.instanceMatrix.needsUpdate = true;
  out.push(light, dark);

  out.push(buildGantry(track, mats, { origin, lat, heading, halfW }));
  return out;
}

/**
 * The structure over the start/finish line: two braced uprights, a lattice
 * beam, a banner face and the starting-light panel.
 */
function buildGantry(track, mats, { origin, lat, heading, halfW }) {
  const gantry = new THREE.Group();
  gantry.name = 'gantry';

  const span = halfW * 2 + 9;
  const HEIGHT = 7.9;

  const add = (geo, mat, offset, y, extra = {}) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(origin).addScaledVector(lat, offset);
    mesh.position.y += y;
    mesh.rotation.y = heading + (extra.yaw ?? 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    gantry.add(mesh);
    return mesh;
  };

  // Uprights: a pair of columns each side with cross-bracing between them.
  const columnGeo = new THREE.BoxGeometry(0.28, HEIGHT, 0.28);
  const braceGeo = new THREE.BoxGeometry(0.14, 1.5, 0.14);
  const footGeo = new THREE.BoxGeometry(1.5, 0.35, 1.5);

  for (const side of [-1, 1]) {
    const base = side * (halfW + 4.2);
    add(footGeo, mats.concrete, base, 0.16);
    for (const d of [-0.55, 0.55]) {
      const col = add(columnGeo, mats.post, base, HEIGHT / 2);
      col.translateZ(d);
    }
    // Zig-zag bracing.
    for (let k = 0; k < 4; k++) {
      const brace = add(braceGeo, mats.post, base, 1.1 + k * 1.75);
      brace.rotateX(k % 2 === 0 ? 0.65 : -0.65);
    }
  }

  // Lattice beam: two chords with vertical posts between them.
  const chordGeo = new THREE.BoxGeometry(span, 0.2, 0.2);
  for (const [y, z] of [
    [HEIGHT + 0.1, -0.5],
    [HEIGHT + 0.1, 0.5],
    [HEIGHT + 1.5, -0.5],
    [HEIGHT + 1.5, 0.5],
  ]) {
    add(chordGeo, mats.post, 0, y).translateZ(z);
  }
  const webGeo = new THREE.BoxGeometry(0.12, 1.4, 0.12);
  const bays = Math.round(span / 1.8);
  for (let k = 0; k <= bays; k++) {
    const offset = -span / 2 + (k * span) / bays;
    for (const z of [-0.5, 0.5]) add(webGeo, mats.post, offset, HEIGHT + 0.8).translateZ(z);
  }

  // Banner face and the light panel that hangs beneath it.
  const banner = add(new THREE.BoxGeometry(span * 0.72, 1.25, 0.08), mats.trim, 0, HEIGHT + 0.8);
  banner.translateZ(-0.62);

  const panelGeo = new THREE.BoxGeometry(3.4, 0.75, 0.22);
  const panel = add(panelGeo, mats.trim, 0, HEIGHT - 0.35);

  // Five red lamps, dark until a race start would light them.
  const lampGeo = new THREE.SphereGeometry(0.17, 10, 8);
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x2a0705,
    emissive: new THREE.Color(0xff2010),
    emissiveIntensity: 0.25,
    roughness: 0.3,
  });
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, 5);
  const dummy = new THREE.Object3D();
  for (let k = 0; k < 5; k++) {
    dummy.position
      .copy(panel.position)
      .addScaledVector(lat, -1.4 + k * 0.7);
    dummy.position.y += 0.02;
    dummy.updateMatrix();
    lamps.setMatrixAt(k, dummy.matrix);
  }
  lamps.instanceMatrix.needsUpdate = true;
  lamps.name = 'start-lights';
  gantry.add(lamps);

  return gantry;
}
