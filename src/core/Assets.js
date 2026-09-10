import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const BASE = `${import.meta.env?.BASE_URL ?? '/'}assets/`;

/**
 * Single-file builds carry every asset inline as base64 (see
 * scripts/build-artifact.mjs). When that table is present nothing is ever
 * fetched: models and HDRIs are parsed straight from memory, and textures
 * are given to the browser as data: URIs.
 */
const EMBEDDED = globalThis.APEX_ASSETS ?? null;

function embeddedOrThrow(path) {
  const entry = EMBEDDED[path];
  if (!entry) throw new Error(`Asset "${path}" is not embedded in this build`);
  return entry;
}

function bytesOf(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * Loads and caches every runtime asset, reporting aggregate progress so the
 * loading screen can show something honest rather than a fake bar.
 */
export class Assets {
  /** Whether a build can load this asset at all — single-file builds carry a subset. */
  static available(path) {
    return !EMBEDDED || Boolean(EMBEDDED[path]);
  }

  /** A URL the DOM can use for an image: the served file, or the embedded data: URI. */
  static urlFor(path) {
    if (EMBEDDED) return EMBEDDED[path] ?? null;
    return `./assets/${path}`;
  }

  constructor(renderer) {
    this.renderer = renderer;
    this.manager = new THREE.LoadingManager();

    this.gltf = new GLTFLoader(this.manager);
    this.embedded = Boolean(EMBEDDED);

    if (this.embedded) {
      // A sandboxed page cannot fetch, and GLTFLoader's image-bitmap path
      // fetches. With this global gone it falls back to a plain <img>, which
      // accepts a data: URI without any network access at all.
      globalThis.createImageBitmap = undefined;
    } else {
      // The Draco decoder ships with the game rather than being pulled from a
      // CDN, so the whole thing runs offline and never blocks on a third party.
      const draco = new DRACOLoader(this.manager);
      draco.setDecoderPath(`${import.meta.env?.BASE_URL ?? '/'}draco/`);
      this.gltf.setDRACOLoader(draco);
    }

    this.hdr = new HDRLoader(this.manager);
    this.tex = new THREE.TextureLoader(this.manager);

    this.models = new Map();
    this.textures = new Map();
    this.envs = new Map();

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.onProgress = null;
    this.manager.onProgress = (_url, loaded, total) => {
      this.onProgress?.(total ? loaded / total : 0, loaded, total);
    };
  }

  url(path) {
    return BASE + path;
  }

  /* --------------------------------------------------------------- models */

  async model(path) {
    if (this.models.has(path)) return this.models.get(path);
    const promise = this.embedded
      ? new Promise((resolve, reject) =>
          this.gltf.parse(bytesOf(embeddedOrThrow(path)), '', resolve, reject),
        )
      : this.gltf.loadAsync(this.url(path));
    this.models.set(path, promise);
    return promise;
  }

  /** A fresh, independently transformable clone of a loaded model. */
  async instance(path) {
    const gltf = await this.model(path);
    return gltf.scene.clone(true);
  }

  /* ------------------------------------------------------------- textures */

  /**
   * @param {object} opts
   * @param {boolean} opts.srgb  colour data (base colour) vs linear data
   * @param {number}  opts.repeat default wrap repeat
   * @param {number}  opts.aniso  anisotropic filtering samples
   */
  async texture(path, { srgb = false, repeat = 1, aniso = 16 } = {}) {
    const key = `${path}|${srgb}|${repeat}`;
    if (this.textures.has(key)) return this.textures.get(key);

    const src = this.embedded ? embeddedOrThrow(path) : this.url(path);
    const promise = this.tex.loadAsync(src).then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = Math.min(aniso, this.renderer.capabilities.getMaxAnisotropy());
      t.needsUpdate = true;
      return t;
    });
    this.textures.set(key, promise);
    return promise;
  }

  /* ---------------------------------------------------------------- audio */

  /**
   * Raw bytes of a sound file, for the audio engine to decode. Cached, and
   * handed out as a copy each time because decodeAudioData consumes its input.
   */
  async audio(path) {
    this.sounds ??= new Map();
    if (!this.sounds.has(path)) {
      const load = this.embedded
        ? Promise.resolve(bytesOf(embeddedOrThrow(path)))
        : fetch(this.url(path)).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
            return r.arrayBuffer();
          });
      this.sounds.set(path, load);
    }
    return (await this.sounds.get(path)).slice(0);
  }

  /**
   * Any small binary file, or null if this build does not carry it.
   *
   * Unlike everything else here, a missing one is not an error: ghosts are a
   * nicety, and a build that left them out to fit in a page should still run.
   */
  async bytes(path) {
    this.blobs ??= new Map();
    if (!this.blobs.has(path)) {
      const load = this.embedded
        ? Promise.resolve(EMBEDDED[path] ? bytesOf(EMBEDDED[path]) : null)
        : fetch(this.url(path))
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null);
      this.blobs.set(path, load);
    }
    const buffer = await this.blobs.get(path);
    return buffer ? new Uint8Array(buffer) : null;
  }

  /* ---------------------------------------------------------- environment */

  /**
   * Loads an equirectangular HDRI and prefilters it into a PMREM cube used for
   * image-based lighting. Also returns the raw equirect for the sky dome.
   */
  async environment(file) {
    if (this.envs.has(file)) return this.envs.get(file);
    // A single-file build may carry only one sky; any circuit gets it.
    const embeddedKey = this.embedded
      ? EMBEDDED[`hdri/${file}`]
        ? `hdri/${file}`
        : Object.keys(EMBEDDED).find((k) => k.startsWith('hdri/'))
      : null;
    const load = this.embedded
      ? Promise.resolve(this.#hdrFromMemory(embeddedOrThrow(embeddedKey)))
      : this.hdr.loadAsync(this.url(`hdri/${file}`));
    const promise = load.then((hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const target = this.pmrem.fromEquirectangular(hdr);
      return { envMap: target.texture, background: hdr, target };
    });
    this.envs.set(file, promise);
    return promise;
  }

  /** What DataTextureLoader.load does after its fetch, minus the fetch. */
  #hdrFromMemory(base64) {
    const data = this.hdr.parse(bytesOf(base64));
    const texture = new THREE.DataTexture(
      data.data,
      data.width,
      data.height,
      THREE.RGBAFormat,
      data.type,
    );
    texture.flipY = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  dispose() {
    this.pmrem.dispose();
  }
}
