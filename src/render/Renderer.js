import * as THREE from 'three';
import {
  BloomEffect,
  BlendFunction,
  ChromaticAberrationEffect,
  Effect,
  EffectComposer,
  EffectPass,
  KernelSize,
  HueSaturationEffect,
  NoiseEffect,
  NormalPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

import { RainDropsEffect, RainDropsOverlay, RainOnLens } from './RainDrops.js';
import { AtmosphereEffect } from './Atmosphere.js';
import { ReflectionsEffect } from './Reflections.js';
import { ResolutionScaler } from './Resolution.js';
import { SharpenEffect } from './Sharpen.js';
import { HighlightGuard } from './Highlights.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { GroundedSkybox } from 'three/examples/jsm/objects/GroundedSkybox.js';

import { clamp } from '../core/MathUtils.js';

const _size = new THREE.Vector2();

/**
 * Quality presets, from "runs on a phone" to "renders at 4K and resolves it
 * down to whatever panel you have".
 *
 * `pixelRatio` caps how many device pixels are spent per CSS pixel and
 * `renderScale` multiplies that; above 1 it is supersampling, which is the
 * oldest and best anti-aliasing there is. `superSampleTo` raises the scale
 * further until the frame buffer is at least that many pixels across, so
 * Ultra is 4K on a 1080p monitor too, not only on a 4K one.
 *
 * None of it is a promise the machine has to keep: `dynamicResolution` lets
 * the renderer trade pixels back for frame rate, measured rather than
 * guessed (see Resolution.js).
 */
export const QUALITY = {
  mobile: {
    label: 'Mobile',
    // Phones ship 3× screens. Native resolution would spend the whole GPU
    // budget on pixels nobody can see, but capping at 1× reads as a smear on
    // a Retina panel. 2× capped and scaled lands a little over 1.5 device
    // pixels per CSS pixel — crisp, at not much over half the cost of native.
    pixelRatio: 2,
    renderScale: 0.78,
    // And a hard ceiling for the tablets: a 13" iPad at 2× would otherwise
    // ask a phone-class GPU for five megapixels of half-float buffers.
    maxPixels: 3.2e6,
    shadows: true,
    shadowMapSize: 2048,
    cascades: 2,
    shadowDistance: 300,
    ao: false,
    bloom: true,
    bloomKernel: 'medium',
    motionBlur: false,
    smaa: false,
    // Hardware multisampling instead of SMAA. The GPU in a phone is a tiler:
    // the samples never leave on-chip memory, so resolving them is close to
    // free, while SMAA is a second full-screen pass with a dependent texture
    // read per pixel — which is exactly the thing a phone cannot spare.
    msaa: 4,
    // There *is* a post chain here now. Leaving it out was the wrong trade:
    // it saved one full-screen pass and cost the tone mapping, the bloom and
    // the haze — which is to say most of what makes the picture look like
    // anything. What it buys back is spent on pixels instead, where the
    // scaler can give them up frame by frame when the phone is struggling.
    post: true,
    anisotropy: 8,
    sceneryDensity: 0.6,
    particles: 420,
    skidSegments: 560,
    // Set outright rather than left to the "small preset" rule of thumb,
    // which keys off the particle count and would have tripled the rain the
    // moment the count went up.
    rainCount: 1600,
    splashCount: 260,
    skyResolution: 48,
    reflections: false,
    atmosphere: { samples: 8 },
    dynamicResolution: true,
    targetFps: 60,
    // Room to go a long way down, and a short window so it gets there in a
    // third of a second. A phone that has to drop to half resolution for the
    // eleven-car braking zone and take it back on the straight is doing
    // exactly what it should; one that judders through it is not.
    minScale: 0.5,
    scalerWindow: 20,
  },
  low: {
    label: 'Performance',
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    cascades: 2,
    shadowDistance: 340,
    ao: false,
    bloom: true,
    bloomKernel: 'medium',
    motionBlur: false,
    smaa: false,
    msaa: 2,
    // The road at a grazing angle is most of the screen, and anisotropic
    // filtering is the cheapest thing that fixes it. Phones were getting 8
    // while this tier got 4, which is backwards.
    anisotropy: 8,
    sceneryDensity: 0.7,
    particles: 520,
    skidSegments: 700,
    skyResolution: 48,
    reflections: false,
    atmosphere: { samples: 12 },
    dynamicResolution: true,
    targetFps: 60,
    minScale: 0.55,
    scalerWindow: 24,
  },
  medium: {
    label: 'Balanced',
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 450,
    ao: true,
    aoQuality: 'low',
    bloom: true,
    motionBlur: true,
    smaa: true,
    anisotropy: 8,
    sceneryDensity: 0.85,
    skyResolution: 48,
    reflections: false,
    atmosphere: { samples: 16 },
    dynamicResolution: true,
    targetFps: 60,
    minScale: 0.6,
  },
  high: {
    label: 'Quality',
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 620,
    skyResolution: 48,
    ao: true,
    aoQuality: 'medium',
    bloom: true,
    motionBlur: true,
    smaa: true,
    anisotropy: 16,
    sceneryDensity: 1,
    // Reflections at half-resolution normals: the extra geometry pass is the
    // cost, and half-res normals are plenty for a road surface.
    reflections: { steps: 20, refinements: 3, maxDistance: 70, normalScale: 0.5 },
    atmosphere: { samples: 24 },
    dynamicResolution: true,
    targetFps: 60,
    minScale: 0.68,
  },
  ultra: {
    label: 'Ultra · 4K',
    pixelRatio: 2,
    // Render above the display and resolve down — but only once the machine
    // has shown it can. The frame starts at the display's own resolution and
    // climbs toward 4K while frames stay inside budget, so a GPU that cannot
    // afford half a gigabyte of 4K buffers never allocates them.
    superSampleTo: 3840,
    maxRenderScale: 2,
    // A hard ceiling on the frame buffer, whatever the display. 4K is
    // 8.3 megapixels; the chain behind it — two half-float composer buffers,
    // the normal pass, ambient occlusion, anti-aliasing — costs several
    // hundred megabytes at that size, and asking for more is how a context
    // is lost.
    maxPixels: 8.4e6,
    shadows: true,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 900,
    ao: true,
    aoQuality: 'medium',
    bloom: true,
    motionBlur: true,
    smaa: true,
    anisotropy: 16,
    sceneryDensity: 1.25,
    particles: 1100,
    skidSegments: 1500,
    skyResolution: 64,
    // Twice Quality's budget was not twice the picture, and a single draw
    // with eighty dependent texture reads per pixel across four megapixels is
    // long enough for a driver to decide the GPU has hung and reset it — a
    // black canvas with the sound still playing. Half again is the honest
    // step up.
    reflections: { steps: 28, refinements: 4, maxDistance: 110, normalScale: 1 },
    atmosphere: { samples: 28 },
    dynamicResolution: true,
    targetFps: 60,
    minScale: 0.7,
  },
};

/**
 * What gets given up, and in what order, when there are no pixels left to
 * give. Most expensive first; the ones that would actually be missed go last.
 * Every entry is switchable at runtime without recompiling a shader, which is
 * the whole point — a stutter to avoid a stutter is not a fix.
 */
const SHED = ['reflections', 'ao', 'smaa', 'shafts', 'motionBlur', 'shadowRange'];

/**
 * The preset the player picked, cut down to what the machine can actually be
 * asked for.
 *
 * A quality preset describes a *look*. It is not a promise about hardware,
 * and on a phone the difference is stark: "Quality" asks for four cascades of
 * 4096-pixel shadow maps — four full passes over the circuit before a single
 * lit pixel is drawn — plus a fifth pass for the reflection normals, ambient
 * occlusion, and a screen-space march per pixel. A handset will run that. It
 * will run it at fifteen frames a second, dynamic resolution will chase the
 * frame rate down to the floor, and what you get is a slideshow *and* a
 * smeared one, because pixels are the only thing it knows how to give up.
 *
 * So the structurally impossible parts are clamped up front, and the look is
 * kept: tone mapping, bloom, the haze, ambient occlusion, multisampling, and
 * more of the resolution than the phone tier asks for — which is what makes
 * Quality on a phone a real step above Mobile rather than the same picture
 * with a longer loading screen.
 *
 * @param {object} preset one of QUALITY
 * @param {object} [probe] overrides, so this is testable away from a browser
 */
export function fitToDevice(preset, probe = {}) {
  const {
    coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    touchPoints = (typeof navigator !== 'undefined' && navigator.maxTouchPoints) || 0,
  } = probe;

  // A touchscreen laptop reports a *fine* primary pointer, so this is
  // handhelds rather than "anything you can touch".
  const handheld = Boolean(coarsePointer) && touchPoints > 0;
  const fitted = { ...preset };
  if (!handheld) return fitted;

  fitted.handheld = true;
  // Shadows are the big one: cost goes with the number of cascades, because
  // each is another pass over the geometry.
  fitted.shadowMapSize = Math.min(fitted.shadowMapSize ?? 2048, 2048);
  fitted.cascades = Math.min(fitted.cascades ?? 2, 2);
  fitted.shadowDistance = Math.min(fitted.shadowDistance ?? 300, 420);
  // And the second geometry pass behind the reflections is the other one.
  fitted.reflections = false;
  fitted.motionBlur = false;
  // Multisampling instead of SMAA: on a tiler the samples never leave on-chip
  // memory, while SMAA is another full-screen pass.
  if (fitted.smaa) {
    fitted.smaa = false;
    fitted.msaa = fitted.msaa ?? 2;
  }
  fitted.aoQuality = 'low';
  fitted.anisotropy = Math.min(fitted.anisotropy ?? 8, 8);
  if (fitted.atmosphere) {
    fitted.atmosphere = { ...fitted.atmosphere, samples: Math.min(fitted.atmosphere.samples ?? 12, 12) };
  }
  // Nothing supersamples on a phone, and nothing draws more than this many
  // pixels however large the tablet.
  delete fitted.superSampleTo;
  fitted.maxRenderScale = 1;
  // Two device pixels per CSS pixel, for every tier. Capping at two is the
  // sensible half of this; the other half is that 1.5 is *too low* on a
  // handheld — the panel is a 3× screen, so 1.5 is already a two-times
  // upscale before the scaler has touched anything. `#nativeRatio` still
  // takes the minimum with the real device ratio, so a 1× tablet is
  // unaffected.
  fitted.pixelRatio = 2;
  fitted.maxPixels = Math.min(fitted.maxPixels ?? Infinity, 3.6e6);
  fitted.sceneryDensity = Math.min(fitted.sceneryDensity ?? 1, 1);
  // A floor, and a fairly high one, because on a phone the scale is not the
  // whole story: a 2× preset at 0.55 is 1.1 drawn pixels for every 3 on the
  // glass, and what that looks like is not "softer", it is blocky. Features
  // are the cheaper thing to give up here and the ladder above has real
  // rungs to give — so pixels are defended and detail goes first.
  fitted.minScale = 0.62;
  fitted.scalerWindow = Math.min(fitted.scalerWindow ?? 30, 20);
  return fitted;
}

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
    // What was asked for, cut to what this machine can be asked for.
    this.settings = fitToDevice(QUALITY[quality] ?? QUALITY.high);
    this.qualityName = quality;
    // Only the rungs this preset actually has. On a handheld `fitToDevice`
    // has already turned off reflections, motion blur and SMAA, so counting
    // them as things to give up burns half the ladder achieving nothing
    // while the frames stay late — and then strips ambient occlusion, the
    // light shafts and the shadow reach, which are the ones you can see.
    this.ladder = SHED.filter((rung) => this.#has(rung));
    /** How many rungs are still in hand; see #budget. */
    this.detail = this.ladder.length;
    this.shed = new Set();
    this.pressure = 0;
    this.slack = 0;

    this.usePost = this.settings.post !== false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !this.usePost, // SMAA in the post chain, else hardware MSAA
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // With a post chain, tone mapping is the last effect; without one the
    // main pass does it. AgX either way.
    this.renderer.toneMapping = this.usePost ? THREE.NoToneMapping : THREE.AgXToneMapping;
    // A touch above neutral: AgX protects highlights so well that a
    // straight 1.0 leaves the midtones darker than the scene really is.
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // Pixels are the currency: `#baseScale` decides how many the preset asks
    // for, and the scaler decides how many the machine can actually pay for.
    this.scaler = new ResolutionScaler({
      target: this.settings.targetFps ?? 60,
      min: this.settings.minScale ?? 0.65,
      max: 1,
      window: this.settings.scalerWindow ?? 30,
    });
    this.scaler.setEnabled(this.settings.dynamicResolution !== false);
    this.#applyResolution();

    // A lost context is otherwise a black canvas with the sound still
    // playing: the DOM is fine, so nothing looks wrong except the game. It
    // has to be said out loud, and answered — see main.js, which drops the
    // preset and offers a reload.
    this.contextLost = false;
    this.onContextLost = null;
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      // Whatever it was, it was too much. Come back at the smallest frame
      // this preset allows, and let the scaler earn its way up again.
      this.scaler.scale = this.scaler.min;
      console.error('APEX: the WebGL context was lost — dropping to the lowest resolution.');
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.#applyResolution();
      this.resize();
      console.warn('APEX: the WebGL context is back.');
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.15, 6000);

    this.#buildLighting();
    if (this.usePost) this.#buildComposer();
    // Rain on the lens: an effect in the post chain, or a second pass over
    // a rendered-to-texture frame when there is no chain.
    if (!this.usePost) this.rainOverlay = new RainDropsOverlay(this.renderer);
    this.rainOnLens = new RainOnLens(this.usePost ? this.rainDrops : this.rainOverlay);

    this.frameTimes = [];
    this.resize();
  }

  /** Whether a rung of the ladder is something this preset is actually doing. */
  #has(rung) {
    const s = this.settings;
    if (rung === 'reflections') return Boolean(s.reflections);
    if (rung === 'ao') return Boolean(s.ao);
    if (rung === 'smaa') return Boolean(s.smaa);
    if (rung === 'shafts') return Boolean(s.atmosphere);
    if (rung === 'motionBlur') return Boolean(s.motionBlur);
    if (rung === 'shadowRange') return Boolean(s.shadows);
    return false;
  }

  /* ------------------------------------------------------------ resolution */

  /**
   * Device pixels per CSS pixel the preset asks for, before the scaler has
   * its say. Supersampling targets are met by raising the scale until the
   * frame buffer is wide enough, which is what makes Ultra 4K on any panel.
   */
  /** The CSS size of the canvas, which is what a pixel ratio multiplies. */
  #cssSize() {
    return {
      width: this.canvas.clientWidth || window.innerWidth || 1280,
      height: this.canvas.clientHeight || window.innerHeight || 720,
    };
  }

  /** Device pixels per CSS pixel at the display's own resolution. */
  #nativeRatio() {
    return Math.min(devicePixelRatio || 1, this.settings.pixelRatio) * (this.settings.renderScale ?? 1);
  }

  /**
   * The most this preset may ever draw. Supersampling raises it toward the
   * `superSampleTo` width, and the megapixel budget caps it: a 4K monitor
   * asking for 1.25× would be 13 megapixels, and the buffers behind that do
   * not fit on a lot of hardware.
   */
  #ceilingRatio() {
    const s = this.settings;
    const native = this.#nativeRatio();
    const { width, height } = this.#cssSize();
    let ratio = native;
    if (s.superSampleTo) {
      ratio = Math.max(native, s.superSampleTo / Math.max(1, width));
      ratio = Math.min(ratio, native * (s.maxRenderScale ?? 2));
    }
    if (s.maxPixels) {
      ratio = Math.min(ratio, Math.sqrt(s.maxPixels / Math.max(1, width * height)));
    }
    return Math.max(0.1, ratio);
  }

  /** Pushes the current resolution decision into the renderer's buffers. */
  #applyResolution() {
    const native = this.#nativeRatio();
    const ceiling = this.#ceilingRatio();
    // The scaler works in multiples of the display's own resolution, so it
    // is allowed above 1 exactly as far as the ceiling permits.
    this.scaler?.setBounds(this.settings.minScale ?? 0.65, Math.max(1, ceiling / native));
    const wanted = this.scaler?.enabled === false ? ceiling : native * (this.scaler?.scale ?? 1);
    const ratio = clamp(wanted, 0.1, ceiling);
    if (Math.abs(ratio - this.renderer.getPixelRatio()) < 1e-3) return false;
    this.renderer.setPixelRatio(ratio);
    this.#applySharpening();
    return true;
  }

  /** How many pixels are actually being drawn, for the HUD to own up to. */
  get drawingBufferSize() {
    return this.renderer.getDrawingBufferSize(_size.clone());
  }

  /** Lets the player turn the trade of pixels for frame rate off. */
  setDynamicResolution(on) {
    this.scaler.setEnabled(on);
    if (!on) {
      this.scaler.scale = 1;
      if (this.#applyResolution()) this.resize();
    }
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
    this.hemi = new THREE.HemisphereLight(0x9fb6d4, 0x4a4238, 0.34);
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
    this.atmosphere?.setSun(dir, color);
  }

  /* ------------------------------------------------------------- post chain */

  #buildComposer() {
    const s = this.settings;
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      // Multisampling on the input buffer, for the tiers that have no SMAA
      // pass. On a phone this is the cheapest anti-aliasing available and on
      // a desktop it costs a blit; either way it is better than the jagged
      // barriers a bare render gives.
      multisampling: s.msaa ?? 0,
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (s.reflections) {
      // Reflections need to know which way each surface faces. This is a
      // second pass over the geometry with a normal-only material — no
      // textures, no shadows, no lighting — and it can run at half
      // resolution, which is plenty for a road.
      this.normalPass = new NormalPass(this.scene, this.camera);
      this.normalPass.resolution.scale = s.reflections.normalScale ?? 0.5;
      this.composer.addPass(this.normalPass);
    }

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
      // Additive, not the library's default of SCREEN.
      //
      // Screen is `1 - (1 - x)(1 - y)`, which is a statement about two values
      // between zero and one. This chain is HDR: the captured sun arrives at
      // seven thousand. Both terms go hugely negative, their product goes
      // hugely positive, and the result comes out at minus several million —
      // on all three channels at once. AgX then floors it, and the sun
      // renders as a black disc with a bright ring where the numbers were
      // still small enough to stay positive. Which is exactly what it did.
      //
      // Adding light to light is also just what a bloom is.
      blendFunction: BlendFunction.ADD,
      intensity: 0.62,
      luminanceThreshold: 0.78,
      luminanceSmoothing: 0.28,
      mipmapBlur: true,
      // A wider kernel is a longer mip chain, which on a phone is a handful
      // of extra full-screen passes for a glow nobody would pick out.
      kernelSize: s.bloomKernel === 'medium' ? KernelSize.MEDIUM : KernelSize.LARGE,
    });

    this.speedBlur = new SpeedBlurEffect();
    this.rainDrops = new RainDropsEffect();

    if (s.reflections) {
      this.reflections = new ReflectionsEffect(this.camera, s.reflections);
      this.reflections.normalBuffer = this.normalPass.texture;
    }

    if (s.atmosphere) this.atmosphere = new AtmosphereEffect(this.camera, s.atmosphere);

    this.chromatic = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.00022, 0.00022),
      radialModulation: true,
      modulationOffset: 0.4,
    });

    // Enough to frame the image, not enough to make a night race unreadable.
    this.vignette = new VignetteEffect({ offset: 0.35, darkness: 0.26 });

    // AgX trades saturation for highlight roll-off; a little of it back.
    this.saturation = new HueSaturationEffect({ saturation: 0.08 });

    // AgX holds highlights together far better than Reinhard on a scene lit
    // by a real HDRI, and keeps the sky from clipping to white.
    this.toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,
      resolution: 256,
      whitePoint: 14,
      middleGrey: 0.52,
    });

    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    this.grain.blendMode.opacity.value = 0.028;

    const effects = [];
    // Before anything else, a ceiling on the radiance. The captured sun is
    // hundreds of times the tone mapper's white point and that is what was
    // turning it into a black disc; see Highlights.js.
    this.highlights = new HighlightGuard(32);
    effects.push(this.highlights);
    // Reflections next: they are part of the image, so everything after —
    // the bloom, the blur, the drops on the glass — sees them.
    if (this.reflections) effects.push(this.reflections);
    // Haze sits on top of the scene and under everything the camera does to
    // it, so the bloom blooms the shafts and the drops on the glass refract
    // an already-hazy world.
    if (this.atmosphere) effects.push(this.atmosphere);
    if (s.motionBlur) effects.push(this.speedBlur);
    if (s.bloom) effects.push(this.bloom);
    effects.push(this.rainDrops, this.chromatic, this.vignette, this.saturation);
    // And again immediately before the tone mapper. The first guard cleans
    // what the scene handed over; this one cleans what the chain added to it,
    // and the bloom in particular — it builds its mip chain from the pass
    // input rather than from the accumulated colour, so it blooms the raw
    // captured sun (which is what you want it to do) and then adds the result
    // back on top (which puts the range right back out again). The tone
    // mapper is the one pass that must never see a number it cannot fit.
    effects.push(new HighlightGuard(32));
    effects.push(this.toneMapping, this.grain);
    this.composer.addPass(new EffectPass(this.camera, ...effects));

    if (s.smaa) {
      this.smaaPass = new EffectPass(this.camera, new SMAAEffect());
      this.composer.addPass(this.smaaPass);
    }

    // Last, and on its own, because it needs the finished image: see
    // Sharpen.js. Switched off entirely whenever the frame is being drawn at
    // the display's own resolution, where there is nothing to put back.
    this.sharpen = new SharpenEffect();
    this.sharpenPass = new EffectPass(this.camera, this.sharpen);
    this.composer.addPass(this.sharpenPass);
    this.#applySharpening();
  }

  /**
   * How hard to sharpen, from how far the frame is being stretched.
   *
   * The number that matters is drawn pixels against *screen* pixels, not
   * against the preset — on a 3× phone a preset capped at 2× is already being
   * stretched by half before the scaler has done anything at all, which is
   * most of why the same settings look so much softer on a handset than on a
   * monitor.
   */
  #applySharpening() {
    if (!this.sharpen) return;
    const stretch = (devicePixelRatio || 1) / Math.max(0.1, this.renderer.getPixelRatio());
    // Gentler than it was. Sharpening puts edges back, but it puts *every*
    // edge back, including the stair-stepped ones the low resolution created
    // — so past a point more of it does not read as sharper, it reads as
    // crunchy, which is the worst of both. Half the old slope and a much
    // lower ceiling.
    const strength = clamp((stretch - 1) * 0.34, 0, 0.5);
    this.sharpen.strength = strength;
    if (this.sharpenPass) this.sharpenPass.enabled = strength > 0.02;
  }

  /* ------------------------------------------------------------- the budget */

  /**
   * What to do when the resolution scaler has nothing left to sell.
   *
   * Trading pixels for frame rate is the right first move and the wrong only
   * move. Once the scale is on its floor and the frames are still late, every
   * further tenth of a second of lateness is paid for in blur that buys
   * nothing — which is exactly the state a phone lands in on a desktop preset,
   * and exactly what it looks like: soft *and* slow.
   *
   * So at the floor the renderer starts giving up features instead, in the
   * order of SHED, and takes them back when there is room. Hysteresis both
   * ways: two bad windows before anything goes, four good ones before
   * anything returns, because a preset that flickers between two looks is
   * worse than either of them.
   */
  #budget() {
    const s = this.scaler;
    if (!s.enabled) return;

    if (s.verdict < 0 && s.scale <= s.min + 1e-3) {
      this.slack = 0;
      if (++this.pressure >= 2 && this.detail > 0) {
        this.pressure = 0;
        this.#setDetail(this.detail - 1);
      }
    } else if (s.verdict > 0 && s.scale >= s.max - 1e-3) {
      this.pressure = 0;
      if (++this.slack >= 4 && this.detail < this.ladder.length) {
        this.slack = 0;
        this.#setDetail(this.detail + 1);
      }
    } else {
      this.pressure = 0;
      this.slack = 0;
    }
  }

  /** @param {number} detail how many rungs of SHED are still in hand */
  #setDetail(detail) {
    this.detail = clamp(detail, 0, this.ladder.length);
    const given = this.ladder.length - this.detail;
    this.shed = new Set(this.ladder.slice(0, given));

    // Everything here is a uniform or a pass switch, never a shader change:
    // the effects themselves already leave early when their strength is zero,
    // which is what makes turning one off free rather than a recompile.
    if (this.normalPass) this.normalPass.enabled = !this.shed.has('reflections');
    if (this.reflections && this.shed.has('reflections')) this.reflections.setStrength(0);
    if (this.ao) this.ao.enabled = !this.shed.has('ao');
    if (this.smaaPass) this.smaaPass.enabled = !this.shed.has('smaa');
    if (this.atmosphere) {
      this.atmosphere.uniforms.get('uShafts').value = this.shed.has('shafts') ? 0 : this.shaftStrength ?? 0.35;
    }
    if (this.speedBlur && this.shed.has('motionBlur')) this.speedBlur.strength = 0;
    if (this.csm) {
      // Not fewer cascades — that is a rebuild — but a shorter reach, so each
      // cascade's frustum holds less of the circuit and draws less of it.
      const far = this.settings.shadowDistance * (this.shed.has('shadowRange') ? 0.45 : 1);
      if (Math.abs(this.csm.maxFar - far) > 1) {
        this.csm.maxFar = far;
        this.csm.updateFrustums();
      }
    }
    console.warn(
      given
        ? `APEX: holding the frame rate by giving up ${[...this.shed].join(', ')}.`
        : 'APEX: full detail restored.',
    );
  }

  /**
   * What the renderer had to give up to hold the frame rate, for the HUD.
   *
   * A count, not a list. The list was six words long, it sat in the corner
   * panel, and it stretched that panel most of the way across the screen —
   * a diagnostic that made the thing it was diagnosing look worse.
   */
  get detailNote() {
    if (!this.shed.size) return null;
    return `detail −${this.shed.size}`;
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
    this.scene.environmentIntensity = 1.15;
    this.envMap = envMap;

    if (this.skybox) {
      this.scene.remove(this.skybox);
      this.skybox.geometry.dispose();
      this.skybox.material.dispose();
      this.skybox = null;
    }

    if (groundRadius > 0) {
      this.skybox = new GroundedSkybox(background, groundHeight, groundRadius, this.settings.skyResolution ?? 32);
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

  /**
   * Sets the haze. With the atmosphere pass the scene's own fog is switched
   * off: fogging twice, once per material and once in post, doubles it.
   *
   * @param {THREE.Color} color
   * @param {number} near  metres at which haze becomes visible
   * @param {number} far   metres at which it is nearly opaque
   * @param {object} [look] scatter, shafts and height, see AtmosphereEffect
   */
  setFog(color, near, far, look) {
    if (this.atmosphere) {
      this.scene.fog = null;
      this.atmosphere.setFog(color, near, far, look);
      // Remembered so the budget can put the shafts back exactly as the
      // weather asked for them rather than at some default.
      this.shaftStrength = this.atmosphere.uniforms.get('uShafts').value;
      if (this.shed.has('shafts')) this.atmosphere.uniforms.get('uShafts').value = 0;
    } else {
      this.scene.fog = new THREE.Fog(color, near, far);
    }
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.#applyResolution();
    this.scaler.reset();
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.ao?.setSize(w, h);
    this.csm?.updateFrustums();
    const size = this.renderer.getDrawingBufferSize(_size);
    this.rainOnLens?.resize(Math.max(1, size.x), Math.max(1, size.y));
  }

  /**
   * How mirror-like the world is, which is a property of the weather: a
   * soaked circuit reflects, dry tarmac scatters.
   *
   * @param {number} wetness 0 dry … 1 soaked
   */
  setReflectivity(wetness) {
    if (this.shed.has('reflections')) return;
    this.reflections?.setStrength(clamp(wetness, 0, 1));
  }

  /** How much rain is on the lens: 0 none, 1 rain, 2 storm. */
  setRainOnLens(rain) {
    this.rainOnLens.setRain(rain);
  }

  /** Airflow over the lens, which is what drives the drops sideways and off. */
  setRainFlow(speedKph) {
    this.rainOnLens.setFlow(speedKph);
  }

  /**
   * Sets the strength of the speed streak.
   * @param {number} speedKph
   */
  setSpeedBlur(speedKph, focus) {
    if (!this.settings.motionBlur || !this.speedBlur || this.shed.has('motionBlur')) return;
    this.speedBlur.strength = clamp((speedKph - 120) / 700, 0, 0.05);
    if (focus) this.speedBlur.centre.copy(focus);
  }

  render(dt) {
    if (this.contextLost) return;
    // Trade pixels for frame rate, or take them back when there is room.
    const windows = this.scaler.windows;
    if (this.scaler.frame(dt) !== null) {
      this.#applyResolution();
      this.#resizeBuffers();
    }
    // And when there are no pixels left to trade, trade something else.
    if (this.scaler.windows !== windows) this.#budget();
    this.csm?.update();
    this.rainOnLens.update(dt);
    if (this.composer) this.composer.render(dt);
    else if (this.rainOnLens.active) this.rainOverlay.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Re-sizes every buffer to the current pixel ratio, without touching the camera. */
  #resizeBuffers() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.ao?.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(_size);
    this.rainOnLens?.resize(Math.max(1, size.x), Math.max(1, size.y));
  }

  dispose() {
    this.csm?.dispose();
    this.composer?.dispose();
    this.rainOverlay?.dispose();
    this.renderer.dispose();
  }
}
