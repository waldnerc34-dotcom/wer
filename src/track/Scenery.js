import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { clamp, lerp, makeRandom, smoothstep } from '../core/MathUtils.js';
import { terrainHeightAt } from './TrackBuilder.js';

/**
 * Scatters the downloaded vegetation and rock models around the circuit.
 *
 * Every distinct mesh in every source model becomes one InstancedMesh, so a
 * forest of several thousand trees costs a handful of draw calls. Placement is
 * driven by a seeded PRNG, which means the scenery is identical on every load
 * and can be reasoned about (and screenshotted) reproducibly.
 */
export class Scenery {
  constructor(track, { density = 1 } = {}) {
    this.track = track;
    this.density = density;
    this.group = new THREE.Group();
    this.group.name = 'scenery';
    this.windMaterials = [];
    this.time = 0;
  }

  /**
   * @param {import('../core/Assets.js').Assets} assets
   */
  async build(assets) {
    // Trees near the road are real models, and trees far from it are cards.
    //
    // It used to be the other way round, on the reasoning that a card carries
    // a photographed canopy while the low-poly models read as lollipops. That
    // is true of one tree looked at from a standstill and wrong from a car:
    // a card has no thickness, so the moment you move past it the thing you
    // notice is that the wood beside the circuit is a row of stickers. Real
    // geometry parallaxes, catches the sun on one side, and casts a shadow
    // with a shape. Six hundred to two and a half thousand vertices each,
    // instanced, is a cost worth paying for the ones you actually drive past.
    //
    // The cards stay for the deep background, where a silhouette is all that
    // survives anyway and a photograph makes a better one than a model.
    const files = [
      // Weighted by what they cost: tree1 is two and a half thousand vertices
      // against six hundred for tree3, and every one of these is multiplied by
      // four figures of instances. It earns a place in the mix, not a share
      // of it.
      { path: 'models/scenery/tree1.glb', kind: 'tree', weight: 1, scale: [7, 13] },
      { path: 'models/scenery/tree2.glb', kind: 'tree', weight: 4, scale: [6, 12] },
      { path: 'models/scenery/tree3.glb', kind: 'tree', weight: 6, scale: [7, 14] },
      { path: 'models/scenery/tree4.glb', kind: 'tree', weight: 5, scale: [6, 13] },
      { path: 'models/scenery/bush1.glb', kind: 'bush', weight: 3, scale: [0.9, 1.9] },
      { path: 'models/scenery/bush2.glb', kind: 'bush', weight: 2, scale: [1.0, 2.0] },
      { path: 'models/scenery/bush3.glb', kind: 'bush', weight: 2, scale: [0.9, 1.8] },
      { path: 'models/scenery/bush4.glb', kind: 'bush', weight: 2, scale: [1.0, 2.1] },
      { path: 'models/scenery/bush5.glb', kind: 'bush', weight: 2, scale: [0.8, 1.7] },
      { path: 'models/scenery/rocks1.glb', kind: 'rock', weight: 2, scale: [0.7, 1.8] },
      { path: 'models/scenery/rocks2.glb', kind: 'rock', weight: 2, scale: [0.8, 2.2] },
      { path: 'models/scenery/rocks3.glb', kind: 'rock', weight: 1, scale: [0.7, 1.9] },
      { path: 'models/scenery/rocks4.glb', kind: 'rock', weight: 1, scale: [0.6, 1.6] },
    ];

    const loaded = await Promise.all(
      files.map(async (f) => ({ ...f, scene: await assets.instance(f.path) })),
    );

    const canopy = await assets.texture('textures/tree_canopy.webp', { srgb: true });

    const placements = this.#scatter(loaded);

    for (const entry of loaded) {
      const list = placements.get(entry.path);
      if (!list?.length) continue;
      this.#instance(entry, list);
    }

    const cards = placements.get('__cards__') ?? [];
    if (cards.length) this.#buildCardTrees(canopy, cards);

    return this.group;
  }

  /* --------------------------------------------------------------- scatter */

  /**
   * Chooses where everything goes.
   *
   * Trees are placed in clusters behind the barriers, thinning as they get
   * further from the circuit; bushes and rocks fill the verge between the
   * run-off and the treeline. Nothing is allowed within the barrier line, and
   * anything that would land on a steep slope is rejected.
   */
  #scatter(entries) {
    const track = this.track;
    const rand = makeRandom(20240517);
    const out = new Map(entries.map((e) => [e.path, []]));
    out.set('__cards__', []);

