import * as THREE from 'three';

import { terrainHeightAt } from './TrackBuilder.js';
import { clamp, lerp } from '../core/MathUtils.js';

/**
 * The things beside a circuit that make it somewhere.
 *
 * Scenery.js plants what grows. This places what was built: the paddock and
 * the cars parked in it, a works compound, a village or two set back behind
 * the barriers, the lighting columns down the main straight and the run of
 * fencing that keeps spectators off it.
 *
 * Everything here is a downloaded model. Nothing is extruded, lathed or
 * boxed together in code — a hand-built grandstand always looks hand-built,
 * and the difference between a circuit that reads as a place and one that
 * reads as a track with a texture on it is almost entirely the props.
 *
 * Placement is deterministic per circuit: the same seed, the same layout,
 * every session. A paddock that moves between loads is a paddock nobody
 * learns, and knowing that the works compound is on the exit of turn six is
 * part of knowing a circuit.
 */
/**
 * The props whose shadows are worth what they cost. Everything else is small,
 * far from the road, or both — and each caster is redrawn once per shadow
 * cascade, which is the most expensive thing a prop can ask for.
 */
const SHADOWS = new Set([
  'models/props/cottage.glb',
  'models/props/inn.glb',
  'models/props/sawmill.glb',
  'models/props/lightpost.glb',
  'models/props/wagon.glb',
  'models/props/cratestack.glb',
]);

export class Props {
  /**
   * @param {import('./Track.js').Track} track
   * @param {object} [options]
   * @param {number} [options.density] scales how much is placed, from the quality preset
   */
  constructor(track, { density = 1 } = {}) {
    this.track = track;
    this.density = density;
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.placements = new Map();
    this.count = 0;
  }

  /**
   * @param {import('../core/Assets.js').Assets} assets
   * @param {string[]} [heroes] paths to race cars, for the handful in the paddock
   */
  async build(assets, heroes = []) {
    // Two on a desktop, none on a phone. Each one is fifty to a hundred draw
    // calls, and they sit on the main straight — which is exactly where the
    // frame rate is worth the most.
    this.#plan(heroes.slice(0, this.density >= 0.8 ? 2 : 0));

    const paths = [...this.placements.keys()].filter((p) => this.placements.get(p).length);
    const scenes = await Promise.all(
      paths.map(async (path) => {
        try {
          return { path, scene: await assets.instance(path) };
        } catch {
          // A missing prop is a missing prop, not a missing circuit.
          return { path, scene: null };
        }
      }),
    );

    for (const { path, scene } of scenes) {
      if (!scene) continue;
      for (const chunk of this.#chunk(this.placements.get(path))) {
        this.#instance(scene, chunk, SHADOWS.has(path));
      }
    }
    return this.group;
  }

  /* ------------------------------------------------------------- the plan */

