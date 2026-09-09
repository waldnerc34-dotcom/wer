/**
 * Pins the chase camera through a held corner.
 *
 * It once rolled the stored up vector every frame and smoothed from the
 * rolled result, so a couple of degrees of lean compounded into the whole
 * view slowly turning over while steering. This drives a steady corner and
 * measures the camera's actual roll, and that it stays behind the car.
 *
 *   node tests/camera.test.mjs
 */

import * as THREE from 'three';

import { ChaseCamera } from '../src/game/Camera.js';
import { arc, straight } from '../src/track/Layout.js';
import { Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';

const DT = 1 / 60;
// A wide pad: a 45%-lock circle at 50 km/h is ~15 m in radius, and it has
// to fit on the tarmac with room to spare or the test measures wall strikes.
const track = new Track({
  name: 'Proving Ground',
  segments: [straight(4000, { width: 100 }), arc(300, 180, { width: 100 }), straight(4000, { width: 100 }), arc(300, 180, { width: 100 })],
});

const vehicle = new Vehicle(CARS[0].spec, track);
const i = track.indexAt(60);
const t = new THREE.Vector3().fromArray(track.tangent, i * 3);
vehicle.reset(track.sampleAt(60, new THREE.Vector3()), Math.atan2(t.x, t.z));

const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 5000);
const chase = new ChaseCamera(camera, track);
chase.reset(vehicle);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const UP = new THREE.Vector3(0, 1, 0);
const rollDeg = () => (Math.acos(Math.min(1, camera.up.dot(UP))) * 180) / Math.PI;
const behind = () => {
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(vehicle.quaternion);
  return new THREE.Vector3().subVectors(vehicle.position, camera.position).dot(fwd) > 0;
};

// Get up to speed, then hold a steady corner for eight seconds — long enough
// for any compounding to show — sampling the camera's roll as we go.
// Accelerate, brake down to ~50 km/h, then hold that speed through a corner
// at 45% lock — comfortably inside the tyres, so the car circles on the
// tarmac instead of arriving at twice the speed and sliding into the wall.
let maxRoll = 0;
let maxLat = 0;
let stayedBehind = true;
let impacts = 0;
let phase = 'accelerate';
let cornerFor = 0;
for (let step = 0; step < 16 * 60; step++) {
  if (phase === 'accelerate' && step > 3 * 60) phase = 'brake';
  if (phase === 'brake' && vehicle.speed < 13) phase = 'corner';

  const controls =
    phase === 'accelerate'
      ? { throttle: 1, brake: 0, steer: 0, handbrake: 0 }
      : phase === 'brake'
        ? { throttle: 0, brake: 1, steer: 0, handbrake: 0 }
        : { throttle: vehicle.speed < 14 ? 0.5 : 0, brake: 0, steer: 0.45, handbrake: 0 };

  vehicle.update(DT, controls);
  chase.update(vehicle, DT, 0);
  if (vehicle.lastImpact) {
    impacts++;
    vehicle.lastImpact = 0;
  }
  if (phase === 'corner') {
    cornerFor += DT;
    if (cornerFor > 2) {
      maxRoll = Math.max(maxRoll, rollDeg());
      maxLat = Math.max(maxLat, Math.abs(vehicle.telemetry.gForceLat));
      if (!behind()) stayedBehind = false;
    }
  }
}
check('the corner was held long enough to compound', cornerFor > 6, `${cornerFor.toFixed(1)} s`);

check('the car never touched a barrier', impacts === 0, `${impacts} impact(s)`);
// Between half a g and the tyres' limit: a real corner, and no telemetry spike.
check('the car was actually cornering', maxLat > 0.5 && maxLat < 2.5, `${maxLat.toFixed(2)} g lateral`);
check('camera roll stays a lean, never a rotation', maxRoll < 4, `max ${maxRoll.toFixed(2)}°`);
check('camera stays behind the car', stayedBehind);

// Straighten up: the lean must come back out.
for (let step = 0; step < 3 * 60; step++) {
  vehicle.update(DT, { throttle: 0.4, brake: 0, steer: 0, handbrake: 0 });
  chase.update(vehicle, DT, 0);
}
check('roll returns to level on the straight', rollDeg() < 1, `${rollDeg().toFixed(2)}°`);

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
