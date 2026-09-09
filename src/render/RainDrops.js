import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

import { clamp, damp } from '../core/MathUtils.js';

/**
 * Rain on the lens.
 *
 * Drops bead up on the glass, sit there refracting whatever is behind them,
 * and every so often one gathers enough water to run, leaving a trail of
 * smaller beads down the screen. All of it is procedural and lives in the
 * fragment shader — a grid of cells for the beads that sit, a set of columns
 * for the ones that run — so it costs a handful of hashes per pixel and no
 * state at all. Each drop bends the finished frame through itself: the road
 * and the trees are what the drop shows, upside down and squeezed, which is
 * what makes it read as water rather than as a decal.
 *
 * The same shader serves two pipelines. With a post chain it is one effect
 * among the others, before tone mapping. Without one (the phone preset) the
 * scene is rendered to a texture only while it rains and the drops are drawn
 * over it in a second pass, tone-mapped there instead.
 */

const HASH = /* glsl */ `
  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  vec2 hash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
`;

/**
 * Drop field. Returns the refraction offset (xy, in aspect-corrected screen
 * units), the coverage (z) and the rim highlight (w).
 */
const DROPS = /* glsl */ `
  uniform float uTime;
  uniform float uAmount;
  uniform float uFlow;
  uniform vec2 uAspect;
  uniform vec2 uTexel;

  ${HASH}

  // Shading for a point inside a drop: the rim catches the light on the
  // side facing it and goes dark just inside the edge, where the water
  // bends the view right out of the lens.
  float shade(vec2 n, float r) {
    float bulge = sqrt(max(0.0, 1.0 - r * r));
    float lit = 0.35 + 0.65 * max(0.0, dot(normalize(n + 1e-5), vec2(-0.55, 0.83)));
    float rim = smoothstep(0.5, 0.95, r) * lit * bulge * 0.8;
    float dark = smoothstep(0.55, 0.97, r) * 0.5;
    return rim - dark;
  }

  // One sitting bead per cell, for a while: it grows in over a moment, sits,
  // and vanishes — blown off or run — before the cell grows another.
  // The density is the share of cells that hold a drop in the heaviest rain.
  vec4 beads(vec2 p, float scale, float amount, float density, float seed) {
    vec2 q = p * scale;
    vec2 cell = floor(q);
    vec4 best = vec4(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = cell + vec2(float(i), float(j));
        vec2 h = hash22(c + seed);
        // Each cell has a threshold of rain below which it stays dry, so
        // the glass fills up as it rains harder.
        if (hash21(c * 2.3 + seed + 11.0) > amount * density) continue;
        float size = hash21(c * 0.7 + seed + 3.0);
        float period = 5.0 + h.x * 7.0;
        float phase = fract(uTime / period + h.y);
        // In over a tenth of the cycle, gone over the last twentieth.
        float life = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(0.93, 0.98, phase));
        float radius = (0.13 + size * 0.24) * life;
        if (radius < 0.01) continue;
        // Inset so the bead stays inside its cell's reach; a little taller
        // than wide, as a drop hanging on glass is.
        vec2 centre = c + 0.5 + (h - 0.5) * 0.5;
        vec2 d = q - centre;
        d.y /= 1.0 + 0.4 * fract(size * 7.0);
        float r = length(d) / radius;
        if (r >= 1.0) continue;
        vec2 n = d / radius;
        // Lens: strongest bend near the rim, inverted in the middle.
        vec2 offset = -n * (0.55 + 0.45 * r) * radius / scale * 2.4;
        float cover = smoothstep(1.0, 0.9, r);
        if (cover > best.z) best = vec4(offset, cover, shade(n, r));
      }
    }
    return best;
  }

  // Columns of running drops: a head sliding down at its own pace, with a
  // trail of beads left where it has been.
  vec4 trails(vec2 p, float scale, float amount, float seed) {
    float colW = 1.0 / scale;
    float col = floor(p.x * scale);
    vec4 best = vec4(0.0);
    for (int i = -1; i <= 1; i++) {
      float c = col + float(i);
      float h = hash11(c * 3.1 + seed);
      float h2 = hash11(c * 7.7 + seed + 4.0);
      if (h > amount * 0.85) continue;
      // Where the head is now: it runs the height of the screen in a few
      // seconds, faster as the air over the glass picks up.
      float speed = (0.18 + h2 * 0.25) * (1.0 + uFlow * 2.2);
      float cycle = uTime * speed + h * 9.0;
      float head = 1.15 - fract(cycle) * 1.45;
      float run = floor(cycle);
      float x = (c + 0.5) * colW + (hash11(run + c * 0.37) - 0.5) * colW * 0.6;
      // The path wanders a little on its way down.
      float wander = sin(p.y * 31.0 + h * 40.0) * colW * 0.12 + sin(p.y * 11.0 + h2 * 20.0) * colW * 0.18;
      float dx = p.x - x - wander;
      float dy = p.y - head;
      float headR = colW * (0.26 + h2 * 0.12);
      // The head: a bead, stretched along the run.
      vec2 d = vec2(dx, dy * 0.7) / headR;
      float r = length(d);
      if (r < 1.0) {
        vec2 offset = -d * (0.55 + 0.45 * r) * headR * 2.4;
        float cover = smoothstep(1.0, 0.9, r);
        if (cover > best.z) best = vec4(offset, cover, shade(d, r));
      }
      // The trail above it: thin, broken into beads, fading with distance.
      if (dy > 0.0 && dy < 0.7) {
        float w = headR * 0.4;
        float across = abs(dx) / w;
        float bead = step(0.25, hash11(floor(p.y * 70.0 + h * 50.0) + c * 13.0));
        float fade = 1.0 - smoothstep(0.1, 0.7, dy);
        if (across < 1.0 && bead > 0.5) {
          vec2 n = vec2(dx / w, 0.0);
          vec2 offset = -n * w * 1.8;
          float cover = smoothstep(1.0, 0.75, across) * fade * 0.9;
          if (cover > best.z) best = vec4(offset, cover, shade(n, across) * fade);
        }
      }
    }
    return best;
  }

  vec4 rainDrops(sampler2D buf, vec4 inputColor, vec2 uv) {
    if (uAmount < 0.002) return inputColor;
    vec2 p = uv * uAspect;
    // Fewer drops sit still once the air over the glass picks up.
    float sitting = uAmount * (1.0 - 0.45 * uFlow);
    vec4 a = beads(p, 9.0, sitting, 0.3, 0.0);
    vec4 b = beads(p + vec2(0.37, 0.21), 17.0, sitting, 0.17, 5.0);
    vec4 c = trails(p, 7.0, uAmount, 2.0);
    vec4 drop = a;
    if (b.z > drop.z) drop = b;
    if (c.z > drop.z) drop = c;
    if (drop.z < 0.002) return inputColor;

    vec2 uv2 = uv + drop.xy / uAspect;
    // What the drop shows is the frame behind it, bent and a touch soft.
    vec3 seen = texture2D(buf, uv2).rgb * 0.5
      + texture2D(buf, uv2 + uTexel * vec2(2.5, 0.0)).rgb * 0.25
      + texture2D(buf, uv2 - uTexel * vec2(0.0, 2.5)).rgb * 0.25;
    // Water darkens what it covers a little, goes darker still just inside
    // its edge, and catches the light on the rim.
    seen *= 0.9 + drop.w;
    seen += max(drop.w, 0.0) * 0.2;
    return vec4(mix(inputColor.rgb, seen, drop.z), inputColor.a);
  }
`;

