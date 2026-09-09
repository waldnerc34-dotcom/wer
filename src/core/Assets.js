import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const BASE = `${import.meta.env?.BASE_URL ?? '/'}assets/`;

/**
 * Loads and caches every runtime asset, reporting aggregate progress so the
 * loading screen can show something honest rather than a fake bar.
 */
export class Assets {
  constructor(renderer) {
    this.renderer = renderer;
    this.manager = new THREE.LoadingManager();

    this.gltf = new GLTFLoader(this.manager);
    // The Draco decoder ships with the game rather than being pulled from a
    // CDN, so the whole thing runs offline and never blocks on a third party.
    const draco = new DRACOLoader(this.manager);
    draco.setDecoderPath(`${import.meta.env?.BASE_URL ?? '/'}draco/`);
    this.gltf.setDRACOLoader(draco);

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
    const promise = this.gltf.loadAsync(this.url(path)).then((gltf) => gltf);
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

    const promise = this.tex.loadAsync(this.url(path)).then((t) => {
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

  /* ---------------------------------------------------------- environment */

  /**
   * Loads an equirectangular HDRI and prefilters it into a PMREM cube used for
   * image-based lighting. Also returns the raw equirect for the sky dome.
   */
  async environment(file) {
    if (this.envs.has(file)) return this.envs.get(file);
    const promise = this.hdr.loadAsync(this.url(`hdri/${file}`)).then((hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const target = this.pmrem.fromEquirectangular(hdr);
      return { envMap: target.texture, background: hdr, target };
    });
    this.envs.set(file, promise);
    return promise;
  }

  dispose() {
    this.pmrem.dispose();
  }
}
