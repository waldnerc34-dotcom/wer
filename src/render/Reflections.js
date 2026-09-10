import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

/**
 * Screen-space ray-traced reflections.
 *
 * For every pixel the shader reconstructs where that surface is in view
 * space, reflects the eye ray off the surface normal, and then **marches the
 * reflected ray through the depth buffer** looking for the first place it
 * passes behind something. Where it finds one, the colour already drawn there
 * is the reflection. It is ray tracing, done against the depth buffer rather
 * than against the scene's triangles — which is what a browser can afford,
 * and what most console racing games shipped for a decade.
 *
 * What that buys, in this game specifically:
 *
 *  - A wet circuit reflects the cars, the barriers and the kerbs, moving
 *    correctly as you drive past. The cube map cannot do that: it only knows
 *    the sky, so a wet road under it looks like polished nothing.
 *  - Car paint picks up the road and the trackside at grazing angles.
 *  - Standing water in the tarmac's low spots reflects the world rather than
 *    just brightening.
 *
 * What it cannot do, honestly: reflect anything the camera cannot see. A ray
 * that marches off the edge of the screen, or behind something in the
 * foreground, has no colour to return — so those rays fade out and the
 * prefiltered environment map shows through, which is what the material
 * would have done on its own. Rays are also faded as they lengthen and as
 * they turn back toward the viewer, where the depth buffer is least
 * trustworthy.
 *
 * Cost is bounded by the step count, which the quality preset sets: the loop
 * is unrolled at compile time, so `steps` is a shader constant, not a
 * uniform.
 */
export class ReflectionsEffect extends Effect {
  /**
   * @param {THREE.Camera} camera
   * @param {object} [options]
   * @param {number} [options.steps]        ray-march samples per pixel
   * @param {number} [options.refinements]  binary-search steps taken after a hit
   * @param {number} [options.maxDistance]  how far a ray travels, metres
   * @param {number} [options.thickness]    how deep a surface is assumed to be, metres
   */
  constructor(camera, { steps = 24, refinements = 4, maxDistance = 90, thickness = 1.4 } = {}) {
    super('Reflections', FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      defines: new Map([
        ['REFLECTION_STEPS', String(Math.round(steps))],
        ['REFLECTION_REFINEMENTS', String(Math.round(refinements))],
      ]),
      uniforms: new Map([
        ['uNormalBuffer', new THREE.Uniform(null)],
        ['uProjection', new THREE.Uniform(new THREE.Matrix4())],
        ['uInverseProjection', new THREE.Uniform(new THREE.Matrix4())],
        ['uIntensity', new THREE.Uniform(0.55)],
        ['uRoughness', new THREE.Uniform(0.16)],
        ['uMaxDistance', new THREE.Uniform(maxDistance)],
        ['uThickness', new THREE.Uniform(thickness)],
        ['uFrame', new THREE.Uniform(0)],
      ]),
    });

    this.camera = camera;
  }

  /** The view-space normals, from a NormalPass. */
  set normalBuffer(texture) {
    this.uniforms.get('uNormalBuffer').value = texture;
  }

  /**
   * How much of the surface the reflection is allowed to replace, and how
   * scattered the rays are. A soaked road is a mirror; dry tarmac scatters
   * almost everything, so it gets a weak, blurred reflection.
   *
   * @param {number} strength 0 none … 1 a wet mirror
   */
  setStrength(strength) {
    // Dry tarmac scatters nearly everything, so it gets a weak, scattered
    // reflection; standing water is close to a mirror.
    this.uniforms.get('uIntensity').value = 0.14 + 0.76 * strength;
    this.uniforms.get('uRoughness').value = 0.17 - 0.14 * strength;
  }

  update() {
    this.uniforms.get('uProjection').value.copy(this.camera.projectionMatrix);
    this.uniforms.get('uInverseProjection').value.copy(this.camera.projectionMatrixInverse);
    this.uniforms.get('uFrame').value = (this.uniforms.get('uFrame').value + 1) % 1024;
  }
}

