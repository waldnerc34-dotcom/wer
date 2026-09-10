import * as THREE from 'three';

import { lerp } from '../core/MathUtils.js';

/**
 * Weather presets.
 *
 * `wet` drives grip (through the track), the road shader, tyre cooling, the
 * AI's planner and the pacing arrows. `sky` describes how the circuit's own
 * HDRI is reworked into this weather's sky — desaturated, dimmed, tinted,
 * highlights flattened — which is how one captured panorama serves six
 * conditions without six downloads.
 */
export const WEATHERS = [
  {
    id: 'clear',
    label: 'Clear',
    note: 'Dry and bright',
    wet: 0,
    sky: { exposure: 1, desaturate: 0, tint: [1, 1, 1], flatten: 0 },
    env: 1,
    sun: { intensity: 1, color: 0xfff2e0 },
    hemi: 0.28,
    fog: { color: 0xa8bacd, near: 620, far: 3400, scatter: 0.95, shafts: 0.5, height: 110 },
    rain: 0,
    wind: 0.55,
    headlights: false,
    ambientTemp: 22,
  },
  {
    id: 'overcast',
    label: 'Overcast',
    note: 'Flat light, dry',
    wet: 0,
    sky: { exposure: 0.55, desaturate: 0.7, tint: [0.96, 0.98, 1.02], flatten: 0.9 },
    env: 0.75,
    sun: { intensity: 0.3, color: 0xe8ecf2 },
    hemi: 0.4,
    fog: { color: 0xa9b1ba, near: 480, far: 2600, scatter: 0.35, shafts: 0.12, height: 140 },
    rain: 0,
    wind: 0.8,
    headlights: false,
    ambientTemp: 16,
  },
  {
    id: 'rain',
    label: 'Rain',
    note: 'Wet track, spray',
    wet: 0.85,
    sky: { exposure: 0.34, desaturate: 0.85, tint: [0.9, 0.95, 1.05], flatten: 1 },
    env: 0.55,
    sun: { intensity: 0.16, color: 0xd8dfe8 },
    hemi: 0.42,
    fog: { color: 0x8b95a3, near: 200, far: 1500, scatter: 0.3, shafts: 0.06, height: 80 },
    rain: 1,
    wind: 1.0,
    headlights: true,
    ambientTemp: 13,
  },
  {
    id: 'storm',
    label: 'Storm',
    note: 'Standing water, low visibility',
    wet: 1,
    sky: { exposure: 0.2, desaturate: 0.9, tint: [0.85, 0.9, 1.05], flatten: 1 },
    env: 0.4,
    sun: { intensity: 0.07, color: 0xc4ccd8 },
    hemi: 0.36,
    fog: { color: 0x6e7681, near: 110, far: 900, scatter: 0.2, shafts: 0.0, height: 60 },
    rain: 2,
    wind: 1.7,
    headlights: true,
    ambientTemp: 11,
  },
  {
    id: 'fog',
    label: 'Fog',
    note: 'Damp, a few hundred metres of sight',
    wet: 0.3,
    sky: { exposure: 0.5, desaturate: 0.8, tint: [1, 1, 1], flatten: 1 },
    env: 0.6,
    sun: { intensity: 0.12, color: 0xe4e8ee },
    hemi: 0.45,
    fog: { color: 0xb9c0c8, near: 55, far: 420, scatter: 0.55, shafts: 0.2, height: 22 },
    rain: 0,
    wind: 0.3,
    headlights: true,
    ambientTemp: 12,
  },
  {
    id: 'night',
    label: 'Night',
    note: 'Headlights only',
    wet: 0,
    sky: { exposure: 0.018, desaturate: 0.3, tint: [0.55, 0.66, 1.05], flatten: 0.6 },
    env: 0.16,
    sun: { intensity: 0.035, color: 0x8fa8ff },
    hemi: 0.05,
    fog: { color: 0x05070c, near: 160, far: 1600, scatter: 0.08, shafts: 0.0, height: 90 },
    rain: 0,
    wind: 0.4,
    headlights: true,
    ambientTemp: 15,
  },
];

export const weatherById = (id) => WEATHERS.find((w) => w.id === id) ?? WEATHERS[0];

/**
 * Applies a preset to a running session.
 *
 * Everything it touches keeps its original value the first time it is seen,
 * so presets can be switched in any order without drift.
 */
export class Weather {
  constructor(game) {
    this.game = game;
    this.current = null;
    this.skyCache = new Map();
    this.baseMaterials = new Map();
  }

