import * as THREE from 'three';

import { clamp, lerp, makeRandom } from '../core/MathUtils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Tyre smoke and dust.
 *
 * A fixed pool of camera-facing quads drawn as one instanced mesh. Particles
 * are recycled oldest-first, so the system never allocates during a session
 * and its cost is constant regardless of how hard the car is being driven.
 */
export class ParticleSystem {
  /**
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

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.mesh.frustumCulled = false;
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
    this.tint = new Float32Array(count * 3);

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
  } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;

    const r = this.rand;
    this.position[i * 3] = origin.x + (r() - 0.5) * spread;
    this.position[i * 3 + 1] = origin.y + r() * spread * 0.5;
    this.position[i * 3 + 2] = origin.z + (r() - 0.5) * spread;

    this.velocity[i * 3] = velocity.x + (r() - 0.5) * 1.4;
    this.velocity[i * 3 + 1] = velocity.y + r() * 0.9 + 0.3;
    this.velocity[i * 3 + 2] = velocity.z + (r() - 0.5) * 1.4;

    this.life[i] = life * (0.7 + r() * 0.6);
    this.maxLife[i] = this.life[i];
    this.size[i] = size * (0.7 + r() * 0.7);
    this.growth[i] = growth;
    this.spin[i] = (r() - 0.5) * 1.6;
    this.tint[i * 3] = color[0];
    this.tint[i * 3 + 1] = color[1];
    this.tint[i * 3 + 2] = color[2];
  }

  update(dt, camera) {
    const d = this.dummy;
    let alive = 0;

    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        d.position.set(0, -9999, 0);
        d.scale.setScalar(0.0001);
        d.updateMatrix();
        this.mesh.setMatrixAt(i, d.matrix);
        continue;
      }

      this.life[i] -= dt;
      // Age must stay in [0, 1]: a particle whose life goes negative inside
      // this step would otherwise raise a negative base to a fractional power
      // below, and the resulting NaN travels through the instance colour
      // buffer into the HDR target, where bloom spreads it over the whole
      // frame and the screen goes black.
      const t = clamp(1 - this.life[i] / this.maxLife[i], 0, 1); // 0 new … 1 gone

      // Smoke slows, rises and spreads as it dissipates; sparks fall.
      const dragK = Math.exp(-this.drag * dt);
      this.velocity[i * 3] *= dragK;
      this.velocity[i * 3 + 2] *= dragK;
      this.velocity[i * 3 + 1] = this.velocity[i * 3 + 1] * dragK + this.lift * dt;

      this.position[i * 3] += this.velocity[i * 3] * dt;
      this.position[i * 3 + 1] += this.velocity[i * 3 + 1] * dt;
      this.position[i * 3 + 2] += this.velocity[i * 3 + 2] * dt;

      const scale = this.size[i] * (1 + t * this.growth[i]);
      d.position.set(this.position[i * 3], this.position[i * 3 + 1], this.position[i * 3 + 2]);
      d.quaternion.copy(camera.quaternion);
      d.rotateZ(this.spin[i] * t * 3);
      d.scale.setScalar(scale);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);

      // Fade in fast, out slow.
      const alpha = Math.min(t * 6, 1) * (1 - t) ** 1.4;
      this.colors[i * 3] = this.tint[i * 3] * alpha;
      this.colors[i * 3 + 1] = this.tint[i * 3 + 1] * alpha;
      this.colors[i * 3 + 2] = this.tint[i * 3 + 2] * alpha;
      alive++;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
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

/** Colours emitted particles by the surface the tyre is on. */
const SURFACE_PARTICLE = [
  null, // road — smoke only, handled by slip
  null, // kerb
  null, // apron
  { color: [0.66, 0.6, 0.5], life: 1.1, size: 0.45, growth: 3.2 }, // gravel
  { color: [0.42, 0.46, 0.28], life: 0.9, size: 0.35, growth: 2.6 }, // grass
];

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

    this.emitAccumulator = [0, 0, 0, 0];
    this.sprayAccumulator = [0, 0, 0, 0];
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
      });
    }
  }

  /**
   * @param {import('../physics/Vehicle.js').Vehicle} vehicle
   */
  update(vehicle, dt, camera) {
    let peak = 0;
    const wet = vehicle.track?.wetness ?? 0;

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

      /* -- spray ---------------------------------------------------------- */
      // A rooster tail off each tyre on a wet road: fine, pale, short-lived,
      // and thrown back along the car's wake.
      if (wet > 0.25 && w.surface <= 2 && vehicle.speed > 9) {
        const rate = clamp((vehicle.speed - 9) / 45, 0, 1) * wet * (w.axle === 'rear' ? 34 : 22);
        this.sprayAccumulator[i] += rate * dt;
        while (this.sprayAccumulator[i] >= 1) {
          this.sprayAccumulator[i] -= 1;
          _v.copy(vehicle.velocity).multiplyScalar(-0.28);
          _v.y += 1.6 + vehicle.speed * 0.02;
          this.smoke.emit(w.contact, {
            velocity: _v,
            life: 0.55 + wet * 0.35,
            size: 0.28,
            growth: 4.2,
            color: [0.74, 0.78, 0.84],
            spread: 0.28,
          });
        }
      }

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

      /* -- particles ------------------------------------------------------ */
      const dirt = SURFACE_PARTICLE[w.surface];
      const rate = dirt ? clamp(vehicle.speed / 8, 0, 1) * 55 : intensity * 46;
      if (rate <= 0.01) continue;

      this.emitAccumulator[i] += rate * dt;
      while (this.emitAccumulator[i] >= 1) {
        this.emitAccumulator[i] -= 1;

        _v.copy(vehicle.velocity).multiplyScalar(-0.14);
        if (dirt) {
          _v.y += 2.6;
          this.smoke.emit(w.contact, {
            velocity: _v,
            life: dirt.life,
            size: dirt.size,
            growth: dirt.growth,
            color: dirt.color,
            spread: 0.35,
          });
        } else {
          // Tyre smoke: blue-grey, and it drifts backwards off the car.
          this.smoke.emit(w.contact, {
            velocity: _v,
            life: lerp(0.9, 2.3, intensity),
            size: lerp(0.32, 0.7, intensity),
            growth: 3.4,
            color: [0.68, 0.68, 0.72],
            spread: 0.3,
          });
        }
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
