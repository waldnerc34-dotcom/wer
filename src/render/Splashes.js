import * as THREE from 'three';

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Rain hitting the road.
 *
 * Each drop that lands throws up a small crown and leaves a ring spreading
 * over the wet surface for a third of a second. The splashes are a pool of
 * instanced quads scattered on the tarmac around the camera — mostly ahead
 * of it, where the eye is — that respawn wherever the track says there is
 * road as they die. The CPU places them; the shaders do the animating.
 */
export class SplashSystem {
  constructor({ count = 480 } = {}) {
    this.count = count;
    this.intensity = 0;
    this.uniforms = {
      uTime: { value: 0 },
      uCamera: { value: new THREE.Vector3() },
    };

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3),
    );
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.origin = new Float32Array(count * 3);
    this.spawn = new Float32Array(count).fill(-1e9);
    this.seed = new Float32Array(count);
    this.kind = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.seed[i] = Math.random();
      // Two in three are rings on the surface; the rest are crowns that
      // stand up for an instant.
      this.kind[i] = i % 3 === 2 ? 1 : 0;
    }
    this.originAttr = new THREE.InstancedBufferAttribute(this.origin, 3);
    this.spawnAttr = new THREE.InstancedBufferAttribute(this.spawn, 1);
    this.originAttr.setUsage(THREE.DynamicDrawUsage);
    this.spawnAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iOrigin', this.originAttr);
    geometry.setAttribute('iSpawn', this.spawnAttr);
    geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(this.seed, 1));
    geometry.setAttribute('iKind', new THREE.InstancedBufferAttribute(this.kind, 1));
    geometry.instanceCount = count;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCamera;
        attribute vec3 iOrigin;
        attribute float iSpawn;
        attribute float iSeed;
        attribute float iKind;
        varying vec2 vUv;
        varying float vT;
        varying float vKind;
        varying float vFade;

        void main() {
          float life = 0.32 + iSeed * 0.2;
          float t = (uTime - iSpawn) / life;
          vUv = uv;
          vT = t;
          vKind = iKind;
          if (t < 0.0 || t > 1.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vFade = 0.0;
            return;
          }
          vec3 p;
          if (iKind < 0.5) {
            // A ring: flat on the road, spreading as it fades.
            float radius = mix(0.05, 0.26, sqrt(t)) * (0.8 + iSeed * 0.5);
            p = iOrigin + vec3(position.x * radius, 0.03, position.z * radius);
          } else {
            // A crown: a sprite standing up off the surface, tallest at first.
            float h = 0.11 * (0.7 + iSeed * 0.6);
            vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
            float rise = sin(min(1.0, t * 1.6) * 3.1416) ;
            p = iOrigin + right * position.x * h * 0.45 + vec3(0.0, 0.02 + uv.y * h * (0.3 + rise), 0.0);
          }
          float dist = length(p - uCamera);
          vFade = 1.0 - smoothstep(22.0, 34.0, dist);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vT;
        varying float vKind;
        varying float vFade;

        void main() {
          if (vFade <= 0.0) discard;
          float a;
          if (vKind < 0.5) {
            vec2 d = vUv * 2.0 - 1.0;
            float r = length(d);
            // The ring itself, thinning as it spreads, and the bright dot
            // of the impact at the centre for the first instant.
            float ring = smoothstep(0.14, 0.0, abs(r - 0.82)) * (1.0 - vT) * 0.5;
            float dot_ = smoothstep(0.4, 0.0, r) * (1.0 - smoothstep(0.0, 0.3, vT)) * 0.7;
            a = (ring + dot_);
          } else {
            // A few drops thrown up: brightest at the tips, gone quickly.
            float x = abs(vUv.x * 2.0 - 1.0);
            float column = smoothstep(0.55, 0.05, x) * (1.0 - vUv.y * 0.5);
            float tips = smoothstep(0.45, 1.0, vUv.y) * smoothstep(0.4, 0.0, abs(fract(vUv.x * 3.0) - 0.5));
            a = (column * 0.3 + tips * 0.7) * (1.0 - smoothstep(0.25, 0.9, vT)) * smoothstep(0.0, 0.08, vT);
          }
          gl_FragColor = vec4(0.86, 0.9, 0.96, a * vFade * 0.42);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.mesh.name = 'splashes';
    this.query = {};
    this.time = 0;
  }

  /** @param {number} intensity 0 none, 1 rain, 2 storm */
  setIntensity(intensity) {
    this.intensity = intensity;
    this.mesh.visible = intensity > 0;
    if (intensity <= 0) this.spawn.fill(-1e9);
  }

  /**
   * Retires dead splashes and lands new drops on the road around the camera.
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {import('../track/Track.js').Track} track
   */
  update(dt, camera, track) {
    if (!this.mesh.visible) return;
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uCamera.value.copy(camera.position);

    // Rain uses two thirds of the pool, a storm all of it.
    const alive = Math.round(this.count * (this.intensity >= 2 ? 1 : 0.66));
    _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _f.y = 0;
    _f.normalize();
    _r.set(_f.z, 0, -_f.x);
    const q = this.query;
    let changed = false;

    for (let i = 0; i < alive; i++) {
      const life = 0.32 + this.seed[i] * 0.2;
      if (this.time - this.spawn[i] < life) continue;
      // A point on the road somewhere in front of the camera — a few tries,
      // since the grass takes up most of the disc.
      for (let attempt = 0; attempt < 3; attempt++) {
        const ahead = -3 + Math.random() * 30;
        const side = (Math.random() - 0.5) * 34;
        _v.copy(camera.position).addScaledVector(_f, ahead).addScaledVector(_r, side);
        track.query(_v.x, _v.z, q);
        if (q.surface > 2) continue;
        this.origin[i * 3] = _v.x;
        this.origin[i * 3 + 1] = q.height;
        this.origin[i * 3 + 2] = _v.z;
        // A short random delay keeps the pool from pulsing in step.
        this.spawn[i] = this.time + Math.random() * 0.25;
        changed = true;
        break;
      }
    }
    for (let i = alive; i < this.count; i++) {
      if (this.spawn[i] > -1e8) {
        this.spawn[i] = -1e9;
        changed = true;
      }
    }
    if (changed) {
      this.originAttr.needsUpdate = true;
      this.spawnAttr.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
