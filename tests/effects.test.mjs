/**
 * Guards the particle system against non-finite output.
 *
 * A NaN in the instance colour buffer is not a cosmetic problem: it reaches
 * the HDR render target, bloom spreads it across the mip chain, and the entire
 * frame renders black. This drives the system past the end of every particle's
 * life and asserts nothing non-finite ever leaves it.
 *
 *   node tests/effects.test.mjs
 */

import * as THREE from 'three';

import { ParticleSystem, TyreEffects } from '../src/render/Effects.js';

const camera = new THREE.PerspectiveCamera();
const texture = new THREE.Texture();
const system = new ParticleSystem(texture, { count: 128 });

const origin = new THREE.Vector3();
let emitted = 0;
let failures = 0;

const finite = (array) => {
  for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) return false;
  return true;
};

// Emit hard for a second, then run well past the longest particle life with a
// deliberately coarse timestep — the case that produced negative ages.
for (let step = 0; step < 900; step++) {
  const dt = step % 7 === 0 ? 0.09 : 1 / 60; // include frame hitches
  if (step < 120) {
    for (let k = 0; k < 4; k++) {
      system.emit(origin, { life: 0.35 + (k % 3) * 0.4, size: 0.5 });
      emitted++;
    }
  }
  system.update(dt, camera);

  if (!finite(system.mesh.instanceMatrix.array)) {
    console.log(`  ✖ non-finite instance matrix at step ${step}`);
    failures++;
    break;
  }
  if (!finite(system.mesh.instanceColor.array)) {
    console.log(`  ✖ non-finite instance colour at step ${step}`);
    failures++;
    break;
  }
  if (!finite(system.alphas)) {
    console.log(`  ✖ non-finite instance opacity at step ${step}`);
    failures++;
    break;
  }
}

console.log(`  ${failures ? '✖' : '✔'} ${emitted} particles emitted and retired cleanly`);

// Every particle should also have actually expired by now.
const alive = system.life.filter((l) => l > 0).length;
console.log(`  ${alive === 0 ? '✔' : '✖'} all particles retired (${alive} still alive)`);
if (alive !== 0) failures++;

const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* ------------------------------------------------------------ ballistics */
// The contact patch is standing still on the road, but the tread above it is
// moving at twice the car's speed and flings water and grit off tangentially.
// Anything thrown from a tyre is therefore still travelling FORWARDS over the
// ground; it only trails the car because the car outruns it. Emitting it with
// a negative share of the car's velocity fires it away backwards at 15 m/s,
// which is the one thing that made spray and dust look fake.
console.log('\n=== thrown material travels forwards ===');

const run = (opts, steps, dt = 1 / 60) => {
  const sys = new ParticleSystem(texture, { count: 4 });
  sys.emit(new THREE.Vector3(0, 0.5, 0), { spread: 0, jitter: 0, ...opts });
  for (let i = 0; i < steps; i++) sys.update(dt, camera);
  return { z: sys.position[2], y: sys.position[1], vz: sys.velocity[2] };
};

const SPRAY = { velocity: new THREE.Vector3(0, 2, 30), life: 3, lift: -1.3, drag: 3.8, floor: 0 };
const near = run(SPRAY, 6);
const far = run(SPRAY, 30);
check('spray keeps moving forwards over the road', near.z > 0 && far.z > near.z,
  `z ${near.z.toFixed(2)} m → ${far.z.toFixed(2)} m`);
check('the air slows it down hard', far.vz < 30 * 0.5, `${far.vz.toFixed(1)} m/s left of 30`);

/* -------------------------------------------------- per-particle physics */
// One emitter has to carry a stone and the dust it kicks up at the same
// instant. They must not fly together.
console.log('\n=== one emitter, different ballistics ===');

const HOLD = { velocity: new THREE.Vector3(0, 0, 0), life: 3 };
const smoke = run({ ...HOLD, lift: 0.9, drag: 3.6 }, 60);
const mist = run({ ...HOLD, lift: -1.3, drag: 3.8 }, 60);
check('tyre smoke climbs, water mist sinks', smoke.y > 0.5 && mist.y < 0.5,
  `smoke ${smoke.y.toFixed(2)} m vs mist ${mist.y.toFixed(2)} m`);

const THROWN = { velocity: new THREE.Vector3(0, 0, 20), life: 3, floor: -50 };
const grit = run({ ...THROWN, lift: -9.4, drag: 0.32 }, 90);
const haze = run({ ...THROWN, lift: -0.5, drag: 3.0 }, 90);
check('heavy grit outruns the cloud it raises', grit.z > haze.z * 2.5,
  `grit ${grit.z.toFixed(1)} m vs haze ${haze.z.toFixed(1)} m`);
check('grit falls on a ballistic arc', grit.y < 0.4, `${grit.y.toFixed(2)} m`);

const settled = run({ ...THROWN, lift: -9.4, drag: 0.32, floor: 0 }, 90);
check('what falls back settles on the surface, not through it', settled.y === 0,
  `${settled.y.toFixed(3)} m`);

/* ---------------------------------------------------------- at the wheel */
// The same check one level up, where the sign actually lives.
console.log('\n=== tyre effects emit downstream of the car ===');

const wheel = (axle, side, surface) => ({
  grounded: true,
  contact: new THREE.Vector3(0, 0, 0),
  normal: new THREE.Vector3(0, 1, 0),
  surface,
  axle,
  side,
  slipSpeed: 4,
  tyre: { temp: 80 },
});

const drive = (surface, wetness) => {
  const vehicle = {
    speed: 50,
    velocity: new THREE.Vector3(0, 0, 50),
    quaternion: new THREE.Quaternion(),
    track: { wetness },
    wheels: [
      wheel('front', -1, surface), wheel('front', 1, surface),
      wheel('rear', -1, surface), wheel('rear', 1, surface),
    ],
  };
  const fx = new TyreEffects(
    new THREE.Scene(),
    { smoke: texture, skid: texture, spark: texture },
    { particles: 400 },
  );
  // Emission is rate-based and accumulated, so give it a few frames.
  for (let step = 0; step < 12; step++) fx.update(vehicle, 1 / 60, camera);

  let live = 0;
  let backwards = 0;
  let fastest = 0;
  for (let i = 0; i < fx.smoke.count; i++) {
    if (fx.smoke.life[i] <= 0) continue;
    live++;
    const vz = fx.smoke.velocity[i * 3 + 2];
    if (vz <= 0) backwards++;
    fastest = Math.max(fastest, vz);
  }
  return { live, backwards, fastest };
};

const rain = drive(0, 0.9);
check('a wet road throws spray', rain.live > 0, `${rain.live} particle(s)`);
check('no droplet is fired backwards', rain.backwards === 0, `${rain.backwards} of ${rain.live}`);
check('spray leaves the tread near car speed', rain.fastest > 25,
  `${rain.fastest.toFixed(1)} m/s of 50`);

const gravel = drive(3, 0);
check('a gravel trap throws stones and dust', gravel.live > 0, `${gravel.live} particle(s)`);
check('no stone is fired backwards', gravel.backwards === 0, `${gravel.backwards} of ${gravel.live}`);

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
