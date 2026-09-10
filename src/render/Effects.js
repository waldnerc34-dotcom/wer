import * as THREE from 'three';

import { clamp, lerp, makeRandom } from '../core/MathUtils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _org = new THREE.Vector3();
const _inv = new THREE.Quaternion();

/**
 * Tyre smoke and dust.
 *
 * A fixed pool of camera-facing quads drawn as one instanced mesh. Particles
 * are recycled oldest-first, so the system never allocates during a session
 * and its cost is constant regardless of how hard the car is being driven.
 */
export class ParticleSystem {
  /**
   * Lift and drag set the system's defaults; every particle may override
   * them, because one emitter has to carry things with very different
   * ballistics — a chip of gravel and the dust it kicks up leave the same
   * contact patch in the same millisecond and must not fly together.
   *
   * @param {THREE.Texture} texture
   * @param {object} opts   count; additive (sparks, glows); lift — vertical
   *                        acceleration, positive for smoke that rises,
   *                        negative for things that fall; drag per second
   */
  constructor(texture, { count = 600, additive = false, lift = 0.62, drag = 2.1 } = {}) {
    this.count = count;
    this.lift = lift;
    this.drag = drag;
    this.geometry = new THREE.PlaneGeometry(1, 1);

    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: !additive,
      side: THREE.DoubleSide,
    });

    // Instances carry a per-particle opacity of their own.
    //
    // An instance can only be given a colour, and fading a particle by pulling
    // that colour down to zero does not make it disappear: under normal
    // blending the texture supplies the alpha, so the quad stays exactly as
    // solid as it was and simply turns black. Every puff of smoke, dust and
    // spray was therefore born as a black blob, brightened to its own colour
    // partway through its life, and blackened again as it died. The fade
    // belongs in the alpha channel, so it goes in as an instanced attribute
    // and the instance colour is left to carry the colour.
    this.alphas = new Float32Array(count);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphas, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iAlpha', this.alphaAttr);
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float iAlpha;\nvarying float vAlpha;\nvarying vec2 vPuff;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = iAlpha;\nvPuff = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAlpha;\nvarying vec2 vPuff;')
        // The radial term guarantees the quad's own edge never shows, however
        // far the particle is stretched along its motion.
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\ndiffuseColor.a *= vAlpha * smoothstep(0.5, 0.3, length(vPuff - 0.5));',
        );
    };
    this.material.customProgramCacheKey = () => 'particle';

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.mesh.frustumCulled = false;
    // The mesh sits at the world origin however far away its particles are,
    // so the transparent pass cannot sort it against the sea or the rain by
    // distance. Draw it last instead.
    this.mesh.renderOrder = 3;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.name = 'particles';

    this.colors = new Float32Array(count * 3).fill(1);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this.position = new Float32Array(count * 3);
    this.velocity = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size = new Float32Array(count);
    this.growth = new Float32Array(count);
    this.spin = new Float32Array(count);
    this.liftPer = new Float32Array(count);
    this.dragPer = new Float32Array(count);
    this.stretch = new Float32Array(count);
    this.fadeIn = new Float32Array(count);
    this.opacity = new Float32Array(count);
    // The height the particle came off, so it can settle on that surface
    // instead of sinking through it.
    this.floor = new Float32Array(count);

    // A slot that has been parked off screen stays parked: without this the
    // system rewrites every dead instance's matrix on every frame, which on
    // a dry lap is a thousand matrices a frame to draw nothing.
    this.parked = new Uint8Array(count).fill(1);
    this.aliveCount = 0;
    this.cursor = 0;
    this.dummy = new THREE.Object3D();
    this.rand = makeRandom(991);
  }

  /**
   * @param {THREE.Vector3} origin
   * @param {object} opts
   */
  emit(origin, {
    velocity = _v.set(0, 0, 0),
    life = 1.4,
    size = 0.6,
    growth = 2.4,
    color = [0.72, 0.72, 0.74],
    spread = 0.4,
    jitter = 1.4,
    lift = this.lift,
    drag = this.drag,
    stretch = 0,
    fadeIn = 6,
    opacity = 1,
    floor = -Infinity,
  } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.parked[i] = 0;
    this.settled = false;

    const r = this.rand;
    this.position[i * 3] = origin.x + (r() - 0.5) * spread;
    this.position[i * 3 + 1] = origin.y + r() * spread * 0.5;
    this.position[i * 3 + 2] = origin.z + (r() - 0.5) * spread;

    // Scatter is symmetric: a blanket upward bias here would lift every
    // plume off the ground no matter what the caller asked for, which is
    // what made spray and dust float away instead of falling back.
    this.velocity[i * 3] = velocity.x + (r() - 0.5) * jitter;
    this.velocity[i * 3 + 1] = velocity.y + (r() - 0.5) * jitter * 0.75;
    this.velocity[i * 3 + 2] = velocity.z + (r() - 0.5) * jitter;

    this.life[i] = life * (0.7 + r() * 0.6);
    this.maxLife[i] = this.life[i];
    this.size[i] = size * (0.7 + r() * 0.7);
    this.growth[i] = growth;
    this.spin[i] = (r() - 0.5) * 1.6;
    this.liftPer[i] = lift;
    // Spread the drag around the requested value. Identical drag makes a
    // plume decelerate in lockstep and read as one rigid object; a little
    // variance is what lets the head of it pull away from the tail.
    this.dragPer[i] = drag * (0.78 + r() * 0.44);
    this.stretch[i] = stretch;
    this.fadeIn[i] = fadeIn;
    this.opacity[i] = opacity;
    this.floor[i] = floor;
    // The colour is just the colour and never changes again; the fade rides
    // in the alpha attribute instead.
    this.colors[i * 3] = color[0];
    this.colors[i * 3 + 1] = color[1];
    this.colors[i * 3 + 2] = color[2];
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt, camera) {
    // Nothing alive and nothing left to tidy: the whole system costs one
    // comparison, and the mesh is not drawn at all.
    if (this.aliveCount === 0 && this.settled) {
      this.mesh.visible = false;
      return;
    }

    const d = this.dummy;
    const camInv = _inv.copy(camera.quaternion).invert();
    const settleK = Math.exp(-2.4 * dt);
    let alive = 0;

    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        if (this.parked[i]) continue;
        d.position.set(0, -9999, 0);
        d.scale.setScalar(0.0001);
        d.updateMatrix();
        this.mesh.setMatrixAt(i, d.matrix);
        this.alphas[i] = 0;
        this.parked[i] = 1;
        continue;
      }

      this.life[i] -= dt;
      // Age must stay in [0, 1]: a particle whose life goes negative inside
      // this step would otherwise raise a negative base to a fractional power
      // below, and the resulting NaN travels through the instance colour
      // buffer into the HDR target, where bloom spreads it over the whole
      // frame and the screen goes black.
      const t = clamp(1 - this.life[i] / this.maxLife[i], 0, 1); // 0 new … 1 gone

      // Air drag bleeds off the speed the particle was thrown with; lift is
      // whatever is left over of buoyancy and weight. Smoke rises, mist
      // hangs and sinks, grit falls like a stone.
      const dragK = Math.exp(-this.dragPer[i] * dt);
      this.velocity[i * 3] *= dragK;
      this.velocity[i * 3 + 2] *= dragK;
      this.velocity[i * 3 + 1] = this.velocity[i * 3 + 1] * dragK + this.liftPer[i] * dt;

      this.position[i * 3] += this.velocity[i * 3] * dt;
      this.position[i * 3 + 1] += this.velocity[i * 3 + 1] * dt;
      this.position[i * 3 + 2] += this.velocity[i * 3 + 2] * dt;

      // What falls back to the surface it came off settles on it and creeps
      // outward, rather than sinking through the road.
      if (this.position[i * 3 + 1] < this.floor[i]) {
        this.position[i * 3 + 1] = this.floor[i];
        this.velocity[i * 3 + 1] = 0;
        this.velocity[i * 3] *= settleK;
        this.velocity[i * 3 + 2] *= settleK;
      }

      const scale = this.size[i] * (1 + t * this.growth[i]);
      d.position.set(this.position[i * 3], this.position[i * 3 + 1], this.position[i * 3 + 2]);
      d.quaternion.copy(camera.quaternion);

      // Fast particles are smeared along the direction they are travelling.
      // A droplet leaving a tyre at 40 m/s is a streak, not a ball, and it
      // rounds off as the air slows it down.
      const st = this.stretch[i];
      let done = false;
      if (st > 0) {
        _dir.set(this.velocity[i * 3], this.velocity[i * 3 + 1], this.velocity[i * 3 + 2])
          .applyQuaternion(camInv); // camera space, so the smear lands on screen
        // Only the part of the motion that crosses the screen smears. A
        // droplet flying straight at the camera is a dot, not a streak.
        const across = Math.hypot(_dir.x, _dir.y);
        if (across > 0.8) {
          d.rotateZ(Math.atan2(_dir.y, _dir.x));
          d.scale.set(scale * (1 + Math.min(across * st, 3.2) * (1 - t)), scale, scale);
          done = true;
        }
      }
      if (!done) {
        d.rotateZ(this.spin[i] * t * 3);
        d.scale.setScalar(scale);
      }
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);

      // Fade in, then out slowly. Smoke has to build; water and stones are
      // simply there the instant they leave the tyre, and easing them in over
      // a fifth of a second leaves a bald patch at the contact patch where
      // the spray should be densest.
      this.alphas[i] = Math.min(t * this.fadeIn[i], 1) * (1 - t) ** 1.4 * this.opacity[i];
      alive++;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.mesh.visible = alive > 0;
    // One more pass is owed after the last particle dies, to park it.
    this.settled = alive === 0 && this.aliveCount === 0;
    this.aliveCount = alive;
  }
}