const FRAGMENT = /* glsl */ `
uniform sampler2D uNormalBuffer;
uniform mat4 uProjection;
uniform mat4 uInverseProjection;
uniform float uIntensity;
uniform float uRoughness;
uniform float uMaxDistance;
uniform float uThickness;
uniform float uFrame;

/** Where a pixel is, in view space. */
vec3 viewPositionOf(const in vec2 uv, const in float depth) {
  vec4 clip = vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  vec4 view = uInverseProjection * clip;
  return view.xyz / view.w;
}

vec2 projectToUv(const in vec3 viewPosition) {
  vec4 clip = uProjection * vec4(viewPosition, 1.0);
  return (clip.xy / clip.w) * 0.5 + 0.5;
}

float hash13(const in vec3 p3v) {
  vec3 p3 = fract(p3v * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (uIntensity <= 0.001 || depth >= 1.0) return;

  vec4 packed = texture2D(uNormalBuffer, uv);
  // The normal pass leaves the background at zero; nothing to reflect there.
  if (dot(packed.xyz, packed.xyz) < 0.01) return;
  vec3 normal = normalize(packed.xyz * 2.0 - 1.0);

  vec3 origin = viewPositionOf(uv, depth);
  vec3 eye = normalize(origin);

  // Scatter the ray by the surface's roughness. The offset is per pixel and
  // per frame, so what is left after the eye averages it is a soft
  // reflection rather than a grid of artefacts.
  vec3 jitter = vec3(
    hash13(vec3(uv * resolution, uFrame)),
    hash13(vec3(uv * resolution, uFrame + 41.0)),
    hash13(vec3(uv * resolution, uFrame + 87.0))
  ) - 0.5;
  vec3 direction = normalize(reflect(eye, normalize(normal + jitter * uRoughness)));

  // A ray coming back toward the eye is exactly where a depth buffer knows
  // least, so it is not worth marching.
  float towardEye = max(0.0, -dot(direction, eye));
  if (direction.z > 0.0 && towardEye > 0.75) return;

  // The march is geometric, not uniform. A uniform stride long enough to
  // reach across a circuit is metres wide at the first step, and a ray that
  // moves metres at a time steps clean over a car — which is exactly the
  // reflection worth having. Starting at 35 cm and growing 20% a step keeps
  // the near field precise and still reaches the far one inside the budget.
  const float FIRST_STRIDE = 0.35;
  const float GROWTH = 1.2;

  vec3 position = origin + direction * FIRST_STRIDE * 0.5;
  vec3 previous = position;

  bool hit = false;
  float travelled = 0.0;
  vec2 hitUv = vec2(0.0);

  for (int i = 0; i < REFLECTION_STEPS; i++) {
    float step = FIRST_STRIDE * pow(GROWTH, float(i));
    previous = position;
    position += direction * step;
    travelled += step;
    if (travelled > uMaxDistance) break;

    vec2 sampleUv = projectToUv(position);
    if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) break;

    float sceneZ = getViewZ(readDepth(sampleUv));
    // View z is negative ahead of the camera, so a ray that has gone past a
    // surface sits at a more negative z than the surface does. How far past
    // still counts as a hit has to grow with the step, or a long stride
    // reports a miss for a surface it plainly crossed.
    float behind = sceneZ - position.z;
    if (behind > 0.0 && behind < max(uThickness, step * 1.6)) {
      hit = true;
      hitUv = sampleUv;
      break;
    }
  }

  if (!hit) return;

  // Binary search between the last miss and the hit, so the reflection lands
  // where the surface is rather than a whole stride past it.
  vec3 lo = previous;
  vec3 hi = position;
  for (int i = 0; i < REFLECTION_REFINEMENTS; i++) {
    vec3 mid = (lo + hi) * 0.5;
    vec2 midUv = projectToUv(mid);
    float behind = getViewZ(readDepth(midUv)) - mid.z;
    if (behind > 0.0) hi = mid; else lo = mid;
    hitUv = midUv;
  }

  // Schlick, for a dielectric: a wet road is a mirror at a glance and glass
  // straight down.
  float cosTheta = clamp(-dot(eye, normal), 0.0, 1.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - cosTheta, 5.0);

  // Everything the depth buffer cannot vouch for is faded rather than faked.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.16), hitUv) * smoothstep(vec2(0.0), vec2(0.16), 1.0 - hitUv);
  float fade = edge.x * edge.y;
  fade *= 1.0 - smoothstep(0.55, 1.0, travelled / uMaxDistance);
  fade *= 1.0 - towardEye * 0.85;

  vec3 reflected = texture2D(inputBuffer, hitUv).rgb;
  float weight = clamp(fresnel * fade * uIntensity, 0.0, 0.82);
  outputColor = vec4(mix(inputColor.rgb, reflected, weight), inputColor.a);
}
`;
