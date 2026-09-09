/**
 * The pacing profile is what the arrows on the track show, so it had better
 * say "brake" before the hairpin, "accelerate" down the straight, and change
 * its mind in the rain.
 *
 *   node tests/pacing.test.mjs
 */

import { CIRCUITS } from '../src/track/Layout.js';
import { PHASE, Pacing } from '../src/track/Pacing.js';
import { Track } from '../src/track/Track.js';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const track = new Track(CIRCUITS[0]); // Apex International
const pacing = new Pacing(track);

// The hairpin (T5) is the slowest point; the back straight after it the
// fastest. Find them by name.
const at = (name) => {
  for (let i = 0; i < track.count; i++) if ((track.cornerName[i] ?? '').startsWith(name)) return i;
  return -1;
};
const hairpin = at('T5');
const backStraight = at('Back Straight');
check('found the hairpin and the back straight', hairpin > 0 && backStraight > 0);

const vHairpin = Math.min(...pacing.speed.slice(hairpin, hairpin + 30));
const vStraight = Math.max(...pacing.speed.slice(backStraight, backStraight + 250));
check('hairpin is slow', vHairpin * 3.6 < 90, `${(vHairpin * 3.6).toFixed(0)} km/h`);
check('back straight is fast', vStraight * 3.6 > 230, `${(vStraight * 3.6).toFixed(0)} km/h`);

// Walk back from the hairpin: the samples just before it must say BRAKE,
// and further back, on the approach straight, ACCELERATE.
const before = (n) => pacing.phase[(hairpin - n + track.count) % track.count];
check('says brake right before the hairpin', before(6) === PHASE.BRAKE, `phase ${before(6)}`);
check('says accelerate well before it', before(90) === PHASE.ACCELERATE, `phase ${before(90)}`);

// Zones, not flicker: count runs.
let runs = 1;
for (let i = 1; i < track.count; i++) if (pacing.phase[i] !== pacing.phase[i - 1]) runs++;
check('phases form zones', runs < 80, `${runs} zones over ${track.count} samples`);

// Braking distance grows in the rain.
const brakeRun = (p) => {
  let i = hairpin;
  let len = 0;
  while (p.phase[(i - 1 + track.count) % track.count] === PHASE.BRAKE && len < 400) {
    i--;
    len++;
  }
  return len * track.spacing;
};
const dryZone = brakeRun(pacing);
track.wetness = 1;
const wet = new Pacing(track);
const wetZone = brakeRun(wet);
// Grip scales both the stop and the arrival speed, so the zone grows only
// modestly — but it must grow.
check('braking zone lengthens in the wet', wetZone > dryZone * 1.05, `${dryZone.toFixed(0)} m dry → ${wetZone.toFixed(0)} m wet`);
check('and the hairpin gets slower', Math.min(...wet.speed.slice(hairpin, hairpin + 30)) < vHairpin * 0.95);

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
