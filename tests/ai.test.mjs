/**
 * Drives the AI around each circuit, headless, at the simulation's own rate.
 *
 * This exercises the whole loop end to end — track query, suspension, tyres,
 * driveline, the driver's speed and steering laws, and lap timing — without a
 * renderer, so it can run in CI.
 *
 *   node tests/ai.test.mjs
 */

import { Driver } from '../src/game/AI.js';
import { LapTimer, formatLap } from '../src/game/Timing.js';
import { CIRCUITS } from '../src/track/Layout.js';
import { Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';
import { SURFACE } from '../src/track/Track.js';
import * as THREE from 'three';

const DT = 1 / 120;
const LAPS = 2;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

for (const circuit of CIRCUITS) {
  const track = new Track(circuit);
  const car = CARS[0];

  const vehicle = new Vehicle(car.spec, track);
  const start = track.gridSlot(0);
  vehicle.reset(start.position, start.heading);

  const driver = new Driver(vehicle, track, { skill: 0.92, name: 'Test' });
  const timer = new LapTimer(track);

  let maxSpeed = 0;
  let offTrackTime = 0;
  let stuckTime = 0;
  const budget = 60 * 8; // eight minutes of simulated time, ample for two laps

  const q = {};
  for (let t = 0; t < budget / DT && timer.lap <= LAPS; t++) {
    const controls = driver.update(DT, []);
    vehicle.update(DT, controls);
    track.query(vehicle.position.x, vehicle.position.z, q);
    const off = vehicle.wheels.every((w) => w.surface > SURFACE.KERB);
    timer.update(DT, q.s, off);

    maxSpeed = Math.max(maxSpeed, vehicle.speedKph);
    if (off) offTrackTime += DT;
    if (vehicle.speed < 2) stuckTime += DT;
  }

  const clean = timer.laps.filter((l) => !l.invalid);
  const best = clean.length ? Math.min(...clean.map((l) => l.time)) : null;
  const avgSpeed = best ? (track.length / best) * 3.6 : 0;

  console.log(`\n=== ${circuit.name} — ${(track.length / 1000).toFixed(2)} km ===`);
  console.log(
    `  laps ${timer.laps.map((l) => formatLap(l.time) + (l.invalid ? '*' : '')).join('  ')}`,
  );
  console.log(
    `  best ${best ? formatLap(best) : '—'} · avg ${avgSpeed.toFixed(0)} km/h · top ${maxSpeed.toFixed(0)} km/h`,
  );
  console.log(`  off-track ${offTrackTime.toFixed(1)} s · stationary ${stuckTime.toFixed(1)} s`);

  check('completed the required laps', timer.laps.length >= LAPS, `${timer.laps.length} recorded`);
  check('never got stuck', stuckTime < 4, `${stuckTime.toFixed(1)} s below 2 km/h`);
  check('stayed on the circuit', offTrackTime < 12, `${offTrackTime.toFixed(1)} s with wheels off`);
  check('reached a racing speed', maxSpeed > 180, `${maxSpeed.toFixed(0)} km/h`);
  check(
    'lap times are consistent',
    clean.length >= 1 && (clean.length < 2 || Math.abs(clean[0].time - clean[1].time) < 12),
    clean.length >= 2 ? `${(clean[1].time - clean[0].time).toFixed(2)} s apart` : 'one clean lap',
  );
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