/**
 * Rubber laid down on the road.
 *
 * Marks are written into one long pre-allocated ribbon per tyre. When the
 * buffer wraps it simply overwrites the oldest marks, which keeps memory flat
 * during a long stint.
 */
export class SkidMarks {
  constructor(texture, { segments = 900 } = {}) {
    this.segments = segments;
    this.vertsPerSegment = 2;
    const vertexCount = segments * this.vertsPerSegment;

    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(vertexCount * 3);
    this.uvs = new Float32Array(vertexCount * 2);
    this.opacity = new Float32Array(vertexCount);

    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    geometry.setAttribute('aOpacity', new THREE.BufferAttribute(this.opacity, 1));

    const indices = new Uint32Array((segments - 1) * 6);
    for (let i = 0; i < segments - 1; i++) {
      const a = i * 2;
      indices.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], i * 6);
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);

    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      toneMapped: false,
      color: 0x0d0d0e,
    });
    // Per-vertex fade so old marks disappear rather than popping.
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOpacity;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOpacity = aOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vOpacity;')
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\ndiffuseColor.a *= vOpacity;',
        );
    };
    this.material.customProgramCacheKey = () => 'skid';

    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skid-marks';

    this.head = 0;
    this.used = 0;
    this.lastPoint = null;
    this.distance = 0;
  }

  /**
   * Extends the ribbon.
   *
   * @param {THREE.Vector3} point contact patch position
   * @param {THREE.Vector3} across lateral direction of the tyre
   * @param {THREE.Vector3} normal surface normal
   * @param {number} intensity 0..1
   * @param {number} width tyre width, metres
   */
  add(point, across, normal, intensity, width = 0.3) {
    if (intensity <= 0.02) {
      this.lastPoint = null;
      return;
    }
    if (this.lastPoint && point.distanceTo(this.lastPoint) < 0.22) return;

    const i = this.head;
    const base = i * 2;

    _v.copy(point).addScaledVector(normal, 0.014);
    _v2.copy(across).multiplyScalar(width * 0.5);

    this.positions[base * 3] = _v.x - _v2.x;
    this.positions[base * 3 + 1] = _v.y - _v2.y;
    this.positions[base * 3 + 2] = _v.z - _v2.z;
    this.positions[(base + 1) * 3] = _v.x + _v2.x;
    this.positions[(base + 1) * 3 + 1] = _v.y + _v2.y;
    this.positions[(base + 1) * 3 + 2] = _v.z + _v2.z;

    this.distance += 0.25;
    this.uvs[base * 2] = 0;
    this.uvs[base * 2 + 1] = this.distance;
    this.uvs[(base + 1) * 2] = 1;
    this.uvs[(base + 1) * 2 + 1] = this.distance;

    const a = clamp(intensity, 0, 1) * 0.9;
    this.opacity[base] = a;
    this.opacity[base + 1] = a;

    // Break the ribbon when it wraps so it does not draw a line across the map.
    if (this.head === 0 && this.used > 0) {
      this.opacity[base] = 0;
      this.opacity[base + 1] = 0;
    }

    this.head = (this.head + 1) % this.segments;
    this.used = Math.min(this.used + 1, this.segments);
    this.lastPoint = (this.lastPoint ?? new THREE.Vector3()).copy(point);

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    this.geometry.attributes.aOpacity.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (this.used - 1) * 6));
  }

  clear() {
    this.head = 0;
    this.used = 0;
    this.lastPoint = null;
    this.opacity.fill(0);
    this.geometry.setDrawRange(0, 0);
    this.geometry.attributes.aOpacity.needsUpdate = true;
  }
}