  /**
   * @param {string} id preset id
   */
  async apply(id) {
    const game = this.game;
    const w = weatherById(id);
    this.current = w;

    /* -- sky and light ------------------------------------------------- */
    const base = await game.assets.environment(game.circuit.hdri);
    const sky = this.#deriveSky(game.circuit.hdri, base.background, w.sky);
    const envMap = this.#envFor(game.circuit.hdri, w.id, sky);
    game.renderer.setEnvironment({ envMap, background: sky }, { groundRadius: 2100, groundHeight: 88 });
    game.renderer.skyboxY = game.track.pos[1] - 1.5;
    game.renderer.scene.environmentIntensity = w.env;
    game.renderer.setSun(game.circuit.sunAzimuth, game.circuit.sunElevation, w.sun.color, 3.1 * w.sun.intensity);
    game.renderer.hemi.intensity = w.hemi;
    game.renderer.setFog(new THREE.Color(w.fog.color), w.fog.near, w.fog.far, w.fog);

    /* -- track ----------------------------------------------------------- */
    game.track.wetness = w.wet;
    game.pacing?.compute();
    game.racingLine?.refresh();

    /* -- surfaces -------------------------------------------------------- */
    this.#wetMaterials(w.wet);

    /* -- cars ------------------------------------------------------------ */
    for (const v of [game.player, ...game.opponents.map((o) => o.vehicle)]) {
      if (!v) continue;
      for (const wheel of v.wheels) wheel.tyre.tempAmbient = w.ambientTemp;
    }
    game.headlightsOn = w.headlights;
    game.playerRig?.setHeadlights(w.headlights);
    for (const o of game.opponents) o.rig.setHeadlights(w.headlights);

    /* -- atmosphere ------------------------------------------------------ */
    game.rain?.setIntensity(w.rain, w.wind);
    game.splashes?.setIntensity(w.rain);
    game.renderer.setRainOnLens(w.rain);
    // A soaked circuit is a mirror; dry tarmac scatters almost everything.
    game.renderer.setReflectivity(w.wet);
    game.scenery?.setWind(w.wind);
    game.audio?.setWeather(w.rain, w.wind);

    return w;
  }

  /**
   * Reworks a captured sky into a weather. Runs on the CPU over the half-float
   * texels once per circuit and preset, then is cached.
   */
  #deriveSky(hdriKey, source, params) {
    const key = `${hdriKey}|${JSON.stringify(params)}`;
    if (this.skyCache.has(key)) return this.skyCache.get(key);

    const { exposure, desaturate, tint, flatten } = params;
    if (exposure === 1 && desaturate === 0 && flatten === 0) {
      this.skyCache.set(key, source);
      return source;
    }

    const img = source.image;
    const src = img.data;
    const half = source.type === THREE.HalfFloatType;
    const read = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    const write = half ? THREE.DataUtils.toHalfFloat : (v) => v;
    const out = new src.constructor(src.length);

    // Bright sun discs are flattened toward the sky's mean, which is what an
    // overcast sky is: the same light, spread across the whole dome.
    let mean = 0;
    const n = img.width * img.height;
    for (let i = 0; i < n; i++) {
      mean += 0.2126 * read(src[i * 4]) + 0.7152 * read(src[i * 4 + 1]) + 0.0722 * read(src[i * 4 + 2]);
    }
    mean /= n;
    const ceiling = mean * 4;

    for (let i = 0; i < n; i++) {
      let r = read(src[i * 4]);
      let g = read(src[i * 4 + 1]);
      let b = read(src[i * 4 + 2]);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (flatten > 0 && lum > ceiling) {
        const k = lerp(1, ceiling / lum, flatten);
        r *= k;
        g *= k;
        b *= k;
      }
      const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lerp(r, l2, desaturate) * exposure * tint[0];
      g = lerp(g, l2, desaturate) * exposure * tint[1];
      b = lerp(b, l2, desaturate) * exposure * tint[2];
      out[i * 4] = write(r);
      out[i * 4 + 1] = write(g);
      out[i * 4 + 2] = write(b);
      out[i * 4 + 3] = src[i * 4 + 3];
    }

    const tex = new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, source.type);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.flipY = source.flipY;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.skyCache.set(key, tex);
    return tex;
  }

  #envFor(hdriKey, weatherId, sky) {
    const key = `env|${hdriKey}|${weatherId}`;
    if (this.skyCache.has(key)) return this.skyCache.get(key);
    const target = this.game.assets.pmrem.fromEquirectangular(sky);
    this.skyCache.set(key, target.texture);
    return target.texture;
  }

  /** Darkens and glosses the trackside surfaces by wetness. */
  #wetMaterials(wet) {
    const mats = this.game.materials;
    mats.wetUniform.value = wet;
    // Ripples only while it is actually falling: a road that stays wet after
    // the rain stops is still, and standing water in a downpour is not.
    mats.rainUniform.value = Math.min(1, (this.current?.rain ?? 0) * 0.7);
    mats.road.envMapIntensity = lerp(0.55, 1.35, wet);

    const dress = (m, { rough = 0.4, dark = 0.62 } = {}) => {
      if (!m) return;
      if (!this.baseMaterials.has(m)) {
        this.baseMaterials.set(m, { roughness: m.roughness, color: m.color.clone(), env: m.envMapIntensity });
      }
      const base = this.baseMaterials.get(m);
      m.roughness = lerp(base.roughness, base.roughness * rough, wet);
      m.color.copy(base.color).multiplyScalar(lerp(1, dark, wet));
      m.envMapIntensity = lerp(base.env, base.env * 1.8, wet);
    };
    dress(mats.kerb, { rough: 0.3, dark: 0.7 });
    dress(mats.apron, { rough: 0.35 });
    dress(mats.concrete, { rough: 0.5, dark: 0.7 });
    dress(mats.gravel, { rough: 0.6, dark: 0.55 });
    dress(mats.terrain, { rough: 0.75, dark: 0.7 });
    dress(mats.line, { rough: 0.4, dark: 0.85 });
    dress(mats.armco, { rough: 0.55, dark: 0.9 });
  }
}
