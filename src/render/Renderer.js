import * as THREE from 'three';
import {
  BloomEffect,
  BlendFunction,
  ChromaticAberrationEffect,
  Effect,
  EffectComposer,
  EffectPass,
  KernelSize,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js';

import { clamp } from '../core/MathUtils.js';

/** Quality presets, from "runs on a laptop" to "runs on a good GPU". */
export const QUALITY = {
  low: {
    label: 'Performance',
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 240,
    ao: false,
    bloom: true,
    motionBlur: false,
    smaa: false,
    anisotropy: 4,
    sceneryDensity: 0.35,
  },
  medium: {
    label: 'Balanced',
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 400,
    ao: true,
    aoQuality: 'low',
    bloom: true,
    motionBlur: true,
    smaa: true,
    anisotropy: 8,
    sceneryDensity: 0.7,
  },
  high: {
    label: 'Quality',
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 620,
    ao: true,
    aoQuality: 'medium',
    bloom: true,
    motionBlur: true,
    smaa: true,
    anisotropy: 16,
    sceneryDensity: 1,
  },
};

/**
 * Speed-driven radial blur.
 *
 * A full velocity-buffer motion blur is overkill for a chase camera that is
 * almost always pointing where the car is going: streaking the image radially
 * outward from the focus of expansion reads as the same thing and costs one
 * texture fetch per sample.
 */
class SpeedBlurEffect extends Effect {
  constructor() {
    super(
      'SpeedBlur',
      /* glsl */ `
      uniform float uStrength;
      uniform vec2  uCentre;

      void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
        if ( uStrength < 0.001 ) { outputColor = inputColor; return; }

        vec2 dir = uv - uCentre;
        float dist = length( dir );
        // Leave the middle of the screen sharp; streak hardest at the edges.
        float amount = uStrength * smoothstep( 0.12, 0.85, dist );

        vec4 sum = inputColor;
        for ( int i = 1; i < 7; i ++ ) {
          float t = float( i ) / 6.0;
          vec2 offset = dir * amount * t;
          sum += texture2D( inputBuffer, uv - offset );
        }
        outputColor = sum / 7.0;
      }
      `,
      {
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map([
          ['uStrength', new THREE.Uniform(0)],
          ['uCentre', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ]),
      },
    );
  }

  set strength(v) {
    this.uniforms.get('uStrength').value = v;
  }

  get centre() {
    return this.uniforms.get('uCentre').value;
  }
}

/**
 * Owns the WebGL context, the scene-wide lighting rig and the post-processing
 * chain. Everything that touches the GPU lives behind this class.
 */
export class Renderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.settings = { ...QUALITY[quality] };
    this.qualityName = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA runs in the post chain instead
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // handled in post
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.settings.pixelRatio));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.15, 6000);

    this.#buildLighting();
    this.#buildComposer();

    this.frameTimes = [];
    this.resize();
  }

  /* -------------------------------------------------------------- lighting */

  #buildLighting() {
    // Sun. Direction is set per-circuit from the HDRI's own sun position so
    // the shadows agree with the sky.
    this.sun = new THREE.DirectionalLight(0xfff2e0, 3.1);
    this.sun.position.set(-120, 90, 60);
    this.scene.add(this.sun, this.sun.target);

    // Cascaded shadow maps: one map per depth slice, so the shadow under the
    // car stays sharp while the treeline 500 m away still casts.
    if (this.settings.shadows) {
      this.csm = new CSM({
        maxFar: this.settings.shadowDistance,
        cascades: this.settings.cascades,
        mode: 'practical',
        parent: this.scene,
        shadowMapSize: this.settings.shadowMapSize,
        lightDirection: new THREE.Vector3(0.5, -1, -0.4).normalize(),
        camera: this.camera,
        lightIntensity: 3.1,
        shadowBias: -0.00018,
        lightNear: 1,
        lightFar: this.settings.shadowDistance * 2.2,
      });
      this.sun.visible = false;
      for (const light of this.csm.lights) light.color.set(0xfff2e0);
    }

    // A very small ambient term stands in for the light the HDRI cannot
    // deliver into deep crevices; image-based lighting does the rest.
    this.hemi = new THREE.HemisphereLight(0x9fb6d4, 0x4a4238, 0.28);
    this.scene.add(this.hemi);
  }

  /** Points the sun using the azimuth/elevation recorded with each circuit. */
  setSun(azimuthDeg, elevationDeg, color = 0xfff2e0, intensity = 3.1) {
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    const dir = new THREE.Vector3(
      -Math.cos(el) * Math.sin(az),
      -Math.sin(el),
      -Math.cos(el) * Math.cos(az),
    ).normalize();

    if (this.csm) {
      this.csm.lightDirection.copy(dir);
      this.csm.lightIntensity = intensity;
      for (const light of this.csm.lights) {
        light.color.set(color);
        light.intensity = intensity;
      }
    }
    this.sun.position.copy(dir).multiplyScalar(-300);
    this.sun.color.set(color);
    this.sun.intensity = intensity;
    this.sunDirection = dir;
  }

  /* ------------------------------------------------------------- post chain */

  #buildComposer() {
    const s = this.settings;
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (s.ao) {
      this.ao = new N8AOPostPass(this.scene, this.camera, 1, 1);
      this.ao.configuration.aoRadius = 2.4;
      this.ao.configuration.distanceFalloff = 1.2;
      this.ao.configuration.intensity = 2.6;
      this.ao.configuration.color = new THREE.Color(0x0a0c10);
      this.ao.setQualityMode(s.aoQuality === 'medium' ? 'Medium' : 'Low');
      this.composer.addPass(this.ao);
    }

    this.bloom = new BloomEffect({
      intensity: 0.62,
      luminanceThreshold: 0.78,
      luminanceSmoothing: 0.28,
      mipmapBlur: true,
      kernelSize: KernelSize.LARGE,
    });

    this.speedBlur = new SpeedBlurEffect();

    this.chromatic = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0006, 0.0006),
      radialModulation: true,
      modulationOffset: 0.4,
    });

    this.vignette = new VignetteEffect({ offset: 0.28, darkness: 0.52 });

    // AgX holds highlights together far better than Reinhard on a scene lit
    // by a real HDRI, and keeps the sky from clipping to white.
    this.toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,
      resolution: 256,
      whitePoint: 12,
      middleGrey: 0.44,
    });

    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    this.grain.blendMode.opacity.value = 0.055;

    const effects = [];
    if (s.motionBlur) effects.push(this.speedBlur);
    if (s.bloom) effects.push(this.bloom);
    effects.push(this.chromatic, this.vignette, this.toneMapping, this.grain);
    this.composer.addPass(new EffectPass(this.camera, ...effects));

    if (s.smaa) {
      this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));
    }
  }

  /* ---------------------------------------------------------------- runtime */

  /**
   * Applies the prefiltered HDRI as both the sky and the lighting source.
   *
   * A plain equirectangular background puts the captured horizon at infinity,
   * which makes the buildings in it read as a wall standing right behind the
   * circuit. Projecting the same panorama onto a ground-capped dome instead
   * puts that horizon at a believable distance and lets the terrain meet it.
   */
  setEnvironment({ envMap, background }, { groundRadius = 1900, groundHeight = 78 } = {}) {
    this.scene.environment = envMap;
    this.scene.environmentIntensity = 1;
    this.envMap = envMap;

    if (this.skybox) {
      this.scene.remove(this.skybox);
      this.skybox.geometry.dispose();
      this.skybox.material.dispose();
      this.skybox = null;
    }

    if (groundRadius > 0) {
      this.skybox = new GroundedSkybox(background, groundHeight, groundRadius, 32);
      this.skybox.name = 'sky';
      this.skybox.renderOrder = -1;
      // The dome sits near the far plane, so scene fog would render it as a
      // flat grey wall. It is the sky: it must not be fogged.
      this.skybox.material.fog = false;
      this.skybox.material.toneMapped = true;
      this.skybox.frustumCulled = false;
      this.scene.add(this.skybox);
      this.scene.background = null;
      // The dome is the sky, so the scene still needs something behind it at
      // the poles; the same texture, unprojected, does the job.
      this.scene.background = background;
      this.scene.backgroundBlurriness = 0.008;
    } else {
      this.scene.background = background;
      this.scene.backgroundBlurriness = 0.012;
    }
  }

  /** Keeps the projected horizon centred on the car. */
  setSkyboxCentre(position) {
    if (!this.skybox) return;
    this.skybox.position.set(position.x, this.skyboxY ?? 0, position.z);
  }

  setFog(color, near, far) {
    this.scene.fog = new THREE.Fog(color, near, far);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.ao?.setSize(w, h);
    this.csm?.updateFrustums();
  }

  /**
   * Sets the strength of the speed streak.
   * @param {number} speedKph
   */
  setSpeedBlur(speedKph, focus) {
    if (!this.settings.motionBlur) return;
    this.speedBlur.strength = clamp((speedKph - 90) / 620, 0, 0.09);
    if (focus) this.speedBlur.centre.copy(focus);
  }

  render(dt) {
    this.csm?.update();
    this.composer.render(dt);
  }

  dispose() {
    this.csm?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
