import * as THREE from 'three';

/**
 * Rain, as a field of streaks that lives around the camera.
 *
 * The streaks never move on the CPU: each is a quad with a fixed offset in a
 * box, and the vertex shader wraps that box around the camera and slides the
 * drops down it with time, so a few thousand of them cost one draw call and
 * no per-frame work at all. Wind tilts the whole field.
 */
export class RainSystem {
  constructor({ count = 3600 } = {}) {
    this.count = count;
    this.uniforms = {
      uTime: { value: 0 },
      uCamera: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector2(0, 0) },
      uIntensity: { value: 0 },
      uFall: { value: 20 },
    };

    const box = new THREE.Vector3(36, 24, 36);
    const offset = new Float32Array(count * 4 * 3);
    const corner = new Float32Array(count * 4 * 2);
    const phase = new Float32Array(count * 4);
    const index = new Uint32Array(count * 6);
    const rnd = mulberry(7);

    for (let i = 0; i < count; i++) {
      const ox = rnd() * box.x;
      const oy = rnd() * box.y;
      const oz = rnd() * box.z;
      const ph = rnd();
      const corners = [
        [-1, 0],
        [1, 0],
        [1, 1],
        [-1, 1],
      ];
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        offset[v * 3] = ox;
        offset[v * 3 + 1] = oy;
        offset[v * 3 + 2] = oz;
        corner[v * 2] = corners[k][0];
        corner[v * 2 + 1] = corners[k][1];
        phase[v] = ph;
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 4 * 3), 3));
    geometry.setAttribute('offset', new THREE.BufferAttribute(offset, 3));
    geometry.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geometry.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCamera;
        uniform vec2 uWind;
        uniform float uFall;
        uniform float uIntensity;
        attribute vec3 offset;
        attribute vec2 corner;
        attribute float phase;
        varying vec2 vCorner;
        varying float vFade;

        const vec3 BOX = vec3(${box.x.toFixed(1)}, ${box.y.toFixed(1)}, ${box.z.toFixed(1)});

        void main() {
          // Wrap the field around the camera, then let time slide each drop
          // down its own column, wind carrying it sideways as it falls.
          vec3 p = offset;
          p.xz += uWind * uTime * 0.9;
          p.y -= uTime * uFall * (0.8 + phase * 0.5);
          vec3 w = uCamera + mod(p - uCamera, BOX) - BOX * 0.5;

          // Streak: a thin quad, its long side along the direction of fall.
          vec3 fall = normalize(vec3(uWind.x * 0.06, -1.0, uWind.y * 0.06));
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          float len = 0.55 + phase * 0.5;
          w += right * corner.x * 0.017 + fall * corner.y * len;

          vCorner = corner;
          float dist = length(w - uCamera);
          // Nearest drops are only there as flicker; the body of the rain sits
          // a few metres out. Beyond the box they simply fade.
          vFade = smoothstep(0.5, 2.2, dist) * (1.0 - smoothstep(14.0, 18.0, dist)) * uIntensity;

          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vCorner;
        varying float vFade;
        void main() {
          float a = (1.0 - abs(vCorner.x)) * (1.0 - vCorner.y * 0.7) * vFade * 0.62;
          gl_FragColor = vec4(0.82, 0.86, 0.94, a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.name = 'rain';
  }

  /** @param {number} intensity 0 none, 1 rain, 2 storm */
  setIntensity(intensity, wind = 0.5) {
    this.uniforms.uIntensity.value = Math.min(1, intensity * 0.7);
    this.uniforms.uWind.value.set(wind * 2.2, wind * 0.8);
    this.uniforms.uFall.value = 18 + intensity * 4;
    this.mesh.visible = intensity > 0;
    // Storm draws the whole field; rain draws two thirds of it.
    this.mesh.geometry.setDrawRange(0, Math.round(this.count * (intensity >= 2 ? 1 : 0.66)) * 6);
  }

  update(dt, camera) {
    if (!this.mesh.visible) return;
    this.uniforms.uTime.value += dt;
    this.uniforms.uCamera.value.copy(camera.position);
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