    const byKind = {
      tree: entries.filter((e) => e.kind === 'tree'),
      bush: entries.filter((e) => e.kind === 'bush'),
      rock: entries.filter((e) => e.kind === 'rock'),
    };
    const pick = (kind) => {
      const list = byKind[kind];
      const total = list.reduce((s, e) => s + e.weight, 0);
      let r = rand() * total;
      for (const e of list) {
        r -= e.weight;
        if (r <= 0) return e;
      }
      return list[list.length - 1];
    };

    const q = {};
    const step = Math.max(1, Math.round(2 / this.density));

    // --- clustered woodland along both sides ------------------------------
    for (let i = 0; i < track.count; i += step) {
      const halfW = track.width[i] * 0.5;
      const px = track.pos[i * 3];
      const pz = track.pos[i * 3 + 2];
      const lx = track.lateral[i * 3];
      const lz = track.lateral[i * 3 + 2];

      for (const side of [-1, 1]) {
        // Woodland begins beyond the barrier and gets denser further out.
        const clumps = Math.round(lerp(2, 7, rand()) * this.density);
        for (let c = 0; c < clumps; c++) {
          const depth = 19 + Math.pow(rand(), 0.7) * 180;
          const along = (rand() - 0.5) * step * track.spacing * 2.2;
          const lat = side * depth;

          const x = px + lx * lat + track.tangent[i * 3] * along;
          const z = pz + lz * lat + track.tangent[i * 3 + 2] * along;

          const ground = terrainHeightAt(track, x, z, q);
          if (ground.edge < 17) continue; // never inside the barrier line
          if (this.#tooSteep(track, x, z, ground.y)) continue;

          // Openings near the track edge so the circuit stays readable.
          const openness = smoothstep(clamp((ground.edge - 18) / 26, 0, 1));
          if (rand() > 0.55 + openness * 0.45) continue;

          // Real geometry for everything you drive past; cards only once the
          // tree is far enough back to be a silhouette and nothing else. The
          // crossover moves in as the budget tightens, because on a phone the
          // vertices matter more than the parallax does.
          const solid = ground.edge < lerp(22, 52, clamp(this.density, 0.3, 1.25) / 1.25);
          if (solid) {
            const entry = pick('tree');
            out.get(entry.path).push({
              x,
              y: ground.y,
              z,
              rotation: rand() * Math.PI * 2,
              scale: lerp(entry.scale[0], entry.scale[1], rand()),
              tilt: (rand() - 0.5) * 0.05,
              shade: rand(),
            });
          } else {
            out.get('__cards__').push({
              x,
              y: ground.y,
              z,
              rotation: rand() * Math.PI * 2,
              scale: lerp(7.5, 17, Math.pow(rand(), 0.8)),
              tilt: (rand() - 0.5) * 0.07,
              // Per-tree colour: species and season variation, and a general
              // darkening with distance from the mown verge.
              hue: rand(),
              value: 0.62 + rand() * 0.5,
            });
          }
        }
      }
    }

    // --- verge dressing ---------------------------------------------------
    for (let i = 0; i < track.count; i += Math.max(1, Math.round(3 / this.density))) {
      const px = track.pos[i * 3];
      const pz = track.pos[i * 3 + 2];
      const lx = track.lateral[i * 3];
      const lz = track.lateral[i * 3 + 2];
      const halfW = track.width[i] * 0.5;

      for (const side of [-1, 1]) {
        if (rand() > 0.75 * this.density) continue;
        const lat = side * (halfW + 14 + rand() * 9);
        const x = px + lx * lat;
        const z = pz + lz * lat;
        const ground = terrainHeightAt(track, x, z, q);
        if (ground.edge < 12) continue;

        const kind = rand() < 0.68 ? 'bush' : 'rock';
        const entry = pick(kind);
        out.get(entry.path).push({
          x,
          y: ground.y - (kind === 'rock' ? 0.12 : 0.05),
          z,
          rotation: rand() * Math.PI * 2,
          scale: lerp(entry.scale[0], entry.scale[1], rand()),
          tilt: (rand() - 0.5) * 0.12,
        });
      }
    }

    return out;
  }

