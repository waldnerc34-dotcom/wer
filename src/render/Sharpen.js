import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

/**
 * Contrast-adaptive sharpening, for the pixels that were never drawn.
 *
 * Dynamic resolution buys frame rate by drawing fewer pixels and letting the
 * display stretch them, and on a phone that stretch is much larger than the
 * numbers suggest. A modern handset is a 3× screen; a preset that caps at 2×
 * is already being upscaled by half before anything adapts, and a scaler that
 * then drops to two thirds of that is showing one drawn pixel for every five
 * on the glass. The frame rate holds and the picture turns to soup — which is
 * the complaint, and it is a fair one.
 *
 * So the last thing the chain does is put the edges back. Every game that
 * ships dynamic resolution ships this pass with it; leaving it out is what
 * makes the trade look like a downgrade rather than a trade.
 *
 * It is AMD's CAS, in its five-tap form. The important part is the *adaptive*:
 * a plain unsharp mask sharpens hardest exactly where a pixel is already at
 * the top or bottom of its neighbourhood's range, which is where sharpening
 * produces the white halo that reads as a cheap filter. Here the strength is
 * derived per pixel from how much headroom the neighbourhood has left, so a
 * blown-out sky and a black tyre get almost none and the kerb between them
 * gets all of it.
 *
 * Five texture reads, no history, no jitter, one pass. It has to *be* its own
 * pass: an effect merged into the chain reads the pass input rather than the
 * accumulated colour, so it would sharpen a neighbourhood taken from before
 * tone mapping while the centre pixel came from after it.
 */
export class SharpenEffect extends Effect {
  constructor() {
    super('Sharpen', FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([['uSharpness', new THREE.Uniform(0)]]),
    });
  }

  /**
   * How much of the pass to apply.
   *
   * @param {number} strength 0 none … 1 as much as CAS will give without ringing
   */
  set strength(strength) {
    this.uniforms.get('uSharpness').value = Math.max(0, Math.min(1, strength));
  }

  get strength() {
    return this.uniforms.get('uSharpness').value;
  }
}

const FRAGMENT = /* glsl */ `
uniform float uSharpness;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uSharpness < 0.001) { outputColor = inputColor; return; }

  vec2 px = 1.0 / resolution;
  vec3 e = inputColor.rgb;
  vec3 n = texture2D(inputBuffer, uv + vec2(0.0, px.y)).rgb;
  vec3 w = texture2D(inputBuffer, uv - vec2(px.x, 0.0)).rgb;
  vec3 s = texture2D(inputBuffer, uv - vec2(0.0, px.y)).rgb;
  vec3 e2 = texture2D(inputBuffer, uv + vec2(px.x, 0.0)).rgb;

  vec3 lo = min(min(n, w), min(s, e2));
  vec3 hi = max(max(n, w), max(s, e2));
  lo = min(lo, e);
  hi = max(hi, e);

  // The headroom this neighbourhood has in both directions. Near zero where
  // the pixel is already at an extreme, which is precisely where an unsharp
  // mask would put a halo.
  vec3 amount = sqrt(clamp(min(lo, vec3(1.0) - hi) / max(hi, vec3(1e-4)), 0.0, 1.0));

  // CAS's peak: the weight stays above -0.2 so the denominator cannot go to
  // zero and the filter cannot invert.
  vec3 k = -amount * (uSharpness * 0.2);
  vec3 result = ((n + w + s + e2) * k + e) / (1.0 + 4.0 * k);

  outputColor = vec4(clamp(result, 0.0, 1.0), inputColor.a);
}
`;
