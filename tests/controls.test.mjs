/**
 * Pins the two things a driver notices before anything else: that "right"
 * steers right, and that the automatic can reverse.
 *
 * The body frame has +Z forward and +Y up, which in a right-handed world puts
 * the car's right at −X. Every internal sign was once consistent with the
 * opposite convention — the AI lapped happily — while the player's D key
 * turned the car left on screen. This test measures where the car actually
 * goes.
 *
 *   node tests/controls.test.mjs
 */

import * as THREE from 'three';

import { arc, straight } from '../src/track/Layout.js';
import { Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';

const DT = 1 / 120;
const track = new Track({
  name: 'Proving Ground',
  segments: [straight(4000, { width: 40 }), arc(300, 180, { width: 40 }), straight(4000, { width: 40 }), arc(300, 180, { width: 40 })],
});

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

function fresh() {
  const v = new Vehicle(CARS[0].spec, track);
  const s = 60;
  const i = track.indexAt(s);
  const t = new THREE.Vector3().fromArray(track.tangent, i * 3);
  v.reset(track.sampleAt(s, new THREE.Vector3()), Math.atan2(t.x, t.z));
  v.assists.autoReverse = true;
  return v;
}
const run = (v, c, seconds) => {
  for (let i = 0; i < seconds / DT; i++) v.update(DT, c);
};
/** Signed lateral displacement in the car's own starting frame: + is right. */
const rightOf = (v, origin, heading) => {
  const right = new THREE.Vector3(-1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  return new THREE.Vector3().subVectors(v.position, origin).dot(right);
};

/* ---------------------------------------------------------- steering ---- */
{
  const v = fresh();
  const origin = v.position.clone();
  const heading = Math.atan2(
    new THREE.Vector3(0, 0, 1).applyQuaternion(v.quaternion).x,
    new THREE.Vector3(0, 0, 1).applyQuaternion(v.quaternion).z,
  );
  run(v, { throttle: 1, brake: 0, steer: 0, handbrake: 0 }, 3);
  run(v, { throttle: 0.5, brake: 0, steer: 1, handbrake: 0 }, 1.5);
  const d = rightOf(v, origin, heading);
  check('positive steer moves the car to its right', d > 3, `${d.toFixed(1)} m`);

  const w = fresh();
  const o2 = w.position.clone();
  run(w, { throttle: 1, brake: 0, steer: 0, handbrake: 0 }, 3);
  run(w, { throttle: 0.5, brake: 0, steer: -1, handbrake: 0 }, 1.5);
  const d2 = rightOf(w, o2, heading);
  check('negative steer moves the car to its left', d2 < -3, `${d2.toFixed(1)} m`);

  // Left wheel is at +X in the body frame.
  check('wheel 0 (front-left) is mounted on the car\'s left', v.wheels[0].mount.x > 0, `x = ${v.wheels[0].mount.x.toFixed(2)}`);
}

/* ----------------------------------------------------------- reverse ---- */
{
  const v = fresh();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(v.quaternion);
  const origin = v.position.clone();

  run(v, { throttle: 0, brake: 1, steer: 0, handbrake: 0 }, 2.5);
  const back = new THREE.Vector3().subVectors(v.position, origin).dot(fwd);
  check('holding the brake at a standstill selects reverse', v.drivetrain.gear === -1, `gear ${v.drivetrain.gear}`);
  check('and the car backs up', back < -1.5 && v.forwardSpeed < -1, `${back.toFixed(1)} m, ${(v.forwardSpeed * 3.6).toFixed(0)} km/h`);

  run(v, { throttle: 0, brake: 0, steer: 0, handbrake: 0 }, 0.3);
  run(v, { throttle: 1, brake: 0, steer: 0, handbrake: 0 }, 3);
  check('throttle pulls away forward again', v.drivetrain.gear >= 1 && v.forwardSpeed > 5, `gear ${v.drivetrain.gear}, ${(v.forwardSpeed * 3.6).toFixed(0)} km/h`);
}

/* ------------------------------------------------ AI cars are unaffected -- */
{
  const v = fresh();
  v.assists.autoReverse = false;
  run(v, { throttle: 0, brake: 1, steer: 0, handbrake: 0 }, 2);
  check('brake alone never reverses a car without the assist', v.drivetrain.gear >= 1 && Math.abs(v.forwardSpeed) < 0.5, `gear ${v.drivetrain.gear}`);
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