  /** Rejects placements on ground the model would visibly intersect. */
  #tooSteep(track, x, z, y) {
    const d = 3;
    const a = terrainHeightAt(track, x + d, z, {}).y;
    const b = terrainHeightAt(track, x - d, z, {}).y;
    const c = terrainHeightAt(track, x, z + d, {}).y;
    const e = terrainHeightAt(track, x, z - d, {}).y;
    return Math.max(Math.abs(a - b), Math.abs(c - e)) / (2 * d) > 0.95;
  }

  /* ------------------------------------------------------------ card trees */

  /**
   * Builds the trackside woodland from crossed alpha cards.
   *
   * Each tree is three quads at 60° to one another carrying a photographed
   * canopy, over a short tapered trunk. Cards look wrong if you walk up and
   * stare at them, but from a car at 200 km/h they hold their shape from every
   * angle and — unlike a low-poly model — they carry real leaf detail and a
   * real silhouette.
   *
   * Canopy and trunk are two instanced meshes sharing one transform list, so
   * several thousand trees cost two draw calls.
   */
  #buildCardTrees(texture, placements) {
    const PLANES = 3;
    const CANOPY_BOTTOM = 0.26; // fraction of tree height
    const CANOPY_WIDTH = 0.92;

    const cards = [];
    for (let i = 0; i < PLANES; i++) {
      const plane = new THREE.PlaneGeometry(CANOPY_WIDTH, 1 - CANOPY_BOTTOM);
      plane.translate(0, CANOPY_BOTTOM + (1 - CANOPY_BOTTOM) / 2, 0);
      plane.rotateY((i / PLANES) * Math.PI);
      cards.push(plane);
    }
    // A slightly tilted extra card breaks up the hard vertical symmetry that
    // makes cross-billboards obvious from above.
    const cap = new THREE.PlaneGeometry(CANOPY_WIDTH * 0.8, (1 - CANOPY_BOTTOM) * 0.8);
    cap.rotateX(-Math.PI / 2.6);
    cap.translate(0, 0.78, 0);
    cards.push(cap);

    const canopyGeo = mergeGeometries(cards, false);
    for (const c of cards) c.dispose();

    const trunkGeo = new THREE.CylinderGeometry(0.026, 0.055, 0.46, 7, 1, false);
    trunkGeo.translate(0, 0.23, 0);

    const canopyMat = new THREE.MeshStandardMaterial({
      map: texture,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.7,
    });
    this.#addWind(canopyMat, 0.55);

    // Alpha-tested shadows: the depth pass needs the same cutout, or every
    // tree casts a solid rectangle.
    const depthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: texture,
      alphaTest: 0.42,
    });

    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x4b3a2b,
      roughness: 0.95,
      metalness: 0,
      envMapIntensity: 0.5,
    });

    const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, placements.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, placements.length);
    canopy.customDepthMaterial = depthMat;
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    canopy.name = 'tree:canopy';
    trunks.name = 'tree:trunk';

    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.tilt, p.rotation, p.tilt * 0.7);
      // Trees are taller than they are wide; a little per-tree squash and
      // stretch stops the whole wood reading as one repeated object.
      dummy.scale.set(p.scale * (0.82 + p.hue * 0.36), p.scale, p.scale * (0.82 + p.value * 0.3));
      dummy.updateMatrix();
      canopy.setMatrixAt(i, dummy.matrix);
      trunks.setMatrixAt(i, dummy.matrix);

      // Deciduous greens run from yellow-green to blue-green; keep them
      // desaturated so the wood never reads as plastic.
      colour.setHSL(0.19 + p.hue * 0.10, 0.26 + p.hue * 0.16, 0.3 * p.value);
      canopy.setColorAt(i, colour);
      colour.setHSL(0.08, 0.18, 0.16 + p.value * 0.1);
      trunks.setColorAt(i, colour);
    }

    canopy.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    canopy.instanceColor.needsUpdate = true;
    trunks.instanceColor.needsUpdate = true;
    canopy.computeBoundingSphere();
    trunks.computeBoundingSphere();

    this.group.add(trunks, canopy);
  }

  /** Shared wind-sway vertex patch. */
  #addWind(material, strength) {
    const uniforms = { uTime: { value: 0 }, uWind: { value: strength } };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          uniform float uWind;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            #ifdef USE_INSTANCING
              float phase = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
            #else
              float phase = 0.0;
            #endif
            // Sway grows up the model, so trunks stay planted.
            float amp = uWind * smoothstep( 0.0, 1.0, transformed.y ) * 0.09;
            transformed.x += sin( uTime * 1.35 + phase ) * amp;
            transformed.z += cos( uTime * 1.07 + phase * 1.3 ) * amp * 0.7;
          }`,
        );
    };
    material.customProgramCacheKey = () => 'foliage';
    this.windMaterials.push(uniforms);
    return material;
  }

  /* ------------------------------------------------------------- instancing */

  #instance(entry, placements) {
    const source = entry.scene;
    source.updateMatrixWorld(true);

    // Normalise the source so `scale` in the placement means metres of height.
    const box = new THREE.Box3().setFromObject(source);
    const size = new THREE.Vector3();
    box.getSize(size);
    const norm = 1 / Math.max(size.y, 0.001);
    const floor = box.min.y;

    const meshes = [];
    source.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });

    const dummy = new THREE.Object3D();
    const local = new THREE.Matrix4();
    const combined = new THREE.Matrix4();

    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const material = this.#prepareMaterial(mesh.material, entry.kind);

      const inst = new THREE.InstancedMesh(geometry, material, placements.length);
      inst.castShadow = entry.kind !== 'rock';
      // Per-tree colour. Four models repeated a thousand times each is four
      // shades of green in a wood, and a wood does not have four shades of
      // green in it. The jitter is small — species and season, not a paint
      // chart — and it multiplies the map, so a brown trunk stays brown.
      const shaded = entry.kind === 'tree';
      inst.receiveShadow = true;
      inst.frustumCulled = true;
      inst.name = `${entry.kind}:${mesh.name}`;

      // The mesh's own transform inside the source model, with the model
      // shifted so its base sits on y = 0 and normalised to unit height.
      mesh.updateMatrixWorld(true);
      local.copy(mesh.matrixWorld);

      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(p.tilt, p.rotation, p.tilt * 0.6);
        dummy.scale.setScalar(p.scale * norm);
        dummy.updateMatrix();

        combined.copy(dummy.matrix);
        combined.multiply(SHIFT.makeTranslation(0, -floor, 0));
        combined.multiply(local);
        inst.setMatrixAt(i, combined);
        if (shaded) {
          TINT.setHSL(0.24 + (p.shade ?? 0.5) * 0.07, 0.34, 0.42 + (p.shade ?? 0.5) * 0.2);
          inst.setColorAt(i, TINT);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();
      this.group.add(inst);
    }
  }

  /**
   * Vegetation materials get alpha testing (so the foliage cutouts read),
   * two-sided rendering, and a wind sway driven from the vertex shader.
   */
  #prepareMaterial(source, kind) {
    const m = source.clone();
    m.side = THREE.DoubleSide;
    m.envMapIntensity = 0.85;

    if (m.map) {
      m.map.colorSpace = THREE.SRGBColorSpace;
      m.alphaTest = 0.42;
      m.transparent = false;
    }

    if (kind === 'tree') {
      // The pack's foliage is a flat, saturated green with no texture in it,
      // which beside a photographed canopy reads as painted plastic. Pulling
      // it toward the colour of the card wood is what makes the near trees
      // and the far treeline look like one wood rather than two — and it has
      // to be a gentle pull now that these are the trees you drive past,
      // rather than the hard tint that was right when they were only ever
      // silhouettes on the horizon.
      m.color = new THREE.Color(0x93a074);
      m.roughness = 0.94;
      m.metalness = 0;
      m.envMapIntensity = 0.55;
      return this.#addWind(m, 0.34);
    }

    if (kind === 'rock') {
      m.roughness = Math.min(1, (m.roughness ?? 1) * 1.05);
      return m;
    }

    // Foliage: let a little light through so canopies do not read as cardboard.
    m.roughness = 0.86;
    m.metalness = 0;

    const uniforms = { uTime: { value: 0 }, uWind: { value: 0.55 } };
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uWind = uniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          uniform float uWind;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            // Sway increases with height up the model, so trunks stay put and
            // canopies move. Per-instance phase comes from the instance origin.
            #ifdef USE_INSTANCING
              float phase = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
              float height = max( transformed.y, 0.0 ) * length( vec3( instanceMatrix[1] ) );
            #else
              float phase = 0.0;
              float height = max( transformed.y, 0.0 );
            #endif
            float amp = uWind * smoothstep( 0.0, 3.0, height ) * 0.16;
            transformed.x += sin( uTime * 1.35 + phase ) * amp;
            transformed.z += cos( uTime * 1.07 + phase * 1.3 ) * amp * 0.7;
          }`,
        );
    };
    m.customProgramCacheKey = () => 'foliage';
    this.windMaterials.push(uniforms);
    return m;
  }

  update(dt) {
    this.time += dt;
    for (const u of this.windMaterials) u.uTime.value = this.time;
  }

  setWind(strength) {
    for (const u of this.windMaterials) u.uWind.value = strength;
  }

  get instanceCount() {
    let n = 0;
    for (const c of this.group.children) if (c.isInstancedMesh) n += c.count;
    return n;
  }
}

const TINT = new THREE.Color();
const SHIFT = new THREE.Matrix4();