/**
 * What each surface throws up, in two layers.
 *
 * `grit` is the material itself — stones, torn turf. It is heavy, so it
 * barely feels the air (low drag), flies on a ballistic arc and lands. `haze`
 * is the cloud the grit leaves behind: light enough that drag stops it almost
 * at once, so it hangs where the car was and sinks slowly. Emitting only one
 * of the two is what made an off-track excursion look like a smoke machine.
 */
const SURFACE_PARTICLE = [
  null, // road — smoke only, handled by slip
  null, // kerb
  null, // apron
  {
    // gravel trap
    rate: 60,
    grit: {
      share: 0.62, color: [0.56, 0.47, 0.35], life: 1, size: 0.07, growth: 0.5,
      lift: -9.4, drag: 0.32, rise: 3.4, carry: 0.55, opacity: 1, fadeIn: 22, stretch: 0.03,
    },
    haze: {
      share: 0.48, color: [0.74, 0.65, 0.5], life: 2.6, size: 0.7, growth: 5,
      lift: -0.25, drag: 3, rise: 2.2, carry: 0.28, opacity: 0.8, fadeIn: 4, stretch: 0,
    },
  },
  {
    // grass
    rate: 44,
    grit: {
      share: 0.55, color: [0.3, 0.36, 0.17], life: 0.85, size: 0.065, growth: 0.4,
      lift: -9.4, drag: 0.5, rise: 3.4, carry: 0.55, opacity: 1, fadeIn: 22, stretch: 0.03,
    },
    haze: {
      share: 0.5, color: [0.56, 0.56, 0.4], life: 1.6, size: 0.5, growth: 4,
      lift: -0.85, drag: 3.4, rise: 1.8, carry: 0.28, opacity: 0.65, fadeIn: 5, stretch: 0,
    },
  },
];

