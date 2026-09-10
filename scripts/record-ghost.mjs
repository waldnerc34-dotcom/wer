#!/usr/bin/env node
/**
 * Drives a flying lap of every circuit and writes it out as a ghost.
 *
 * No graphics are involved. The simulation is the same code the game runs —
 * the same tyre model, the same aerodynamics, the same driver — just stepped
 * as fast as the machine can manage with nothing drawing, which is a few
 * hundred times quicker than real time. That is what makes it possible to
 * ship a lap to race against without anybody having sat and driven one.
 *
 * The first lap out of the pits is thrown away: it starts from a standstill on
 * the grid and is worth nothing as a benchmark. The lap recorded is the one
 * after it, flying start to flying finish.
 *
 *   node scripts/record-ghost.mjs [--only apex] [--car f175]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Driver } from '../src/game/AI.js';
import { GhostRecorder } from '../src/game/Ghost.js';
import { LapTimer } from '../src/game/Timing.js';
import { CIRCUITS } from '../src/track/Layout.js';
import { Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets', 'ghosts');
const DT = 1 / 120;

const arg = (name) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null;
const ONLY = arg('--only');
const CARS_WANTED = (arg('--car') ?? 'rosso,f175').split(',');

/** How good the driver is. High, but not beyond what a person could match. */
const SKILL = 0.95;

/**
 * Records one flying lap.
 *
 * @returns {{bytes: Uint8Array, lap: number}|null}
 */
function record(circuit, car, pace = 1) {
  const track = new Track(circuit);
  // `pace` scales what the driver believes the car will do. A ghost has to be
  // a clean lap, so a lap that puts a wheel off is thrown away and driven
  // again more slowly rather than shipped as something to chase.
  const spec = pace === 1 ? car.spec : { ...car.spec, aiGrip: (car.spec.aiGrip ?? 1) * pace };
  const vehicle = new Vehicle(spec, track);
  // The same rack a computed driver gets in a race: it catches its own slides
  // rather than being caught by the assists a keyboard player is given.
  vehicle.assists.stability = false;
  vehicle.assists.steerLimiter = false;

  const grid = track.gridSlot(0);
  vehicle.reset(grid.position, grid.heading);

  const driver = new Driver(vehicle, track, { skill: SKILL, aggression: 0.5, name: 'Ghost' });
  // The driver wanders a little on purpose, for variety between opponents. A
  // recorded lap wants the line it actually meant to take.
  driver.noisePhase = 0;

  const timer = new LapTimer(track);
  const field = [{ vehicle, q: {}, isPlayer: false }];
  let recorder = null;
  let query = {};
  let offTrack = 0;

  // Long enough for a standing lap plus a flying one on the slowest car round
  // the longest circuit, and no longer.
  for (let step = 0; step < 600 / DT; step++) {
    const controls = driver.update(DT, field);
    vehicle.update(DT, controls);
    query = track.query(vehicle.position.x, vehicle.position.z, query);
    field[0].q = query;

    const before = timer.lap;
    timer.update(DT, query.s, false);

    if (timer.lap !== before) {
      // Crossed the line. The out-lap ends here and the recording starts; the
      // next crossing ends it.
      if (recorder) {
        if (offTrack > 0.15) return null; // not a lap worth chasing
        const bytes = recorder.finish(timer.lastLap);
        return bytes ? { bytes, lap: timer.lastLap, samples: recorder.samples.length } : null;
      }
      recorder = new GhostRecorder(grid.position);
      offTrack = 0;
    }

    if (recorder) {
      // The racing definition of off: all four wheels beyond the kerb.
      if (vehicle.wheels.every((w) => w.surface > 2)) offTrack += DT;
      recorder.update(DT, vehicle);
    }
  }
  return null;
}

await mkdir(OUT, { recursive: true });
let total = 0;

for (const circuit of CIRCUITS) {
  if (ONLY && circuit.id !== ONLY) continue;
  for (const carId of CARS_WANTED) {
    const car = CARS.find((c) => c.id === carId);
    if (!car) {
      console.log(`  ${carId}: no such car`);
      continue;
    }
    const started = Date.now();
    // Back off until the lap is clean. A car the planner cannot quite hold on
    // one circuit should still leave a ghost, just a slightly slower one.
    let result = null;
    let pace = 1;
    for (const attempt of [1, 0.94, 0.88, 0.82, 0.75]) {
      pace = attempt;
      result = record(circuit, car, attempt);
      if (result) break;
    }
    if (!result) {
      console.log(`  ${circuit.name} · ${car.name}: no clean lap at any pace`);
      continue;
    }
    const name = `${circuit.id}-${car.id}.bin`;
    await writeFile(join(OUT, name), result.bytes);
    total += result.bytes.length;
    const m = Math.floor(result.lap / 60);
    const s = (result.lap - m * 60).toFixed(3);
    console.log(
      `  ${name.padEnd(28)} ${m}:${s.padStart(6, '0')}  ` +
        `${result.samples} samples  ${(result.bytes.length / 1024).toFixed(1)} KB  ` +
        `(${((Date.now() - started) / 1000).toFixed(1)}s to drive${pace < 1 ? `, at ${(pace * 100).toFixed(0)}% pace` : ''})`,
    );
  }
}

console.log(`\n✔ ${(total / 1024).toFixed(0)} KB of ghosts`);