function makeUniforms() {
  return {
    uTime: new THREE.Uniform(0),
    uAmount: new THREE.Uniform(0),
    uFlow: new THREE.Uniform(0),
    uAspect: new THREE.Uniform(new THREE.Vector2(16 / 9, 1)),
    uTexel: new THREE.Uniform(new THREE.Vector2(1 / 1920, 1 / 1080)),
  };
}

/** The drops as a `postprocessing` effect, for the composer pipeline. */
export class RainDropsEffect extends Effect {
  constructor() {
    const uniforms = makeUniforms();
    super(
      'RainDrops',
      /* glsl */ `
      ${DROPS}
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        outputColor = rainDrops(inputBuffer, inputColor, uv);
      }
      `,
      {
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map(Object.entries(uniforms)),
      },
    );
    this.u = uniforms;
  }
}

/**
 * The drops without a composer: the scene goes to a texture, the drops are
 * drawn over it to the screen, and the main pass's tone mapping and colour
 * space conversion happen here instead.
 */
export class RainDropsOverlay {
  constructor(renderer) {
    this.renderer = renderer;
    this.u = makeUniforms();
    this.target = null;

    this.material = new THREE.ShaderMaterial({
      uniforms: { ...this.u, inputBuffer: new THREE.Uniform(null) },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D inputBuffer;
        varying vec2 vUv;
        ${DROPS}
        void main() {
          vec4 scene = texture2D(inputBuffer, vUv);
          gl_FragColor = rainDrops(inputBuffer, scene, vUv);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    // One triangle that covers the screen.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  #ensureTarget() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.target && this.target.width === size.x && this.target.height === size.y) return;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.material.uniforms.inputBuffer.value = this.target.texture;
  }

  render(scene, camera) {
    this.#ensureTarget();
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);
  }

  dispose() {
    this.target?.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/** Drives either implementation: how much rain is on the glass, and how fast the air moves over it. */
export class RainOnLens {
  constructor(effectOrOverlay) {
    this.impl = effectOrOverlay;
    this.target = 0;
    this.amount = 0;
    this.flow = 0;
  }

  /** @param {number} rain 0 none, 1 rain, 2 storm */
  setRain(rain) {
    this.target = rain <= 0 ? 0 : rain >= 2 ? 1 : 0.62;
  }

  /** Airflow over the glass, from the car's speed. */
  setFlow(speedKph) {
    this.flow = clamp((speedKph - 20) / 160, 0, 1);
  }

  get active() {
    return this.amount > 0.002;
  }

  update(dt) {
    // Drops gather over a few seconds when it starts, and take longer to
    // clear when it stops — and clear faster when the car is moving.
    const rate = this.target > this.amount ? 0.35 : 0.12 + this.flow * 0.3;
    this.amount = damp(this.amount, this.target, rate, dt);
    if (Math.abs(this.amount - this.target) < 0.003) this.amount = this.target;
    const u = this.impl.u;
    u.uTime.value += dt * (0.6 + this.flow * 0.8);
    u.uAmount.value = this.amount;
    u.uFlow.value = this.flow;
  }

  resize(width, height) {
    const u = this.impl.u;
    u.uAspect.value.set(width / height, 1);
    u.uTexel.value.set(1 / width, 1 / height);
  }
}