/** Road spray: near-white with the blue of the sky in it, never blown out. */
const SPRAY = [0.84, 0.88, 0.97];

/** Tyre smoke: warm rubber, but mostly grey. */
const SMOKE = [0.66, 0.66, 0.71];

const _col = [0, 0, 0];

/** The sRGB value a colour picker would show, as the linear one three wants. */
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * A surface colour at a given light level, in the space the renderer works in.
 *
 * Instance colours are linear. The colours above are written the way they
 * would be picked — sRGB — so without this conversion a mid-brown dust cloud
 * goes in at roughly twice the value it should and comes out of the tone
 * mapper white, which is exactly what it did. No allocation: emit() copies
 * the array immediately.
 */
function tinted(color, shade) {
  _col[0] = linear(color[0]) * shade;
  _col[1] = linear(color[1]) * shade;
  _col[2] = linear(color[2]) * shade;
  return _col;
}

/**
 * Ties the simulation to the visual effects: decides when a tyre is sliding
 * hard enough to smoke, when it is throwing dirt, and where to lay rubber.
 */
export class TyreEffects {
  constructor(scene, materials, { skidSegments = 900, particles = 700 } = {}) {
    this.smoke = new ParticleSystem(materials.smoke, { count: particles });
    // Sparks: additive, small, and they fall — hot metal has weight.
    this.sparks = new ParticleSystem(materials.spark ?? materials.smoke, {
      count: Math.max(60, Math.round(particles * 0.35)),
      additive: true,
      lift: -9.8,
      drag: 0.9,
    });
    this.marks = Array.from({ length: 4 }, () => new SkidMarks(materials.skid, { segments: skidSegments }));

    scene.add(this.smoke.mesh);
    scene.add(this.sparks.mesh);
    for (const m of this.marks) scene.add(m.mesh);

    // A smaller pool has to be filled more slowly, or one wet lap spends it
    // on the first corner and the wake flickers as slots are recycled under
    // the car.
    this.density = clamp(particles / 700, 0.45, 1.3);
    // Ambient light level, 0..1. These are unlit quads, so without this the
    // spray stays the same near-white in a thunderstorm at dusk as it is at
    // noon, and glows.
    this.light = 1;
    this.own = {
      spray: [0, 0, 0, 0], grit: [0, 0, 0, 0], haze: [0, 0, 0, 0], smoke: [0, 0, 0, 0],
    };
    this.wakes = new WeakMap();
    this.smokeLevel = 0;
  }

