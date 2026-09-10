/**
 * The race itself: the procedure at the start, the distance in the middle,
 * the flag at the end — and the props beside all of it.
 *
 *   node tests/race.test.mjs
 */

import { RACE_LENGTHS, RaceControl } from '../src/game/RaceControl.js';
import { Props } from '../src/track/Props.js';
import { terrainHeightAt } from '../src/track/TrackBuilder.js';
import { CIRCUITS } from '../src/track/Layout.js';
import { Track } from '../src/track/Track.js';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* ================================================== the start procedure */

console.log('\n=== lights out ===');

const DT = 1 / 120;
/** Runs a start and records what the driver would have seen. */
const runStart = (random = () => 0.5) => {
  const race = new RaceControl({ laps: 5, standing: true, random });
  const seen = [];
  let heldUntil = 0;
  for (let t = 0; t < 10; t += DT) {
    race.update(DT);
    if (race.holding) heldUntil = race.time;
    const last = seen[seen.length - 1];
    if (!last || last.callout !== race.callout || last.lamps !== race.lamps) {
      seen.push({ at: race.time, callout: race.callout, lamps: race.lamps, phase: race.phase });
    }
  }
  return { race, seen, heldUntil };
};

const { race, seen, heldUntil } = runStart();
console.log(
  '  ' +
    seen
      .filter((s) => s.callout || s.lamps)
      .map((s) => `${s.at.toFixed(1)}s ${s.callout ?? '·'}(${s.lamps})`)
      .join('  '),
);

/** Successive distinct values of one field, in order. */
const runOf = (field) =>
  seen
    .map((s) => s[field])
    .filter((v) => v !== null && v !== 0)
    .filter((v, i, a) => v !== a[i - 1]);

check('it counts three, two, one, go', runOf('callout').join(',') === '3,2,1,GO', runOf('callout').join(','));
check(
  'the lamps fill up one at a time',
  runOf('lamps').join(',') === '1,2,3,4,5',
  runOf('lamps').join(','),
);
check('and all go out together at the release', race.lamps === 0);
check(
  'nobody moves until they do',
  Math.abs(heldUntil - race.releaseAt) < DT * 2,
  `held to ${heldUntil.toFixed(2)} s, released at ${race.releaseAt.toFixed(2)} s`,
);
check('and everybody is racing after it', race.phase === 'racing' && !race.holding);

// The pause before lights out is what makes a start a reaction rather than a
// memorised count. It has to actually vary, and it has to be brief.
const holds = [0, 0.25, 0.5, 0.75, 0.999].map((r) => new RaceControl({ random: () => r }).releaseAt);
check(
  'the pause before lights out is never the same twice',
  Math.max(...holds) - Math.min(...holds) > 0.7,
  `${Math.min(...holds).toFixed(2)}–${Math.max(...holds).toFixed(2)} s`,
);
check('but never long enough to be a wait', Math.max(...holds) - Math.min(...holds) < 1.5);

// A reaction time is only a reaction time if it is measured from the release.
const quick = new RaceControl({ random: () => 0.5 });
for (let t = 0; t < 10; t += DT) {
  quick.update(DT);
  quick.noteLaunch(!quick.holding && quick.time > quick.releaseAt + 0.2);
}
check(
  'the launch is timed from the lights, not the lap',
  quick.reaction !== null && Math.abs(quick.reaction - 0.2) < 0.05,
  `${quick.reaction?.toFixed(3)} s`,
);

const rolling = new RaceControl({ laps: 0, standing: false });
rolling.update(DT);
check('a time trial has no grid procedure', !rolling.holding && rolling.callout === null);

/* ========================================================== the distance */

console.log('\n=== the distance ===');

check('every offered distance is a whole number of laps', RACE_LENGTHS.every((r) => Number.isInteger(r.id) && r.id > 0), RACE_LENGTHS.map((r) => r.id).join('/'));

const flag = new RaceControl({ laps: 3, standing: false });
const field = [
  { name: 'You', isPlayer: true, laps: 2, distance: 2 * 4000 + 900, best: 71.2 },
  { name: 'Kaur', laps: 2, distance: 2 * 4000 + 1400, best: 70.9 },
  { name: 'Moreau', laps: 2, distance: 2 * 4000 + 300, best: 72.6 },
];
check('the flag stays in while the distance is unfinished', !flag.check(field));

field[1].laps = 3;
field[1].distance = 3 * 4000 + 20;
check('and comes out the moment somebody completes it', flag.check(field));
check('the winner is the one who did', flag.classification[0].name === 'Kaur');
check(
  'and everyone else is classified where they were',
  flag.classification.map((c) => c.name).join(',') === 'Kaur,You,Moreau',
  flag.classification.map((c) => `${c.position} ${c.name}`).join(' · '),
);
check('the flag only falls once', !flag.check(field) && flag.finished);

/* ============================================================== the props */

console.log('\n=== what is beside the circuit ===');

/** Plans a circuit's props without loading a single byte of geometry. */
const planFor = async (layout, density = 1) => {
  const track = new Track(layout);
  const props = new Props(track, { density });
  await props.build({ instance: async () => { throw new Error('headless'); } });
  return { track, props };
};

for (const layout of CIRCUITS) {
  const { track, props } = await planFor(layout);
  const all = [...props.placements.values()].flat();

  // The one thing that must never happen: a cottage on the racing line.
  let closest = Infinity;
  for (const p of all) {
    closest = Math.min(closest, terrainHeightAt(track, p.position.x, p.position.z, {}).edge);
  }

  console.log(`  ${layout.name.padEnd(22)} ${String(all.length).padStart(4)} props · nearest ${closest.toFixed(0)} m from the edge`);
  check(`${layout.id}: the circuit is actually dressed`, all.length > 60, `${all.length} props`);
  check(`${layout.id}: nothing is on the road or in the run-off`, closest >= 12, `${closest.toFixed(1)} m clear`);
  check(
    `${layout.id}: cars are parked in the paddock`,
    (props.placements.get('models/props/car.glb')?.length ?? 0) > 10,
    `${props.placements.get('models/props/car.glb')?.length ?? 0} parked`,
  );

  // Never the race cars. Those are fifty to a hundred primitives apiece, and
  // a car park's worth of them is several hundred draw calls sitting on the
  // main straight — which is the difference between a scene that renders and
  // one that cannot finish a frame.
  check(
    `${layout.id}: and none of them are race cars`,
    ![...props.placements.keys()].some((k) => k.startsWith('models/cars/')),
  );
}

// Same circuit, same paddock — a layout that moves between sessions is a
// layout nobody can learn.
const a = await planFor(CIRCUITS[0]);
const b = await planFor(CIRCUITS[0]);
const flatten = (p) => [...p.placements.entries()].map(([k, v]) => `${k}:${v.map((x) => x.position.x.toFixed(2)).join()}`).join('|');
check('the same circuit is laid out the same way every time', flatten(a.props) === flatten(b.props));

const sparse = await planFor(CIRCUITS[0], 0.35);
check(
  'and a phone gets meaningfully fewer of them',
  sparse.props.count < a.props.count * 0.72,
  `${sparse.props.count} against ${a.props.count}`,
);

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
