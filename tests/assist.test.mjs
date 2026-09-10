/**
 * Braking help, driven by someone who never brakes.
 *
 * The point of the assist is a player who can steer but has no idea where
 * the braking points are — which is everyone, on a circuit they have not
 * learned. So the test driver here holds the throttle flat for the whole
 * lap, steers with the planner, and never once touches the brake. With the
 * help on Full the car has to make it round; with it off, the same driver
 * has to fail, or the test is proving nothing.
 *
 *   node tests/assist.test.mjs
 */

import { Driver } from '../src/game/AI.js';
import { rampKeys } from '../src/core/Input.js';
import { ASSIST_LEVELS, DrivingAssist } from '../src/game/Assist.js';
import { pacingCar } from '../src/game/Game.js';
import { CIRCUITS } from '../src/track/Layout.js';
import { Pacing } from '../src/track/Pacing.js';
import { SURFACE, Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';

const DT = 1 / 120;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** A lap with the throttle pinned and the brake never touched. */
function flatOut(circuit, level, { car = CARS[0], seconds = 180 } = {}) {
  const track = new Track(circuit);
  const vehicle = new Vehicle(car.spec, track);
  Object.assign(vehicle.assists, { autoReverse: true });
  const grid = track.gridSlot(0);
  vehicle.reset(grid.position, grid.heading);

  const pacing = new Pacing(track, pacingCar(car.spec));
  const assist = new DrivingAssist(level);
  // The planner is only here to steer; its throttle and brake are ignored.
  const planner = new Driver(vehicle, track, { skill: 0.8 });
  planner.noisePhase = 0;
  const hands = { throttle: 0, brake: 0, steer: 0, handbrake: 0, steerHeld: 0, steerDir: 0 };

  const q = {};
  track.query(vehicle.position.x, vehicle.position.z, q);
  let offTrack = 0;
  let braked = 0;
  let lapTime = null;
  let progressed = 0;
  let lastS = null;

  for (let step = 0; step < seconds / DT; step++) {
    const plan = planner.update(DT, []);
    const keys = {
      throttle: true,
      brake: false,
      left: plan.steer < -0.08,
      right: plan.steer > 0.08,
    };
    const controls = { ...rampKeys(hands, keys, DT, vehicle.speedKph) };
    const demand = assist.apply(controls, { speed: vehicle.speed, s: q.s, pacing });
    if (demand > 0.05) braked += DT;
    vehicle.update(DT, controls);

    track.query(vehicle.position.x, vehicle.position.z, q);
    if (vehicle.wheels.every((w) => w.surface > SURFACE.KERB)) offTrack += DT;

    if (lastS !== null) {
      let d = q.s - lastS;
      if (d > track.length / 2) d -= track.length;
      if (d < -track.length / 2) d += track.length;
      progressed += d;
    }
    lastS = q.s;
    if (progressed >= track.length) {
      lapTime = step * DT;
      break;
    }
  }

  return { lapTime, offTrack, braked };
}

console.log('\n=== the levels ===');
check('four levels, Full first', ASSIST_LEVELS.length === 4 && ASSIST_LEVELS[0].id === 'high', ASSIST_LEVELS.map((a) => a.id).join(' → '));
check('every level is described', ASSIST_LEVELS.every((a) => a.label && a.note));

const idle = new DrivingAssist('high');
const controls = { throttle: 1, brake: 0 };
check('does nothing without a profile', idle.apply(controls, { speed: 50, s: 0, pacing: null }) === 0);
check('leaves the controls alone when it does nothing', controls.throttle === 1 && controls.brake === 0);
check('off is off', new DrivingAssist('off').active === false);
check('an unknown level is off, not a crash', new DrivingAssist('banana').level === 'off');

for (const circuit of CIRCUITS) {
  console.log(`\n=== ${circuit.name} — throttle pinned, driver never brakes ===`);
  const full = flatOut(circuit, 'high');
  const none = flatOut(circuit, 'off');

  console.log(
    `  full help: ${full.lapTime ? full.lapTime.toFixed(1) + ' s' : 'no lap'}, ${full.offTrack.toFixed(1)} s off, braking ${full.braked.toFixed(1)} s` +
      ` · no help: ${none.lapTime ? none.lapTime.toFixed(1) + ' s' : 'no lap'}, ${none.offTrack.toFixed(1)} s off`,
  );

  check('full help gets the lap done', full.lapTime !== null);
  check('full help keeps it on the circuit', full.offTrack < 6, `${full.offTrack.toFixed(1)} s off`);
  check('full help actually brakes', full.braked > 3, `${full.braked.toFixed(1)} s on the brakes`);
  // Without it the same driver must be visibly worse, or the help is a
  // placebo and the test is decoration.
  check(
    'without help the same driver is in trouble',
    none.lapTime === null || none.offTrack > full.offTrack + 3,
    none.lapTime === null ? 'never finished a lap' : `${none.offTrack.toFixed(1)} s off vs ${full.offTrack.toFixed(1)} s`,
  );
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
