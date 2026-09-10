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
  // The pmndrs racing game ships CC0 assets only; its engine, tyre and
  // crash recordings are the ones a car actually makes.
  racing: {
    base: 'https://raw.githubusercontent.com/pmndrs/racing-game',
    sha: '7816a5d954b75e6ad853ae4e4f0cbbd628072643',
  },
  // A three.js lighting study that happens to carry a complete, properly
  // named grand prix car — wheels, hubs, brake ducts and all.
  lightexp: {
    base: 'https://raw.githubusercontent.com/rqphy/LightExperience',
    sha: '508317e2aa6227ae03e272ea491ae9ca5e160214',
  },
  // Google Fonts' repository of OFL typefaces.
  fonts: {
    base: 'https://raw.githubusercontent.com/google/fonts',
    sha: '334b789e33413f3aba4264d9aa6c97f7b94c5a2f',
  },
};

/** The texture set the F1's glTF references, by the names it uses. */
const F1_TEXTURES = [
  'carbon_baseColor',
  'Wheels_TREAD_baseColor',
  'Wheels_TREAD_normal',
  'decals_baseColor',
  'tvcam_baseColor',
  'car_chassis_baseColor',
  '2022_light_baseColor',
  'gp21_cockpit_details_baseColor',
  'gp21_pedals_baseColor',
  'gp21_cockpit_pull_normal',
  'cockpit_legs_support_normal',
  'gp21_cinture_baseColor',
  'gp21_cinture_normal',
  'GP21_CLEARLED_baseColor',
  'sf21_sw_buttons_baseColor',
  'sf21_sw_badges_baseColor',
  'gp21_LCD_baseColor',
];

/** repo, remote path, local path (relative to public/assets), credit */
export const ASSETS = [
  // ------------------------------------------------------------- the F1 ---
  // This one arrives as loose glTF: a JSON file, a 30 MB buffer and seventeen
  // PNGs. prepare-cars.mjs packs and shrinks it into models/cars/f1.glb, and
  // only that is committed — public/assets/models/cars/f1-src is ignored.
  {
    repo: 'lightexp',
    from: 'static/models/F1/gltf/F1.gltf',
    to: 'models/cars/f1-src/F1.gltf',
    credit: 'Ferrari F1-75 — Sketcher (sketchfab.com/sketcher987654321), CC BY-NC 4.0',
  },
  {
    repo: 'lightexp',
    from: 'static/models/F1/gltf/scene.bin',
    to: 'models/cars/f1-src/scene.bin',
    credit: 'Ferrari F1-75 — Sketcher (sketchfab.com/sketcher987654321), CC BY-NC 4.0',
  },
  {
    repo: 'lightexp',
    from: 'static/models/F1/license.txt',
    to: 'models/cars/f1-src/license.txt',
    credit: 'Ferrari F1-75 — Sketcher (sketchfab.com/sketcher987654321), CC BY-NC 4.0',
  },
  ...F1_TEXTURES.map((name) => ({
    repo: 'lightexp',
    from: `static/models/F1/gltf/textures/${name}.png`,
    to: `models/cars/f1-src/textures/${name}.png`,
    credit: 'Ferrari F1-75 — Sketcher (sketchfab.com/sketcher987654321), CC BY-NC 4.0',
  })),
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

  // ---------------------------------------------------------------- sound ---
  {
    repo: 'racing',
    from: 'public/sounds/engine.mp3',
    to: 'sounds/engine.mp3',
    credit: 'Engine, tyre and crash recordings — pmndrs/racing-game, CC0',
  },
  {
    repo: 'racing',
    from: 'public/sounds/tire-brake.mp3',
    to: 'sounds/tyres.mp3',
    credit: 'Engine, tyre and crash recordings — pmndrs/racing-game, CC0',
  },
  {
    repo: 'racing',
    from: 'public/sounds/crash.mp3',
    to: 'sounds/crash.mp3',
    credit: 'Engine, tyre and crash recordings — pmndrs/racing-game, CC0',
  },

  // ---------------------------------------------------------------- fonts ---
  {
    repo: 'fonts',
    from: 'ofl/bebasneue/BebasNeue-Regular.ttf',
    to: 'fonts/BebasNeue-Regular.ttf',
    credit: 'Bebas Neue — Ryoichi Tsunekawa / Dharma Type, SIL Open Font License 1.1',
  },
  {
    repo: 'fonts',
    from: 'ofl/barlowcondensed/BarlowCondensed-Regular.ttf',
    to: 'fonts/BarlowCondensed-Regular.ttf',
    credit: 'Barlow Condensed — Jeremy Tribby, SIL Open Font License 1.1',
  },
  {
    repo: 'fonts',
    from: 'ofl/barlowcondensed/BarlowCondensed-SemiBold.ttf',
    to: 'fonts/BarlowCondensed-SemiBold.ttf',
    credit: 'Barlow Condensed — Jeremy Tribby, SIL Open Font License 1.1',
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

  // ------------------------------------------------------------------ sea ---
  {
    repo: 'three',
    from: 'examples/textures/waternormals.jpg',
    to: 'textures/water_normals.png',
    credit: 'Water normal map — three.js examples, MIT',
  },

  // ------------------------------------------------------- trackside props ---
  // Buildings, a works compound and the bits and pieces that make the far
  // side of a barrier look like somewhere rather than nowhere. All real
  // modelled assets from the same village pack the trees come from, so they
  // share its material language.
  ...[
    ['cottage', 'cottage'],
    ['inn', 'inn'],
    ['sawMill', 'sawmill'],
    ['waterwell', 'well'],
    ['wagon', 'wagon'],
    ['crate1', 'crate1'],
    ['crate2', 'crate2'],
    ['crateStack', 'cratestack'],
    ['barrel', 'barrel'],
    ['fence', 'fence'],
    ['wall', 'wall'],
    ['wallCorner', 'wallcorner'],
    ['lightPost1', 'lightpost'],
    ['logSaw', 'logsaw'],
    ['stump', 'stump'],
  ].map(([from, to]) => ({
    repo: 'babylon',
    from: `meshes/villagePack/${from}/${from}.glb`,
    to: `models/props/${to}.glb`,
    credit: 'Village Pack — Babylon.js Assets, CC BY 4.0',
  })),
  {
    // A parked car. Deliberately not one of the cars the race is run in:
    // those are fifty to a hundred primitives apiece because every vent and
    // badge is its own material, which is exactly right for the one car
    // filling the screen and exactly wrong for the eighty in the car park.
    repo: 'babylon',
    from: 'meshes/car.glb',
    to: 'models/props/car.glb',
    credit: 'Low-poly car — Babylon.js Assets, CC BY 4.0',
  },

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
