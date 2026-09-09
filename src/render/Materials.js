import * as THREE from 'three';

/**
 * Every material in the game, built once from the loaded texture set.
 *
 * The road materials carry two extra per-vertex channels the standard material
 * knows nothing about — `aWear` (rubber laid down on the racing line) and
 * `aDust` (marbles and dirt off it) — which are folded into base colour and
 * roughness with a small shader patch.
 */
export class Materials {
  constructor() {
    this.all = [];
  }

  async load(assets) {
    const T = (p, o) => assets.texture(p, o);

    const [
      asphaltMap,
      asphaltNrm,
      asphaltRgh,
      kerbMap,
      kerbNrm,
      kerbRgh,
      concreteMap,
      concreteNrm,
      concreteRgh,
      grassMap,
      grassNrm,
      gravelMap,
      gravelNrm,
      gravelMr,
      flakeNrm,
    ] = await Promise.all([
      T('textures/asphalt_basecolor.png', { srgb: true }),
      T('textures/asphalt_normal.png'),
      T('textures/asphalt_roughness.png'),
      T('textures/kerb_basecolor.png', { srgb: true }),
      T('textures/kerb_normal.png'),
      T('textures/kerb_roughness.png'),
      T('textures/concrete_basecolor.png', { srgb: true }),
      T('textures/concrete_normal.png'),
      T('textures/concrete_roughness.png'),
      T('textures/grass_basecolor.png', { srgb: true }),
      T('textures/grass_normal.png'),
      T('textures/gravel_basecolor.png', { srgb: true }),
      T('textures/gravel_normal.png'),
      T('textures/gravel_metalrough.png'),
      T('textures/flake_normal.png'),
    ]);

    this.smoke = await T('textures/smoke.png', { srgb: true });
    this.skid = await T('textures/skid.png', { srgb: true });

    /* ------------------------------------------------------------- road -- */

    this.road = new THREE.MeshStandardMaterial({
      map: asphaltMap,
      color: 0x6e6e72,
      normalMap: asphaltNrm,
      roughnessMap: asphaltRgh,
      // Tarmac is a fine-grained surface seen at a shallow angle: a strong
      // normal here reads as gravel rather than asphalt.
      normalScale: new THREE.Vector2(0.22, 0.22),
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.55,
      dithering: true,
    });
    patchWear(this.road);

    this.kerb = new THREE.MeshStandardMaterial({
      map: kerbMap,
      normalMap: kerbNrm,
      roughnessMap: kerbRgh,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 1,
      metalness: 0,
    });

    /** Painted line markings — flat white, slightly glossier than the road. */
    this.line = new THREE.MeshStandardMaterial({
      color: 0xdedad2,
      roughness: 0.62,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    this.apron = new THREE.MeshStandardMaterial({
      map: asphaltMap.clone(),
      normalMap: asphaltNrm,
      roughnessMap: asphaltRgh,
      color: 0xb9b6b0,
      roughness: 1,
      metalness: 0,
    });
    this.apron.map.repeat.set(1, 1);

    this.gravel = new THREE.MeshStandardMaterial({
      map: gravelMap,
      normalMap: gravelNrm,
      roughnessMap: gravelMr,
      color: 0xa8a094,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 1,
      metalness: 0,
    });

    /* ---------------------------------------------------------- terrain -- */

    this.terrain = new THREE.MeshStandardMaterial({
      map: grassMap,
      normalMap: grassNrm,
      // Let the photograph carry the colour; the per-vertex tint below only
      // varies it. Multiplying by a green here just oversaturates it.
      color: 0xc9cdbc,
      normalScale: new THREE.Vector2(1.3, 1.3),
      roughness: 0.96,
      envMapIntensity: 0.65,
      metalness: 0,
      vertexColors: true,
    });

    /* --------------------------------------------------------- structure -- */

    this.concrete = new THREE.MeshStandardMaterial({
      map: concreteMap,
      normalMap: concreteNrm,
      roughnessMap: concreteRgh,
      roughness: 1,
      metalness: 0,
    });

    // Galvanised steel that has been outside for a decade, not chrome.
    this.armco = new THREE.MeshStandardMaterial({
      color: 0x7d848b,
      roughness: 0.62,
      metalness: 0.75,
      envMapIntensity: 0.85,
    });

    this.post = new THREE.MeshStandardMaterial({
      color: 0x51565b,
      roughness: 0.78,
      metalness: 0.7,
    });

    this.tyreWall = new THREE.MeshStandardMaterial({
      color: 0x14161a,
      roughness: 0.92,
      metalness: 0,
    });

    this.paintedWhite = new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.55 });
    this.paintedRed = new THREE.MeshStandardMaterial({ color: 0x8e1f21, roughness: 0.6 });

    /* -------------------------------------------------------------- car -- */

    this.flakeNormal = flakeNrm;
    this.flakeNormal.repeat.set(220, 220);

    this.glass = new THREE.MeshPhysicalMaterial({
      color: 0x101418,
      roughness: 0.045,
      metalness: 0,
      transmission: 0.92,
      thickness: 0.02,
      ior: 1.52,
      transparent: true,
      opacity: 0.42,
      envMapIntensity: 1.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.tyre = new THREE.MeshStandardMaterial({
      color: 0x0c0d0f,
      roughness: 0.86,
      metalness: 0,
      envMapIntensity: 0.4,
    });

    this.rim = new THREE.MeshStandardMaterial({
      color: 0x3c4045,
      roughness: 0.28,
      metalness: 1,
      envMapIntensity: 1.4,
    });

    this.brakeDisc = new THREE.MeshStandardMaterial({
      color: 0x2a2622,
      roughness: 0.45,
      metalness: 0.95,
    });

    this.caliper = new THREE.MeshStandardMaterial({
      color: 0xb02318,
      roughness: 0.4,
      metalness: 0.3,
    });

    this.trim = new THREE.MeshStandardMaterial({
      color: 0x1a1c1f,
      roughness: 0.42,
      metalness: 0.85,
      envMapIntensity: 1.2,
    });

    return this;
  }

  /**
   * Automotive paint: a metallic base coat under a thin, near-perfect clear
   * coat, with a fine flake normal that only affects the base layer.
   */
  carPaint(color, { flakes = true, metallic = 0.85 } = {}) {
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      metalness: metallic,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.035,
      envMapIntensity: 1.35,
      normalMap: flakes ? this.flakeNormal : null,
      normalScale: new THREE.Vector2(0.06, 0.06),
      sheen: 0.25,
      sheenColor: new THREE.Color(color).offsetHSL(0, 0, 0.25),
    });
    return m;
  }

  /** Applies the scene environment map intensity consistently. */
  setEnvIntensity(v) {
    for (const key of Object.keys(this)) {
      const m = this[key];
      if (m?.isMaterial && 'envMapIntensity' in m) m.envMapIntensity = v;
    }
  }
}

/**
 * Folds the `aWear` / `aDust` vertex attributes into a standard material.
 *
 * Rubber laid into the racing line darkens the surface and polishes it; the
 * dust and marbles that collect off-line lighten it and kill the gloss. Both
 * are baked per-vertex by the track builder, so this costs nothing at runtime
 * beyond two extra varyings.
 */
function patchWear(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aWear;
        attribute float aDust;
        varying float vWear;
        varying float vDust;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWear = aWear;
        vDust = aDust;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vWear;
        varying float vDust;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Rubbered-in racing line: darker and slightly blue-black.
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.44, 0.45, 0.48 ), vWear );
        // Marbles and dust off-line: lighter, warmer, dead matte.
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.65, 1.55, 1.35 ), vDust );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.68, vWear );
        roughnessFactor = min( 1.0, mix( roughnessFactor, roughnessFactor * 1.12, vDust ) );`,
      );
  };
  material.customProgramCacheKey = () => 'wear';
}