  /** Every mesh this owns, so the scene can drop them on teardown. */
  get meshes() {
    return [this.smoke.mesh, this.sparks.mesh, ...this.marks.map((m) => m.mesh)];
  }

  /**
   * A shower of sparks where the car has just hit something.
   *
   * @param {import('../physics/Vehicle.js').Vehicle} vehicle
   * @param {number} strength 0..1
   */
  impact(vehicle, strength) {
    const n = Math.round(lerp(6, 34, clamp(strength, 0, 1)));
    // Off the side of the car that is closest to the barrier, low down.
    const side = vehicle.telemetry.slipAngle >= 0 ? -1 : 1;
    _v2.set(side * 0.95, -0.25, 0).applyQuaternion(vehicle.quaternion);
    _v2.add(vehicle.position);
    for (let i = 0; i < n; i++) {
      _v.copy(vehicle.velocity).multiplyScalar(0.55);
      _v.x += (Math.random() - 0.5) * 6;
      _v.y += Math.random() * 3.5;
      _v.z += (Math.random() - 0.5) * 6;
      this.sparks.emit(_v2, {
        velocity: _v,
        life: 0.35 + Math.random() * 0.5,
        size: 0.05 + Math.random() * 0.06,
        growth: 0,
        color: [2.6, 1.5 + Math.random() * 0.6, 0.35],
        spread: 0.5,
        jitter: 2.2,
        // A spark is a moving point of light, so it draws as the streak the
        // eye actually sees rather than a round blob.
        stretch: 0.07,
        fadeIn: 30,
      });
    }
  }

