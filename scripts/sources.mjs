/**
 * Pinned, reproducible manifest of every third-party asset APEX ships.
 *
 * Everything here is fetched from a specific commit so that a fresh clone
 * always resolves the exact bytes this build was authored against.
 */

export const REPOS = {
  three: {
    base: 'https://raw.githubusercontent.com/mrdoob/three.js',
    sha: 'aaf21735d5eef2321d84ec6623c500ac935cbab7',
  },
  khronos: {
    base: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets',
    sha: '90d7ede14c7e280af263824604b427a1ca02cb66',
  },
  babylon: {
    base: 'https://raw.githubusercontent.com/BabylonJS/Assets',
    sha: '8be9384c7f8728cb45d27975ac92a412f97a98dd',
  },
  // The react-three-fiber examples monorepo carries several Sketchfab cars
  // with their licences recorded in the example sources.
  pmndrs: {
    base: 'https://raw.githubusercontent.com/pmndrs/examples',
    sha: '6ea1379e3163aa413970fea2e6b7b3e59b63d2c4',
  },
};

/** repo, remote path, local path (relative to public/assets), credit */
export const ASSETS = [
  // ---------------------------------------------------------------- cars ---
  {
    repo: 'three',
    from: 'examples/models/gltf/ferrari.glb',
    to: 'models/cars/ferrari.glb',
    credit: 'Ferrari 458 Italia — vicent091036 (via three.js examples), CC BY 4.0',
  },
  {
    repo: 'three',
    from: 'examples/models/gltf/ferrari_ao.png',
    to: 'models/cars/ferrari_ao.png',
    credit: 'Ferrari contact-shadow map — three.js examples, MIT',
  },
  {
    repo: 'khronos',
    from: 'Models/CarConcept/glTF-Binary/CarConcept.glb',
    to: 'models/cars/concept.glb',
    credit: 'Car Concept — The Khronos Group, CC BY 4.0',
  },
  // Rig-ready versions of these are produced by scripts/prepare-cars.mjs:
  // wheels split out onto hubs, materials renamed to what the car rig expects.
  {
    repo: 'pmndrs',
    from: 'examples/building-live-envmaps/src/911-transformed.glb',
    to: 'models/cars/porsche911.glb',
    credit:
      'Porsche 911 Carrera 4S — Karol Miklas (sketchfab.com/karolmiklas, via pmndrs/examples), CC BY-SA 4.0',
  },
  {
    repo: 'pmndrs',
    from: 'examples/stage-presets-gltfjsx/src/datsun-transformed.glb',
    to: 'models/cars/datsun240k.glb',
    credit:
      '1972 Datsun 240K GT — Karol Miklas (sketchfab.com/karolmiklas, via pmndrs/examples), CC BY-SA 4.0',
  },
  {
    repo: 'pmndrs',
    from: 'examples/building-dynamic-envmaps/src/lambo.glb',
    to: 'models/cars/urus.glb',
    credit:
      'Lamborghini Urus — Steven Grey (sketchfab.com/Steven007, via pmndrs/examples), CC BY-NC 4.0 — non-commercial use only',
  },

  // ------------------------------------------------------------- lighting ---
  // Poly Haven CC0 captures, mirrored in the three.js repository.
  ...[
    'venice_sunset_1k.hdr',
    'quarry_01_1k.hdr',
    'spruit_sunrise_1k.hdr',
    'blouberg_sunrise_2_1k.hdr',
    'pedestrian_overpass_1k.hdr',
    'moonless_golf_1k.hdr',
  ].map((f) => ({
    repo: 'three',
    from: `examples/textures/equirectangular/${f}`,
    to: `hdri/${f}`,
    credit: 'HDRI — Poly Haven, CC0 (mirrored by three.js)',
  })),

  // ----------------------------------------------------------- vegetation ---
  ...[1, 2, 3, 4].map((i) => ({
    repo: 'babylon',
    from: `meshes/villagePack/tree${i}/tree${i}.glb`,
    to: `models/scenery/tree${i}.glb`,
    credit: 'Village Pack — Babylon.js Assets, CC BY 4.0',
  })),
  ...[1, 2, 3, 4, 5].map((i) => ({
    repo: 'babylon',
    from: `meshes/villagePack/bush${i}/bush${i}.glb`,
    to: `models/scenery/bush${i}.glb`,
    credit: 'Village Pack — Babylon.js Assets, CC BY 4.0',
  })),
  ...[1, 2, 3, 4].map((i) => ({
    repo: 'babylon',
    from: `meshes/villagePack/rocks${i}/rocks${i}.glb`,
    to: `models/scenery/rocks${i}.glb`,
    credit: 'Village Pack — Babylon.js Assets, CC BY 4.0',
  })),

  // ------------------------------------------------------------- surfaces ---
  {
    repo: 'babylon',
    from: 'textures/rockyGround_basecolor.png',
    to: 'textures/gravel_basecolor.png',
    credit: 'Rocky ground PBR set — Babylon.js Assets, CC BY 4.0',
  },
  {
    repo: 'babylon',
    from: 'textures/rockyGround_normal.png',
    to: 'textures/gravel_normal.png',
    credit: 'Rocky ground PBR set — Babylon.js Assets, CC BY 4.0',
  },
  {
    repo: 'babylon',
    from: 'textures/rockyGround_metalRough.png',
    to: 'textures/gravel_metalrough.png',
    credit: 'Rocky ground PBR set — Babylon.js Assets, CC BY 4.0',
  },
  {
    repo: 'babylon',
    from: 'textures/grass.png',
    to: 'textures/grass_basecolor.png',
    credit: 'Grass — Babylon.js Assets, CC BY 4.0',
  },
  {
    repo: 'babylon',
    from: 'textures/grassn.png',
    to: 'textures/grass_normal.png',
    credit: 'Grass normal — Babylon.js Assets, CC BY 4.0',
  },

  {
    repo: 'babylon',
    from: 'textures/tree.png',
    to: 'textures/tree_canopy.png',
    credit: 'Photographic tree canopy — Babylon.js Assets, CC BY 4.0',
  },
  {
    repo: 'babylon',
    from: 'textures/valleygrass.png',
    to: 'textures/valleygrass.png',
    credit: 'Valley grass — Babylon.js Assets, CC BY 4.0',
  },

  // -------------------------------------------------------------- effects ---
  {
    repo: 'three',
    from: 'examples/textures/sprites/spark1.png',
    to: 'textures/spark.png',
    credit: 'Spark sprite — three.js examples, MIT',
  },
  {
    repo: 'three',
    from: 'examples/textures/lensflare/lensflare0.png',
    to: 'textures/lensflare0.png',
    credit: 'Lens flare — three.js examples, MIT',
  },
  {
    repo: 'three',
    from: 'examples/textures/lensflare/lensflare3.png',
    to: 'textures/lensflare3.png',
    credit: 'Lens flare — three.js examples, MIT',
  },
];
