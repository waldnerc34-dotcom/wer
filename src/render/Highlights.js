import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

/**
 * A ceiling on how bright a pixel may be before the camera looks at it.
 *
 * The sky is a real captured HDRI and the sun in it is a real measurement:
 * six and a half thousand units of radiance in a two-pixel disc. The tone
 * mapper's white point is fourteen. AgX handles a wide range and handles it
 * beautifully, but its curve is a polynomial fit over a bounded log range,
 * and four hundred and sixty times the white point is a long way outside the
 * interval that fit is good on. What comes back out is not white — it dips
 * negative, clamps to zero, and the sun renders as a **black disc with a
 * bright ring around it**. Which is exactly what it was doing.
 *
 * So the value is capped first. Anything above the limit is already as bright
 * as the screen can be and as bright as the bloom needs; nothing is lost
 * except the part of the number the tone mapper could not use anyway.
 *
 * It also mops up NaN. A single not-a-number pixel spreads through every
 * blur that touches it, and a bloom is nothing but blurs — one bad pixel in
 * the sun becomes a black smear across a quarter of the sky.
 */
export class HighlightGuard extends Effect {
  /** @param {number} [limit] the most radiance any pixel may carry */
  constructor(limit = 32) {
    super('HighlightGuard', FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([['uLimit', new THREE.Uniform(limit)]]),
    });
  }

  set limit(value) {
    this.uniforms.get('uLimit').value = value;
  }
}

const FRAGMENT = /* glsl */ `
uniform float uLimit;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 color = inputColor.rgb;
  // Not-a-number is the one value that never equals itself.
  color = mix(vec3(0.0), color, vec3(equal(color, color)));
  outputColor = vec4(clamp(color, vec3(0.0), vec3(uLimit)), inputColor.a);
}
`;
