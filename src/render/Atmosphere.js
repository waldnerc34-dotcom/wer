import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const _sun = new THREE.Vector3();
const _forward = new THREE.Vector3();

/**
 * Air, and what the sun does to it.
 *
 * Three things that a linear `THREE.Fog` cannot do, all of them from the
 * depth buffer this pass already has:
 *
 *  - **Height fog.** Haze is not a uniform slab; it pools in the valley and
 *    thins as you climb. The shader integrates an exponential density along
 *    the view ray analytically — one closed form, no marching — so Col de
 *    l'Aigle's descent runs down into the murk and the col above it is
 *    clear, and a crest genuinely reveals the circuit.
 *
 *  - **In-scattering.** Haze is not one colour. Looking toward the sun,
 *    light scatters forward off the water in the air and the fog takes the
 *    sun's colour; looking away, it stays the cold colour of the sky. A
 *    Henyey-Greenstein phase function decides the mix, which is what makes
 *    driving into a low sun feel like driving into a low sun.
 *
 *  - **Light shafts.** Where the sun is on screen, the pass walks a line of
 *    samples from each pixel toward it, counting how much of that line is
 *    open sky rather than a tree, a gantry or a car. The result is the
 *    shafts you see streaming past a silhouette — god rays, from the depth
 *    buffer, with no second render of the scene.
 *
 * All of it is masked off the sky itself: the sky is already the colour the
 * sky should be, and fogging it would paint a flat lid over the circuit.
 */
export class AtmosphereEffect extends Effect {
  /**
   * @param {THREE.Camera} camera
   * @param {object} [options]
   * @param {number} [options.samples] taps along each shaft
   */
  constructor(camera, { samples = 20 } = {}) {
    super('Atmosphere', FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      defines: new Map([['SHAFT_SAMPLES', String(Math.round(samples))]]),
      uniforms: new Map([
        ['uInverseProjection', new THREE.Uniform(new THREE.Matrix4())],
        ['uInverseView', new THREE.Uniform(new THREE.Matrix4())],
        ['uFogColor', new THREE.Uniform(new THREE.Color(0xa8bacd))],
        ['uSunColor', new THREE.Uniform(new THREE.Color(0xfff2e0))],
        ['uSunDirection', new THREE.Uniform(new THREE.Vector3(0, -1, 0))],
        ['uSunScreen', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['uSunVisible', new THREE.Uniform(0)],
        ['uFogStart', new THREE.Uniform(200)],
        ['uDensity', new THREE.Uniform(0.0012)],
        ['uHeightFalloff', new THREE.Uniform(0.012)],
        ['uScatter', new THREE.Uniform(0.6)],
        ['uShafts', new THREE.Uniform(0.35)],
      ]),
    });

    this.camera = camera;
    this.sunDirection = new THREE.Vector3(0, -1, 0);
  }

  /**
   * Sets the haze from a weather preset. `near`/`far` are the old linear fog
   * bounds, kept as the way a preset is written: the density that matches
   * them is the one that leaves the far distance about nine tenths hazed.
   *
   * @param {THREE.Color} color
   * @param {number} near metres at which haze becomes visible
   * @param {number} far  metres at which it is nearly opaque
   * @param {object} [look]
   * @param {number} [look.scatter]  how much the sun colours the haze
   * @param {number} [look.shafts]   strength of the light shafts
   * @param {number} [look.height]   metres over which density halves with altitude
   */
  setFog(color, near, far, { scatter = 0.6, shafts = 0.35, height = 60 } = {}) {
    this.uniforms.get('uFogColor').value.copy(color);
    // The presets are written as a pair of distances, so honour both: haze
    // begins at `near` and is nine tenths of the way to opaque by `far`.
    // Reading only `far` made a clear day look like a foggy one, because the
    // first 600 m of a 3.4 km preset are meant to be clear air.
    this.uniforms.get('uFogStart').value = near;
    this.uniforms.get('uDensity').value = 2.3 / Math.max(1, far - near);
    this.uniforms.get('uHeightFalloff').value = Math.LN2 / Math.max(1, height);
    this.uniforms.get('uScatter').value = scatter;
    this.uniforms.get('uShafts').value = shafts;
  }

  /** @param {THREE.Vector3} direction the way the sunlight travels */
  setSun(direction, color) {
    this.sunDirection.copy(direction).normalize();
    this.uniforms.get('uSunDirection').value.copy(this.sunDirection);
    if (color) this.uniforms.get('uSunColor').value.set(color);
  }

