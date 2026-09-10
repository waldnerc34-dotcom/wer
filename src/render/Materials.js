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
    // 0 dry … 1 soaked; shared by every surface shader that reacts to rain.
    this.wetUniform = { value: 0 };
    // How hard it is raining, and a clock — the road's puddles ripple.
    this.rainUniform = { value: 0 };
    this.rippleTime = { value: 0 };
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
      T('textures/asphalt_basecolor.webp', { srgb: true }),
      T('textures/asphalt_normal.webp'),
      T('textures/asphalt_roughness.webp'),
      T('textures/kerb_basecolor.webp', { srgb: true }),
      T('textures/kerb_normal.webp'),
      T('textures/kerb_roughness.webp'),
      T('textures/concrete_basecolor.webp', { srgb: true }),
      T('textures/concrete_normal.webp'),
      T('textures/concrete_roughness.webp'),
      T('textures/grass_basecolor.webp', { srgb: true }),
      T('textures/grass_normal.webp'),
      T('textures/gravel_basecolor.webp', { srgb: true }),
      T('textures/gravel_normal.webp'),
      T('textures/gravel_metalrough.webp'),
      T('textures/flake_normal.webp'),
    ]);

    this.smoke = await T('textures/smoke.webp', { srgb: true });
    this.skid = await T('textures/skid.webp', { srgb: true });
    this.spark = await T('textures/spark.webp', { srgb: true });

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
    patchWear(this.road, this.wetUniform, this.rainUniform, this.rippleTime);

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
  carPaint(color, { flakes = true, metallic = 0.12 } = {}) {
    // Car paint is not metal. It is a coloured dielectric base with metal
    // flakes suspended in it under a clear lacquer, and the difference
    // matters: a metalness of 0.85 has almost no diffuse term at all, so the
    // body stops showing its own colour and shows the sky instead. Against a
    // bright sky that is a pale, blotchy car whatever colour you painted it —
    // which is exactly how it looked.
    //
    // Low metalness for the base, a full clear coat for the gloss, and the
    // flake normal for the sparkle. The colour comes back, and the highlight
    // comes from the lacquer where it belongs.
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      metalness: metallic,
      roughness: 0.42,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      // The clear coat already carries the reflection; a third again on top
      // of it was the rest of the washout.
      envMapIntensity: 1,
      normalMap: flakes ? this.flakeNormal : null,
      // Flakes are a sparkle at arm's length and noise at fifty metres, which
      // is where a car spends most of a race.
      normalScale: new THREE.Vector2(0.035, 0.035),
      sheen: 0.18,
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
 * Folds the `aWear` / `aDust` vertex attributes into a standard material,
 * and lets the weather soak it.
 *
 * Rubber laid into the racing line darkens the surface and polishes it; the
 * dust and marbles that collect off-line lighten it and kill the gloss. Both
 * are baked per-vertex by the track builder, so this costs nothing at runtime
 * beyond two extra varyings. Wet tarmac is darker, and standing water
 * collects in the low spots of the roughness map — those go mirror-smooth
 * while the crown of the road stays merely damp.
 */
/**
 * Rubber, dust and water on a road surface.
 *
 * Wear and dust ride in as vertex attributes; wetness and the rain are
 * uniforms shared by every surface. The ripples are the part worth
 * explaining: standing water in a downpour is never still, and a mirror that
 * does not move reads as varnish. Where the roughness map says water pools,
 * rings expand from raindrop impacts and bend the surface normal — which the
 * reflections then follow, so the reflected world breaks up and reforms.
 */
function patchWear(material, wet = { value: 0 }, rain = { value: 0 }, time = { value: 0 }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = wet;
    shader.uniforms.uRain = rain;
    shader.uniforms.uRippleTime = time;
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
        uniform float uWet;
        uniform float uRain;
        uniform float uRippleTime;
        varying float vWear;
        varying float vDust;

        float rippleHash( vec2 p ) {
          return fract( sin( dot( p, vec2( 41.7, 289.1 ) ) ) * 43758.5453 );
        }

        // One impact per cell, each with its own moment and its own place in
        // it. The ring expands and dies inside its cell, so a single lookup
        // is enough and the field still reads as scattered rain.
        vec2 rippleNormal( vec2 uv, float speed ) {
          vec2 grid = uv;
          vec2 cell = floor( grid );
          vec2 f = fract( grid ) - 0.5;

          float seed = rippleHash( cell );
          float phase = fract( uRippleTime * speed + seed );
          vec2 centre = ( vec2( rippleHash( cell + 3.7 ), rippleHash( cell + 9.1 ) ) - 0.5 ) * 0.5;

          vec2 d = f - centre;
          float r = length( d );
          // A ring travelling outward, fading as it goes and as it ages.
          float radius = phase * 0.45;
          float ring = sin( ( r - radius ) * 46.0 ) * exp( -abs( r - radius ) * 16.0 );
          float life = ( 1.0 - phase ) * smoothstep( 0.0, 0.08, phase );
          return normalize( d + 1e-5 ) * ring * life;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Rubbered-in racing line: darker and slightly blue-black.
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.44, 0.45, 0.48 ), vWear );
        // Marbles and dust off-line: lighter, warmer, dead matte.
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.65, 1.55, 1.35 ), vDust );
        // Soaked tarmac: water fills the pores, so far less light scatters back.
        diffuseColor.rgb *= mix( 1.0, 0.58, uWet );`,
      )
      // Ripples go in before the tangent-space normal reaches the surface,
      // which is the only place a perturbation is in the right frame.
      .replace(
        'mapN.xy *= normalScale;',
        `mapN.xy *= normalScale;
        #ifdef USE_ROUGHNESSMAP
          float puddleDepth = smoothstep( 0.42, 0.18, texture2D( roughnessMap, vRoughnessMapUv ).g );
          float wetness = uWet * ( 0.25 + 0.75 * puddleDepth );
          if ( uRain > 0.001 && wetness > 0.01 ) {
            vec2 ripple = rippleNormal( vNormalMapUv * 34.0, 0.9 )
              + rippleNormal( vNormalMapUv * 61.0 + 17.3, 1.4 ) * 0.6;
            mapN.xy += ripple * wetness * uRain * 0.55;
          }
        #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.68, vWear );
        roughnessFactor = min( 1.0, mix( roughnessFactor, roughnessFactor * 1.12, vDust ) );
        // Rain: the whole surface goes glossy, and the low spots of the
        // roughness map — where water stands — become mirrors.
        float puddle = smoothstep( 0.42, 0.18, roughnessFactor );
        roughnessFactor = mix( roughnessFactor, 0.08, uWet * ( 0.45 + 0.55 * puddle ) );`,
      );
  };
  material.customProgramCacheKey = () => 'wear';
}