  /**
   * The running emission fractions for one car.
   *
   * Emission is rate-based, so every car that throws anything needs its own
   * set. Rivals get theirs on demand and lose them with the vehicle.
   */
  #accumulators(vehicle) {
    let acc = this.wakes.get(vehicle);
    if (!acc) {
      acc = { spray: [0, 0, 0, 0], grit: [0, 0, 0, 0], haze: [0, 0, 0, 0] };
      this.wakes.set(vehicle, acc);
    }
    return acc;
  }

  /** Car frame: +Z forward, +Y up, and the car's right is −X. */
  #frame(vehicle) {
    _fwd.set(0, 0, 1).applyQuaternion(vehicle.quaternion);
    _rgt.set(-1, 0, 0).applyQuaternion(vehicle.quaternion);
  }

  /**
   * What one wheel throws off the surface it is on.
   *
   * The contact patch is standing still on the road, but the tread above it is
   * moving at twice the car's speed, and it flings whatever it picked up
   * tangentially. So everything here leaves with most of the car's ground
   * speed and is then hammered by the air: the plume trails the car because
   * the car outruns it, not because it was thrown backwards. Throwing it
   * backwards is what made this look like a smoke bomb.
   *
   * @param {number} gain emission rate multiplier — rivals throw less, and
   *                      less again with distance, so the pool is not spent
   *                      on cars a hundred metres up the road
   */
  #throw(vehicle, w, i, acc, dt, wet, gain) {
    /* -- spray ------------------------------------------------------------ */
    if (wet > 0.25 && w.surface <= 2 && vehicle.speed > 8) {
      const rear = w.axle === 'rear';
      const rate = clamp((vehicle.speed - 8) / 38, 0, 1) * wet * (rear ? 140 : 90)
        * gain * this.density;
      acc.spray[i] += rate * dt;
      while (acc.spray[i] >= 1) {
        acc.spray[i] -= 1;
        _v.copy(vehicle.velocity).multiplyScalar(rear ? 0.74 : 0.62);
        if (rear) {
          _v.y += 2.4 + vehicle.speed * 0.075; // rooster tail out of the arch
        } else {
          // The fronts shoulder the standing water aside as a bow wave.
          _v.addScaledVector(_rgt, w.side * (1.5 + vehicle.speed * 0.045));
          _v.y += 0.6;
        }
        _org.copy(w.contact)
          .addScaledVector(_fwd, rear ? -0.3 : -0.16)
          .addScaledVector(_rgt, w.side * 0.06);
        _org.y += 0.1;
        this.smoke.emit(_org, {
          velocity: _v,
          // Short-lived and overlapping: spray reads as mist because there is
          // a lot of it, each part of it faint. One big opaque puff per
          // droplet reads as bubbles.
          life: 0.5 + wet * 0.45,
          size: 0.26,
          growth: 4.2,
          color: tinted(SPRAY, this.light),
          spread: 0.2,
          jitter: 2.4,
          opacity: 0.55,
          // Water has weight and no buoyancy: the mist hangs on the air,
          // sinks, and settles back onto the road it came off.
          lift: -1.3,
          drag: 3.8,
          stretch: 0.06,
          fadeIn: 14,
          floor: w.contact.y,
        });
      }
    }

    /* -- dirt -------------------------------------------------------------- */
    const dirt = SURFACE_PARTICLE[w.surface];
    if (!dirt) return;

    // A tyre only throws material when it is moving over the surface and
    // scrabbling for grip. Rolling gently across the grass does not raise a
    // cloud, and the old rate — flat out above 8 m/s — meant a car trickling
    // back onto the track kicked up as much as one spinning its wheels.
    const dig = clamp(vehicle.speed / 16, 0, 1) * (0.35 + clamp(w.slipSpeed / 8, 0, 1) * 0.65);
    const rate = dig * dirt.rate * gain * this.density;
    if (rate <= 0.01) return;

    const shade = (1 - wet * 0.35) * this.light; // wet ground is darker
    _org.copy(w.contact).addScaledVector(_fwd, -0.22);
    _org.y += 0.06;

    // Stones and torn turf are thrown up and back out of the arch with much
    // of the car's speed, then follow a plain ballistic arc down. The cloud
    // they raise is only air: it carries almost none of that speed, so it
    // hangs where the car was — and rain lays it before it can form at all.
    this.#layer(dirt.grit, acc.grit, i, rate, dt, vehicle, w, shade, 0.18, 3.4);
    this.#layer(dirt.haze, acc.haze, i, rate * (1 - wet), dt, vehicle, w, shade, 0.5, 1.5);
  }

  /** One of the two layers a surface throws: see SURFACE_PARTICLE. */
  #layer(layer, acc, i, rate, dt, vehicle, w, shade, spread, jitter) {
    acc[i] += rate * layer.share * dt;
    while (acc[i] >= 1) {
      acc[i] -= 1;
      _v.copy(vehicle.velocity).multiplyScalar(layer.carry);
      _v.y += layer.rise + vehicle.speed * 0.06 * layer.carry;
      this.smoke.emit(_org, {
        velocity: _v,
        life: layer.life,
        size: layer.size,
        growth: layer.growth,
        color: tinted(layer.color, shade),
        spread,
        jitter,
        lift: layer.lift,
        drag: layer.drag,
        opacity: layer.opacity,
        stretch: layer.stretch,
        fadeIn: layer.fadeIn,
        floor: w.contact.y,
      });
    }
  }

  /**
   * The wake of a car other than the player's.
   *
   * A wet race in which only your own car throws spray looks wrong: the wall
   * of water off the car ahead is most of what you actually see in the rain.
   * Rivals get spray and thrown dirt only — no rubber, no tyre smoke — out of
   * the same pool, so they cost emission and nothing else.
   *
   * @param {number} gain 0..1, falling off with distance from the camera
   */
  wake(vehicle, dt, gain = 1) {
    if (gain <= 0.01) return;
    const wet = vehicle.track?.wetness ?? 0;
    const acc = this.#accumulators(vehicle);
    this.#frame(vehicle);
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      if (w.grounded) this.#throw(vehicle, w, i, acc, dt, wet, gain);
    }
  }

  /**
   * @param {import('../physics/Vehicle.js').Vehicle} vehicle
   */
  update(vehicle, dt, camera) {
    let peak = 0;
    const wet = vehicle.track?.wetness ?? 0;
    this.#frame(vehicle);

    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      const marks = this.marks[i];
      if (!w.grounded) {
        marks.add(w.contact, _v2, w.normal, 0);
        continue;
      }

      // How hard the tyre is working past its peak. Tyres do not smoke on a
      // wet road — the water takes the heat — and they leave far less rubber.
      const slide = clamp((w.slipSpeed - 2.4) / 12, 0, 1);
      const heat = clamp((w.tyre.temp - 95) / 90, 0, 1);
      const intensity = clamp(slide * (0.6 + heat * 0.7), 0, 1) * (1 - wet * 0.85);
      peak = Math.max(peak, intensity);

      this.#throw(vehicle, w, i, this.own, dt, wet, 1);

      // Lateral direction of the contact patch, for the mark's width.
      _v2.set(1, 0, 0).applyQuaternion(vehicle.quaternion);
      _v2.addScaledVector(w.normal, -_v2.dot(w.normal)).normalize();

      const onRoad = w.surface <= 2;
      marks.add(
        w.contact,
        _v2,
        w.normal,
        onRoad ? intensity : 0,
        w.axle === 'front' ? 0.245 : 0.305,
      );

      /* -- tyre smoke ------------------------------------------------------ */
      const rate = intensity * 46;
      if (rate <= 0.01) continue;
      this.own.smoke[i] += rate * dt;
      while (this.own.smoke[i] >= 1) {
        this.own.smoke[i] -= 1;
        // Tyre smoke is hot and all but weightless: the air stops it within a
        // metre of the contact patch, and then it billows and climbs.
        _v.copy(vehicle.velocity).multiplyScalar(0.22);
        _v.y += 0.4;
        this.smoke.emit(w.contact, {
          velocity: _v,
          life: lerp(1.1, 2.6, intensity),
          size: lerp(0.24, 0.5, intensity),
          growth: 5.4,
          color: tinted(SMOKE, this.light),
          spread: 0.3,
          jitter: 1.1,
          opacity: 0.78,
          lift: 0.9,
          drag: 3.6,
          floor: w.contact.y,
        });
      }
    }

    this.smokeLevel = peak;
    this.smoke.update(dt, camera);
    this.sparks.update(dt, camera);
  }

  clear() {
    for (const m of this.marks) m.clear();
  }
}