  update() {
    const camera = this.camera;
    this.uniforms.get('uInverseProjection').value.copy(camera.projectionMatrixInverse);
    this.uniforms.get('uInverseView').value.copy(camera.matrixWorld);

    // Where the sun is on screen, and whether it is on screen at all. A
    // point projected from behind the camera comes back mirrored, so the
    // facing test has to happen in world space, before the projection.
    _sun.copy(this.sunDirection).multiplyScalar(-1);
    camera.getWorldDirection(_forward);
    const facing = _forward.dot(_sun);
    if (facing <= 0.05) {
      this.uniforms.get('uSunVisible').value = 0;
      return;
    }

    _sun.multiplyScalar(50000).add(camera.position).project(camera);
    const x = _sun.x * 0.5 + 0.5;
    const y = _sun.y * 0.5 + 0.5;
    this.uniforms.get('uSunScreen').value.set(x, y);

    // Fade the shafts as the sun leaves the frame, rather than letting them
    // snap off at the edge.
    const outside = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)) * 2;
    const onScreen = 1 - Math.min(1, Math.max(0, (outside - 1) / 0.8));
    this.uniforms.get('uSunVisible').value = Math.min(1, facing * 3) * onScreen;
  }
}

const FRAGMENT = /* glsl */ `
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform vec3 uFogColor;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;
uniform vec2 uSunScreen;
uniform float uSunVisible;
uniform float uFogStart;
uniform float uDensity;
uniform float uHeightFalloff;
uniform float uScatter;
uniform float uShafts;

/** Distance from the camera, in metres, for any pixel. */
float distanceAt(const in vec2 uv, const in float depth) {
  vec4 clip = vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  vec4 view = uInverseProjection * clip;
  return length(view.xyz / view.w);
}

/** How much of a pixel is sky rather than something on the circuit. */
float skyMask(const in float dist) {
  return smoothstep(1500.0, 2200.0, dist);
}

/**
 * Henyey-Greenstein: the shape of forward scattering. g toward 1 concentrates
 * the glow tightly around the sun, g at 0 spreads it over the whole sky.
 */
float phase(const in float cosAngle, const in float g) {
  float gg = g * g;
  return (1.0 - gg) / pow(1.0 + gg - 2.0 * g * cosAngle, 1.5);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 clip = vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  vec4 viewPosition = uInverseProjection * clip;
  vec3 viewPoint = viewPosition.xyz / viewPosition.w;

  vec3 worldPoint = (uInverseView * vec4(viewPoint, 1.0)).xyz;
  vec3 cameraPosition = uInverseView[3].xyz;
  vec3 ray = worldPoint - cameraPosition;
  float dist = length(ray);
  vec3 direction = ray / max(dist, 1e-4);
  // Clear air out to where the preset says the haze starts.
  float hazed = max(0.0, dist - uFogStart);

  float sky = skyMask(dist);
  vec3 color = inputColor.rgb;

  /* -- height fog ------------------------------------------------------- */
  // The integral of an exponentially thinning atmosphere along the ray,
  // in closed form. As the ray flattens the vertical term goes singular, so
  // the flat case is the limit rather than the formula.
  float b = uHeightFalloff;
  float atCamera = uDensity * exp(-b * cameraPosition.y);
  float rise = b * direction.y * hazed;
  float amount = abs(rise) < 0.0001
    ? atCamera * hazed
    : atCamera * (1.0 - exp(-rise)) / (b * direction.y);
  // The sky is already the right colour; hazing it paints a lid on the world.
  float fog = (1.0 - exp(-max(amount, 0.0))) * (1.0 - sky);

  /* -- in-scattering ---------------------------------------------------- */
  // Toward the sun the haze takes the sun's colour, away from it the sky's.
  float cosSun = dot(direction, -uSunDirection);
  float forward = phase(clamp(cosSun, -1.0, 1.0), 0.72);
  // Enough that the haze warms toward the sun, not so much that the frame
  // turns to milk: the phase function peaks in the twenties, so the weight
  // that multiplies it has to be small.
  vec3 hazeColor = mix(uFogColor, uSunColor, clamp(uScatter * forward * 0.05, 0.0, 0.45));
  color = mix(color, hazeColor, clamp(fog, 0.0, 1.0));

  /* -- light shafts ----------------------------------------------------- */
  if (uSunVisible > 0.001 && uShafts > 0.001) {
    vec2 delta = (uSunScreen - uv) / float(SHAFT_SAMPLES) * 0.85;
    vec2 walk = uv;
    float decay = 1.0;
    float shaft = 0.0;
    for (int i = 0; i < SHAFT_SAMPLES; i++) {
      walk += delta;
      float d = distanceAt(clamp(walk, 0.0, 1.0), readDepth(clamp(walk, 0.0, 1.0)));
      shaft += skyMask(d) * decay;
      // Each step contributes less, which is what turns a straight line of
      // samples into a beam that fades away from its source.
      decay *= 0.96;
    }
    shaft /= float(SHAFT_SAMPLES);
    // Confine the glow to a halo around the sun, in screen space. Weighting
    // by the world angle instead is not selective enough: across a 40° frame
    // the angle to the sun barely changes, so every pixel got the same lift
    // and the whole image turned to milk.
    vec2 toSun = (uSunScreen - uv) * vec2(aspect, 1.0);
    float radial = 1.0 - smoothstep(0.04, 0.5, length(toSun));
    color += uSunColor * shaft * radial * uShafts * uSunVisible * 0.55;
  }

  outputColor = vec4(color, inputColor.a);
}
`;
