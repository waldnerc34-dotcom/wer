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

import { ParticleSystem } from '../src/render/Effects.js';

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
}

console.log(`  ${failures ? '✖' : '✔'} ${emitted} particles emitted and retired cleanly`);

// Every particle should also have actually expired by now.
const alive = system.life.filter((l) => l > 0).length;
console.log(`  ${alive === 0 ? '✔' : '✖'} all particles retired (${alive} still alive)`);
if (alive !== 0) failures++;

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
