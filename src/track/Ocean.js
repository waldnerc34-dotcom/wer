import * as THREE from 'three';

/**
 * The sea, for the circuits that run beside one.
 *
 * Not three.js's `Water`: that renders the whole scene a second time into a
 * mirror texture every frame, which is a doubling of the frame cost for
 * something that occupies the top eighth of the screen and is, on any real
 * sea, mostly sky anyway. This is a single plane with the reflection coming
 * from the environment map that already lights the circuit — so it reflects
 * the same sky, the same sun and the same horizon as everything else, at the
 * cost of one more draw.
 *
 * What sells it is the movement. Two scrolling taps of a real photographed
 * normal map at different scales, crossing at an angle: one long swell and
 * one short chop over it. A single scrolling tap reads as wallpaper being
 * dragged past, because it is.
 */
export class Ocean {
  /**
   * @param {object} [options]
   * @param {number} [options.level]  height of the water, in metres
   * @param {number} [options.extent] how far it reaches, in metres
   * @param {number} [options.color]  deep-water colour
   */
  constructor({ level = -30, extent = 14000, color = 0x0d2b3a } = {}) {
    this.level = level;
    this.time = { value: 0 };

    const geometry = new THREE.PlaneGeometry(extent, extent, 1, 1);
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: 0.06,
      metalness: 0.02,
      envMapIntensity: 1.35,
    });
    // Wave motion, injected into the standard material so the sea is lit by
    // the same image-based lighting as the cars and the tarmac.
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.uniforms.uWaves = { value: this.normals ?? null };
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWorld;',
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uTime;
        uniform sampler2D uWaves;
        varying vec3 vWorld;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        // How far out this pixel is. Past the far end the waves are smaller
        // than a pixel, so keeping them there buys nothing but a sea that
        // sparkles like tinfoil — and, on the far side of a two-kilometre
        // plane, that is most of the pixels on the screen. So the taps are
        // skipped entirely out there rather than computed and then blended
        // away.
        float far = smoothstep(300.0, 2400.0, length(vWorld - cameraPosition));
        if (far < 0.995) {
          // Two taps of the same map, at different scales and crossing at an
          // angle: the long swell under a short chop. Sampled in world space
          // so the wavelength holds however large the plane is.
          vec2 swell = vWorld.xz * 0.0055 + vec2(uTime * 0.010, uTime * 0.014);
          vec2 chop  = vWorld.xz * 0.0270 - vec2(uTime * 0.031, uTime * -0.023);
          vec3 a = texture2D(uWaves, swell).xyz * 2.0 - 1.0;
          vec3 b = texture2D(uWaves, chop).xyz * 2.0 - 1.0;
          vec3 wave = normalize(vec3(a.xy + b.xy * 0.45, a.z * 2.4));
          normal = normalize(mix(vec3(wave.x, wave.z, wave.y), vec3(0.0, 1.0, 0.0), far));
        }
        `,
      );
      this.shader = shader;
    };

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'ocean';
    this.mesh.position.y = level;
    // Drawn *after* the land, not before it. The sea reaches the horizon in
    // every direction, so most of it is behind a hill or a grandstand — and
    // drawing it first means shading every one of those pixels and then
    // throwing them away. Last, the depth test rejects them before the
    // fragment shader ever runs.
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    // The sea is not fogged as an object; it meets the haze at the horizon
    // because the atmosphere pass hazes it by distance like everything else.
    this.mesh.material.fog = true;
  }

  /** @param {THREE.Texture} texture the water normal map */
  setNormals(texture) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    this.normals = texture;
    if (this.shader) this.shader.uniforms.uWaves.value = texture;
  }

  /** Keeps the sea centred on the car, so it always reaches the horizon. */
  update(dt, camera) {
    this.time.value += dt;
    if (camera) {
      this.mesh.position.x = camera.position.x;
      this.mesh.position.z = camera.position.z;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