  /** Adds one placement of one model. */
  #put(path, position, { yaw = 0, scale = 1 } = {}) {
    if (!this.placements.has(path)) this.placements.set(path, []);
    this.placements.get(path).push({ position, yaw, scale });
    this.count++;
  }

  /**
   * A point `depth` metres to one side of the circuit at arc length `s`,
   * dropped onto the terrain — or null where it would be on the road, in the
   * run-off, or on ground too steep to stand a building on.
   *
   * @param {number} s      arc length round the lap
   * @param {number} side   -1 or 1
   * @param {number} depth  metres beyond the centreline
   * @param {number} [clear] metres of clearance required from the track edge
   */
  #site(s, side, depth, clear = 12) {
    const track = this.track;
    const i = track.indexAt(s);
    const x = track.pos[i * 3] + track.lateral[i * 3] * side * depth;
    const z = track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * side * depth;
    const ground = terrainHeightAt(track, x, z, {});
    if (ground.edge < clear) return null;

    // A building on a one-in-three slope is a building sunk into a hill at
    // one corner and floating at the other.
    const d = 4;
    const rise = Math.max(
      Math.abs(terrainHeightAt(track, x + d, z, {}).y - terrainHeightAt(track, x - d, z, {}).y),
      Math.abs(terrainHeightAt(track, x, z + d, {}).y - terrainHeightAt(track, x, z - d, {}).y),
    );
    if (rise / (2 * d) > 0.28) return null;

    return { position: new THREE.Vector3(x, ground.y, z), heading: track.headingAt?.(s) ?? this.#heading(i) };
  }

  #heading(i) {
    return Math.atan2(this.track.tangent[i * 3], this.track.tangent[i * 3 + 2]);
  }

  /** Where everything goes. */
  #plan(heroes) {
    const track = this.track;
    const L = track.length;
    const rand = mulberry(Math.round(L * 7.13) >>> 0);
    const d = this.density;

    /* -- the paddock ---------------------------------------------------- */
    // Behind the pit side of the main straight, which is the stretch before
    // the line: the one piece of every circuit a driver sees on every lap.
    this.#paddock(L - 150, rand, heroes);

    /* -- works compounds -------------------------------------------------- */
    // Every circuit has one, and it is always exactly as untidy as this.
    for (const at of d < 0.5 ? [0.43] : [0.43, 0.24]) this.#works(L * at, rand);

    /* -- villages -------------------------------------------------------- */
    for (const at of d < 0.5 ? [0.16, 0.68] : [0.16, 0.68, 0.52, 0.34, 0.86].slice(0, d < 0.9 ? 3 : 5)) {
      this.#village(L * at, rand);
    }

    /* -- a car park on the far side --------------------------------------- */
    // Spectators arrive in something, and a field of parked cars is the
    // cheapest thing on a circuit that reads instantly as "race day".
    this.#carPark(L * 0.30, rand);

    /* -- lighting down the straight -------------------------------------- */
    const posts = Math.round(14 * clamp(d, 0.4, 1.3));
    for (let k = 0; k < posts; k++) {
      const s = L - 320 + (k / posts) * 300;
      const site = this.#site(s, k % 2 === 0 ? 1 : -1, 21 + rand() * 3, 15);
      if (site) this.#put('models/props/lightpost.glb', site.position, { yaw: site.heading, scale: 1.5 });
    }

    /* -- spectator fencing ------------------------------------------------ */
    // Runs of panels rather than a continuous ring: fencing every metre of a
    // four-kilometre lap is thousands of instances for something nobody looks
    // at down the parts of the circuit where nobody stands.
    // Where spectators actually stand: the main straight and the outside of
    // the two best overtaking spots. Ringing the whole circuit in fencing is
    // hundreds of instances of something nobody looks at.
    const runs = [
      [L - 380, L - 60],
      [L * 0.14, L * 0.21],
      [L * 0.66, L * 0.73],
    ].slice(0, d < 0.5 ? 1 : d < 0.9 ? 2 : 3);
    // Panels get further apart as the budget tightens, rather than the runs
    // simply vanishing: a sparse fence still reads as a fence.
    const gap = lerp(11, 6.2, clamp((d - 0.3) / 0.7, 0, 1));
    for (const [from, to] of runs) {
      for (let s = from; s < to; s += gap) {
        for (const side of [-1, 1]) {
          const site = this.#site(s, side, 26 + rand() * 2, 18);
          if (site) this.#put('models/props/fence.glb', site.position, { yaw: site.heading, scale: 1.6 });
        }
      }
    }
  }

  /** Parked cars, a couple of buildings and a wall around them. */
  #paddock(s, rand, heroes) {
    const track = this.track;
    // Whichever side has room for it.
    const side = this.#site(s, 1, 60, 40) ? 1 : -1;

    const anchor = this.#site(s, side, 44, 26);
    if (!anchor) return;
    const across = anchor.heading + Math.PI / 2;

    // Rows of cars, nose-in, the way a paddock actually parks.
    //
    // The front row is the real thing — the cars the race is run in, three of
    // them, where a driver walks past on the way to the grid. Everything
    // behind is the low-poly prop. That split is the whole trick: a race car
    // here is fifty to a hundred primitives because every vent and badge
    // carries its own material, and eighty of those is several hundred draw
    // calls for a car park nobody looks at twice.
    const rows = Math.max(3, Math.round(4 * clamp(this.density, 0.5, 1.2)));
    const perRow = Math.max(4, Math.round(7 * clamp(this.density, 0.5, 1.2)));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < perRow; c++) {
        const along = (c - (perRow - 1) / 2) * 3.1;
        const back = r * 7.4;
        const x = anchor.position.x + Math.sin(anchor.heading) * along + Math.sin(across) * back;
        const z = anchor.position.z + Math.cos(anchor.heading) * along + Math.cos(across) * back;
        const ground = terrainHeightAt(track, x, z, {});
        if (ground.edge < 24) continue;
        const hero = r === 0 && c < heroes.length ? heroes[c] : null;
        this.#put(hero ?? 'models/props/car.glb', new THREE.Vector3(x, ground.y, z), {
          // Facing across the rows, alternating so the rows face each other.
          yaw: across + (r % 2 === 0 ? 0 : Math.PI) + (rand() - 0.5) * 0.06,
          scale: hero ? 1 : 1.05,
        });
      }
    }

    // Two buildings behind them, and a wall along the front.
    for (const [path, depth, along, scale] of [
      ['models/props/inn.glb', 78, -26, 1.9],
      ['models/props/cottage.glb', 74, 20, 1.7],
      ['models/props/sawmill.glb', 92, 48, 1.6],
    ]) {
      const site = this.#site(s + along, side, depth, 30);
      if (site) this.#put(path, site.position, { yaw: site.heading + Math.PI / 2, scale });
    }
    const span = this.density < 0.5 ? 3 : 6;
    for (let k = -span; k <= span; k++) {
      const site = this.#site(s + k * 7.5, side, 30, 24);
      if (site) this.#put('models/props/wall.glb', site.position, { yaw: site.heading, scale: 1.5 });
    }
  }

  /**
   * Spectator parking: rows of cars in a field, the way it is at every
   * circuit in the world on a race morning.
   */
  #carPark(s, rand) {
    const track = this.track;
    const side = this.#site(s, 1, 90, 44) ? 1 : -1;
    const anchor = this.#site(s, side, 82, 40);
    if (!anchor) return;
    const across = anchor.heading + Math.PI / 2;

    const rows = Math.round(6 * clamp(this.density, 0.4, 1.2));
    const perRow = Math.round(9 * clamp(this.density, 0.4, 1.2));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < perRow; c++) {
        const along = (c - (perRow - 1) / 2) * 2.9;
        const back = (r - rows / 2) * 6.8;
        const x = anchor.position.x + Math.sin(anchor.heading) * along + Math.sin(across) * back;
        const z = anchor.position.z + Math.cos(anchor.heading) * along + Math.cos(across) * back;
        const ground = terrainHeightAt(track, x, z, {});
        if (ground.edge < 38) continue;
        this.#put('models/props/car.glb', new THREE.Vector3(x, ground.y, z), {
          yaw: across + (r % 2 === 0 ? 0 : Math.PI) + (rand() - 0.5) * 0.05,
          scale: 1.05,
        });
      }
    }
  }

  /** Sheds, stacked crates, barrels and a saw — the works compound. */
  #works(s, rand) {
    const side = this.#site(s, -1, 46, 26) ? -1 : 1;
    const kit = [
      ['models/props/sawmill.glb', 52, -14, 1.7],
      ['models/props/logsaw.glb', 40, 4, 1.5],
      ['models/props/wagon.glb', 36, 16, 1.4],
      ['models/props/cratestack.glb', 43, -3, 1.5],
      ['models/props/crate1.glb', 38, 10, 1.4],
      ['models/props/crate2.glb', 45, 22, 1.4],
      ['models/props/stump.glb', 34, -20, 1.6],
    ];
    for (const [path, depth, along, scale] of kit) {
      const site = this.#site(s + along, side, depth, 22);
      if (site) this.#put(path, site.position, { yaw: site.heading + rand() * 1.2, scale });
    }
    // Barrels, scattered the way barrels are.
    for (let k = 0; k < Math.round(12 * clamp(this.density, 0.4, 1.2)); k++) {
      const site = this.#site(s + (rand() - 0.5) * 48, side, 32 + rand() * 18, 22);
      if (site) this.#put('models/props/barrel.glb', site.position, { yaw: rand() * 6.28, scale: 1.3 });
    }
    for (let k = -4; k <= 4; k++) {
      const site = this.#site(s + k * 7.4, side, 26, 20);
      if (site) this.#put('models/props/wallcorner.glb', site.position, { yaw: site.heading, scale: 1.4 });
    }
  }

  /** A handful of buildings set well back, for the middle distance. */
  #village(s, rand) {
    const kit = [
      ['models/props/cottage.glb', 1.7],
      ['models/props/inn.glb', 1.9],
      ['models/props/cottage.glb', 1.6],
      ['models/props/well.glb', 1.5],
      ['models/props/cottage.glb', 1.8],
      ['models/props/wagon.glb', 1.4],
      ['models/props/cottage.glb', 1.5],
      ['models/props/lightpost.glb', 1.5],
      ['models/props/barrel.glb', 1.3],
      ['models/props/cottage.glb', 1.9],
      ['models/props/inn.glb', 1.7],
      ['models/props/stump.glb', 1.5],
    ];
    const side = rand() > 0.5 ? 1 : -1;
    for (let k = 0; k < kit.length; k++) {
      const [path, scale] = kit[k];
      // Two loose rows either side of a lane, which is what a village is.
      const lane = k % 2 === 0 ? 0 : 34;
      const site = this.#site(s + (k - kit.length / 2) * 21 + rand() * 9, side, 58 + lane + rand() * 26, 34);
      if (site) this.#put(path, site.position, { yaw: rand() * 6.28, scale });
    }
  }

  /* -------------------------------------------------------------- drawing */

  /**
   * Splits a model's placements into spatial groups.
   *
   * One InstancedMesh holding every fence panel on the circuit is one draw
   * call, which sounds ideal until you notice its bounding sphere is the
   * whole circuit — so it is never outside the frustum, and every panel
   * behind the camera is submitted for every cascade of every shadow map on
   * every frame. Grouping by where they are costs a handful more draw calls
   * and lets the ones behind you be skipped, which is the entire point of
   * having a frustum.
   */
  #chunk(placements, size = 260) {
    const groups = new Map();
    for (const p of placements) {
      const key = `${Math.round(p.position.x / size)},${Math.round(p.position.z / size)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    return [...groups.values()];
  }

  /**
   * One InstancedMesh per distinct mesh in the source model, so twenty
   * cottages are as many draw calls as one.
   */
  #instance(scene, placements, castShadow) {
    scene.updateMatrixWorld(true);
    const meshes = [];
    scene.traverse((o) => {
      if (o.isMesh && o.geometry) meshes.push(o);
    });
    if (!meshes.length) return;

    const local = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    const dummy = new THREE.Object3D();

    for (const mesh of meshes) {
      const instanced = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length);
      // Only the things big enough for their shadow to be worth another pass
      // over them cast one. A fence panel's shadow is a line on the grass.
      instanced.castShadow = castShadow;
      instanced.receiveShadow = true;
      instanced.name = mesh.name || 'prop';
      local.copy(mesh.matrixWorld);

      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        dummy.position.copy(p.position);
        dummy.rotation.set(0, p.yaw, 0);
        dummy.scale.setScalar(p.scale);
        dummy.updateMatrix();
        world.multiplyMatrices(dummy.matrix, local);
        instanced.setMatrixAt(i, world);
      }
      instanced.instanceMatrix.needsUpdate = true;
      instanced.frustumCulled = true;
      instanced.computeBoundingSphere?.();
      this.group.add(instanced);
    }
  }
}

/** A small deterministic PRNG, so a circuit's props are the same every time. */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
