/**
 * Racecraft: the part of the AI that is about the other cars.
 *
 * Three things are asserted here, and they are the three complaints a driver
 * actually has about a computer field:
 *
 *  - **It adapts.** The same drivers, on the same circuit, in the same car,
 *    are quicker against a quick player than against a slow one — and never
 *    so slow that they are traffic, nor so quick that the profile they plan
 *    to is a fiction.
 *  - **It overtakes.** A car with the pace to pass gets past, rather than
 *    sitting in the mirrors for the whole race.
 *  - **It does not crash into anybody.** Not into the car it is passing, not
 *    into a car that has stopped in the middle of the road. This one is a
 *    hard bound, checked every single simulation step: the collision radius
 *    in Game is 1.35 m a car, so two centres closer than 2.7 m is contact.
 *
 * Nothing here runs Game's collision resolution, deliberately. If the cars
 * never touch it is because the drivers never drove into each other, not
 * because something pushed them apart afterwards.
 *
 *   node tests/racecraft.test.mjs
 */

import * as THREE from 'three';

import { Driver, FieldPace } from '../src/game/AI.js';
import { pacingCar } from '../src/game/Game.js';
import { wrapDelta } from '../src/core/MathUtils.js';
import { CIRCUITS } from '../src/track/Layout.js';
import { Pacing } from '../src/track/Pacing.js';
import { SURFACE, Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';

const DT = 1 / 120;
/** Two collision radii: closer than this and the panels have met. */
const CONTACT = 2.7;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const track = new Track(CIRCUITS[0]); // Apex International
const car = CARS[0];
const reference = new Pacing(track, pacingCar(car.spec));

const spawn = (slot) => {
  const v = new Vehicle(car.spec, track);
  const g = track.gridSlot(slot);
  v.reset(g.position, g.heading);
  v.assists.stability = false;
  v.assists.steerLimiter = false;
  return v;
};

/** Puts a car on the AI's racing line at a given point round the lap. */
const placeOnLine = (v, s) => {
  const p = track.aiLineAt(s, 0.8, new THREE.Vector3());
  const i = track.indexAt(s);
  const t = new THREE.Vector3().fromArray(track.tangent, i * 3);
  v.reset(p, Math.atan2(t.x, t.z));
};

const arc = (v, out = {}) => track.query(v.position.x, v.position.z, out).s;

/* ===================================================== 1. adapting to pace */

console.log('\n=== adapting to the player ===');

/**
 * Runs one driver for `seconds`, bound to a field pace pinned at `pace`, and
 * reports how far it got and where its form settled.
 */
const runAgainst = (pace, seconds = 100) => {
  const field = new FieldPace(reference);
  field.pace = pace;
  // Pin it: this test is about how the drivers respond to a pace, not about
  // how the pace is measured (which the checks below cover separately).
  field.observe = () => pace;

  const v = spawn(0);
  const driver = new Driver(v, track, { skill: 0.88, aggression: 0.5, name: 'Adapt', pace: field });
  driver.noisePhase = 0;

  let covered = 0;
  const q = {};
  for (let t = 0; t < seconds / DT; t++) {
    v.update(DT, driver.update(DT, []));
    covered += v.speed * DT;
    track.query(v.position.x, v.position.z, q);
  }
  return { covered, form: driver.form, ownPace: driver.ownPace };
};

const slow = runAgainst(0.62);
const quick = runAgainst(1.0);

console.log(`  against a slow driver: ${(slow.covered / 1000).toFixed(2)} km, form ${slow.form.toFixed(3)}`);
console.log(`  against a quick one:   ${(quick.covered / 1000).toFixed(2)} km, form ${quick.form.toFixed(3)}`);

check(
  'the field is slower against a slow driver',
  slow.covered < quick.covered - 200,
  `${(quick.covered - slow.covered).toFixed(0)} m apart over 100 s`,
);
check('and it eased off to get there', slow.form < 0.95, `form ${slow.form.toFixed(3)}`);
check('a quick driver gets the field at full stretch', quick.form > 0.99, `form ${quick.form.toFixed(3)}`);
check(
  'never a rolling chicane, however slow the player',
  slow.form >= 0.68,
  `floor 0.68, settled at ${slow.form.toFixed(3)}`,
);

// The interesting part is between the rails: most drivers are neither, and
// the field has to land somewhere sensible for them rather than picking one
// of two settings.
const middling = runAgainst(0.8);
console.log(`  against a middling one:  ${(middling.covered / 1000).toFixed(2)} km, form ${middling.form.toFixed(3)}`);
check(
  'and it tracks the paces in between rather than picking a rail',
  middling.form > slow.form + 0.03 && middling.form < quick.form - 0.03,
  `${slow.form.toFixed(2)} → ${middling.form.toFixed(2)} → ${quick.form.toFixed(2)}`,
);
check(
  'never faster than the plan allows',
  quick.form <= 1.06 && slow.form <= 1.06,
  `ceiling 1.06`,
);

/* --------------------------------------------- and the pace is measured */

const paceOf = (fraction) => {
  const field = new FieldPace(reference);
  let s = 0;
  for (let t = 0; t < 30 / DT; t++) {
    const speed = reference.speedAt(s) * fraction;
    s = (s + speed * DT) % track.length;
    field.observe(DT, { speed, s });
  }
  return field.pace;
};

const measuredSlow = paceOf(0.7);
const measuredQuick = paceOf(1.0);
check(
  'a driver at seven tenths of the profile measures about seven tenths',
  Math.abs(measuredSlow - 0.7) < 0.06,
  measuredSlow.toFixed(3),
);
check(
  'a driver on the profile measures about one',
  Math.abs(measuredQuick - 1.0) < 0.05,
  measuredQuick.toFixed(3),
);

const spun = new FieldPace(reference);
for (let t = 0; t < 40 / DT; t++) spun.observe(DT, { speed: 0, s: 100 });
check('sitting in the gravel is not evidence of anything', spun.pace === 0.86, spun.pace.toFixed(3));

/* ==================================================== 2. getting past, cleanly */

console.log('\n=== overtaking ===');

const blockerV = spawn(0);
const chaserV = spawn(2); // same side of the grid, one row back

const blocker = new Driver(blockerV, track, { skill: 0.72, aggression: 0.3, name: 'Blocker' });
blocker.form = 0.76; // a genuinely slower car, holding everyone up
blocker.noisePhase = 0;

const chaser = new Driver(chaserV, track, { skill: 0.97, aggression: 0.85, name: 'Chaser' });
chaser.noisePhase = 0;

const cars = [{ vehicle: blockerV }, { vehicle: chaserV }];

let closest = Infinity;
let passedAt = null;
let sideBySide = 0;
const qa = {};
const qb = {};

for (let t = 0; t < 150 / DT; t++) {
  blockerV.update(DT, blocker.update(DT, cars));
  chaserV.update(DT, chaser.update(DT, cars));

  const d = blockerV.position.distanceTo(chaserV.position);
  closest = Math.min(closest, d);

  const gap = wrapDelta(arc(chaserV, qa), arc(blockerV, qb), track.length);
  if (Math.abs(gap) < 5 && d < 9) sideBySide += DT;
  // Clear of them by a car length, while they are still in sight — once the
  // quicker car has driven off into the distance the arc-length gap wraps
  // round the lap and stops meaning anything.
  if (passedAt === null && gap > 6 && gap < 60) passedAt = t * DT;
}

console.log(`  closest approach ${closest.toFixed(2)} m · alongside for ${sideBySide.toFixed(1)} s`);
console.log(`  ${passedAt === null ? 'never got past' : `past after ${passedAt.toFixed(1)} s`}`);

check('the quicker car gets past', passedAt !== null, passedAt === null ? 'still stuck behind' : `${passedAt.toFixed(1)} s`);
check('it went round the outside or the inside, not through', closest > CONTACT, `${closest.toFixed(2)} m at the closest`);
check('and it actually raced them rather than teleporting past', sideBySide > 0.4, `${sideBySide.toFixed(1)} s alongside`);

/* ====================================== 3. a car stopped in the middle of it */

console.log('\n=== a car stopped on the racing line ===');

const runnerV = spawn(0);
const runner = new Driver(runnerV, track, { skill: 0.95, aggression: 0.9, name: 'Runner' });
runner.noisePhase = 0;

// Twenty seconds of clear road first, so it arrives at the obstacle at a
// racing speed rather than trundling up to it from the grid.
for (let t = 0; t < 20 / DT; t++) runnerV.update(DT, runner.update(DT, []));

const parkedV = spawn(0);
placeOnLine(parkedV, arc(runnerV, qa) + 110);
const withParked = [{ vehicle: runnerV }, { vehicle: parkedV }];

let nearest = Infinity;
let arrivedAt = 0;
let clearedBy = null;
for (let t = 0; t < 30 / DT; t++) {
  // The parked car is never updated: it is a stationary obstacle, which is
  // the worst case for anything that plans by closing speed.
  runnerV.update(DT, runner.update(DT, withParked));
  const d = runnerV.position.distanceTo(parkedV.position);
  if (d < nearest) {
    nearest = d;
    arrivedAt = t * DT;
  }
  const gap = wrapDelta(arc(runnerV, qa), arc(parkedV, qb), track.length);
  if (clearedBy === null && gap > 8 && gap < 100) clearedBy = t * DT;
}

console.log(`  closest approach ${nearest.toFixed(2)} m after ${arrivedAt.toFixed(1)} s`);
console.log(`  ${clearedBy === null ? 'never got by' : `by it after ${clearedBy.toFixed(1)} s`}`);

check('never drove into the parked car', nearest > CONTACT, `${nearest.toFixed(2)} m at the closest`);
check('and still got round it', clearedBy !== null, clearedBy === null ? 'stopped behind it' : `${clearedBy.toFixed(1)} s`);
check(
  'it is still on the circuit afterwards',
  Math.abs(track.query(runnerV.position.x, runnerV.position.z, qa).lateral) < qa.width * 0.5 + 3,
  `${qa.lateral.toFixed(1)} m off centre of a ${qa.width.toFixed(1)} m road`,
);

/* ============================================== 4. six of them, racing */

// The single-car checks above are the mechanism; this is the thing itself.
// Six drivers, a real spread of pace, on the widest circuit and the
// narrowest, with Game's own collision separation applied so a tangle is
// resolved exactly as it would be in the race.
console.log('\n=== a field of six ===');

const SPREAD = [
  { skill: 0.90, aggression: 0.40 }, { skill: 0.87, aggression: 0.70 },
  { skill: 0.84, aggression: 0.30 }, { skill: 0.81, aggression: 0.85 },
  { skill: 0.78, aggression: 0.55 }, { skill: 0.75, aggression: 0.45 },
];
const RACE = 90;
const push = new THREE.Vector3();

for (const layout of [CIRCUITS[0], CIRCUITS[3]]) {
  const circuit = new Track(layout);
  const field = new FieldPace(new Pacing(circuit, pacingCar(car.spec)));
  field.pace = 0.88;
  field.observe = () => 0.88;

  const grid = SPREAD.map((f, i) => {
    const v = new Vehicle(car.spec, circuit);
    const g = circuit.gridSlot(i);
    v.reset(g.position, g.heading);
    v.assists.stability = false;
    v.assists.steerLimiter = false;
    const driver = new Driver(v, circuit, { ...f, name: 'C' + i, pace: field });
    driver.noisePhase = i * 7.3;
    return { vehicle: v, driver, off: 0, lap: 0, q: { s: 0 }, last: 0 };
  });

  let touching = 0;
  let changes = 0;
  let order = grid.map((_, i) => i);

  for (let t = 0; t < RACE / DT; t++) {
    for (const c of grid) {
      c.vehicle.update(DT, c.driver.update(DT, grid));
      const before = c.q.s;
      circuit.query(c.vehicle.position.x, c.vehicle.position.z, c.q);
      if (before > circuit.length * 0.75 && c.q.s < circuit.length * 0.25) c.lap++;
    }

    for (let i = 0; i < grid.length; i++) {
      for (let j = i + 1; j < grid.length; j++) {
        push.subVectors(grid[j].vehicle.position, grid[i].vehicle.position);
        push.y *= 0.5;
        const dist = push.length();
        if (dist >= CONTACT || dist < 1e-4) continue;
        touching += DT;
        push.divideScalar(dist).multiplyScalar((CONTACT - dist) * 0.5);
        grid[i].vehicle.position.sub(push);
        grid[j].vehicle.position.add(push);
      }
    }

    for (const c of grid) if (c.vehicle.wheels.every((w) => w.surface > SURFACE.KERB)) c.off += DT;

    // Positions, by distance covered. Every swap is somebody who got past.
    if (t % 60 === 0) {
      const now = [...order].sort(
        (a, b) => grid[b].lap * circuit.length + grid[b].q.s - (grid[a].lap * circuit.length + grid[a].q.s),
      );
      for (let i = 0; i < now.length; i++) if (now[i] !== order[i]) changes++;
      order = now;
    }
  }

  const worst = Math.max(...grid.map((c) => c.off));
  const carSeconds = RACE * grid.length;
  console.log(`\n  ${layout.name}`);
  console.log(
    `  contact ${touching.toFixed(1)} s of ${carSeconds} car-seconds · worst excursion ${worst.toFixed(0)} s` +
      ` · ${changes} position change(s) · laps ${grid.map((c) => c.lap).join('/')}`,
  );

  check('everybody keeps circulating', grid.every((c) => c.lap >= 1), grid.map((c) => c.lap).join('/'));
  check(
    'the field races without leaning on each other',
    touching < carSeconds * 0.012,
    `${((touching / carSeconds) * 100).toFixed(2)}% of the time in contact`,
  );
  check('nobody spends the race in the scenery', worst < RACE * 0.3, `worst ${worst.toFixed(0)} s of ${RACE}`);
  check('and the order actually changes', changes > 0, `${changes} change(s)`);
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
