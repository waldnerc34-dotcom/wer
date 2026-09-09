/**
 * Drives a lap the way a person on a keyboard does — full throttle, full
 * brake, full lock, each ramped exactly as the Input layer ramps a key — and
 * measures how much of the lap the car spends sideways.
 *
 * The AI is a smooth analogue driver and never suffers what a thumb or a
 * keyboard inflicts on a 600 hp rear-drive car. This is the test the driver
 * aids are tuned against.
 *
 *   node tests/handling.test.mjs
 */

import { Driver } from '../src/game/AI.js';
import { approach, clamp } from '../src/core/MathUtils.js';
import { CIRCUITS } from '../src/track/Layout.js';
import { SURFACE, Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';

const DT = 1 / 120;
const VERBOSE = process.argv.includes('--verbose');

/** Keyboard ramps, copied from Input so the test drives what the player drives. */
class KeyboardHands {
  constructor() {
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  }

  update(keys, dt, speedKph) {
    const s = this.state;
    s.throttle = approach(s.throttle, keys.throttle ? 1 : 0, dt * (keys.throttle ? 4.5 : 4));
    s.brake = approach(s.brake, keys.brake ? 1 : 0, dt * (keys.brake ? 7 : 12));
    const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const speedScale = clamp(1 - speedKph / 260, 0.3, 1);
    const rate = 3.2 * speedScale + 0.7;
    s.steer = dir
      ? approach(s.steer, dir * clamp(speedScale * 1.7, 0.45, 1), dt * rate)
      : approach(s.steer, 0, dt * 5.4);
    return s;
  }
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

export function driveLap(
  circuit,
  { assists = {}, seconds = 150, caps = {}, spec = {}, engine = {} } = {},
) {
  const track = new Track(circuit);
  // Optional overrides, for diagnosing which mechanism is doing the damage.
  const carSpec = { ...CARS[0].spec, ...spec, engine: { ...CARS[0].spec.engine, ...engine } };
  const vehicle = new Vehicle(carSpec, track);
  Object.assign(vehicle.assists, { autoReverse: true }, assists);
  const grid = track.gridSlot(0);
  vehicle.reset(grid.position, grid.heading);

  // The planner decides where to aim and how fast; the hands turn that into
  // keys: any real demand becomes a key held all the way down.
  const planner = new Driver(vehicle, track, { skill: 0.8 });
  // The driver adds a little random input noise for variety; a test wants
  // the same lap every time.
  planner.noisePhase = 0;
  const hands = new KeyboardHands();
  const q = {};

  let sideways = 0;
  let spins = 0;
  let wasSpun = false;
  let offTrack = 0;
  let maxSlip = 0;
  let lapTime = null;
  let lastS = null;
  let progressed = 0;

  for (let step = 0; step < seconds / DT; step++) {
    const plan = planner.update(DT, []);
    const keys = {
      throttle: plan.throttle > 0.15,
      brake: plan.brake > 0.15,
      left: plan.steer < -0.08,
      right: plan.steer > 0.08,
    };
    const controls = { ...hands.update(keys, DT, vehicle.speedKph) };
    if (caps.throttle !== undefined) controls.throttle = Math.min(controls.throttle, caps.throttle);
    if (caps.brake !== undefined) controls.brake = Math.min(controls.brake, caps.brake);
    if (caps.steer !== undefined) controls.steer = clamp(controls.steer, -caps.steer, caps.steer);
    vehicle.update(DT, controls);

    track.query(vehicle.position.x, vehicle.position.z, q);
    const slip = Math.abs(vehicle.telemetry.slipAngle);
    maxSlip = Math.max(maxSlip, slip);
    if (vehicle.speed > 5 && slip > 0.14) sideways += DT; // > 8°
    const spun = slip > 0.7;
    if (spun && !wasSpun) spins++;
    wasSpun = spun;
    if (vehicle.wheels.every((w) => w.surface > SURFACE.KERB)) offTrack += DT;

    // Lap progress by arc length, so a spin cannot fake a lap.
    if (lastS !== null) {
      let d = q.s - lastS;
      if (d > track.length / 2) d -= track.length;
      if (d < -track.length / 2) d += track.length;
      progressed += d;
    }
    lastS = q.s;
    if (lapTime === null && progressed >= track.length) lapTime = step * DT;
    if (lapTime !== null) break;
  }

  return { lapTime, sideways, spins, offTrack, maxSlipDeg: (maxSlip * 180) / Math.PI, track };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const circuit of CIRCUITS) {
    const r = driveLap(circuit);
    console.log(`\n=== ${circuit.name} — keyboard driver, all aids on ===`);
    console.log(
      `  lap ${r.lapTime ? r.lapTime.toFixed(1) + ' s' : 'not completed'} · sideways ${r.sideways.toFixed(1)} s · spins ${r.spins} · off-track ${r.offTrack.toFixed(1)} s · max slip ${r.maxSlipDeg.toFixed(0)}°`,
    );
    check('completed the lap', r.lapTime !== null);
    check('never spun', r.spins === 0, `${r.spins} spin(s)`);
    // Bang-bang inputs will always scrub a little; what matters is that it
    // never becomes a slide the driver has to catch.
    check('rarely sideways', r.sideways < 12, `${r.sideways.toFixed(1)} s past 8° of body slip`);
    check('never a real slide', r.maxSlipDeg < 20, `peak ${r.maxSlipDeg.toFixed(0)}°`);
    check('stayed on the circuit', r.offTrack < 8, `${r.offTrack.toFixed(1)} s off`);
  }
  console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
  process.exit(failures ? 1 : 0);
}
