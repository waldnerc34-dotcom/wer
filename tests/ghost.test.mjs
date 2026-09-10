/**
 * Ghosts: the format, the replay, and whether the shipped laps are any good.
 *
 * The last of those is the one that matters. A ghost is something the player
 * is invited to chase, so a ghost that cuts a corner, puts two wheels in the
 * gravel or drives a line nobody could follow is worse than no ghost at all —
 * and none of that is visible from the file. So every lap that ships is
 * replayed here against the circuit it was driven on and checked, sample by
 * sample, for where it actually put the car.
 *
 *   node tests/ghost.test.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';

import { GhostPlayer, GhostRecorder, decodeGhost, ghostFromText, ghostToText } from '../src/game/Ghost.js';
import { CIRCUITS } from '../src/track/Layout.js';
import { Track } from '../src/track/Track.js';
import { CARS } from '../src/physics/Vehicle.js';

const GHOSTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'ghosts');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* --------------------------------------------------------------- the file */

console.log('\n=== a lap survives being written down ===');

const origin = { x: 1200.5, y: 4.25, z: -800.75 };
const samples = [];
for (let i = 0; i < 400; i++) {
  const a = i * 0.02;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, 0));
  samples.push({
    x: Math.sin(a) * 300,
    y: 0.31 + Math.sin(a * 7) * 0.04,
    z: 300 - Math.cos(a) * 300,
    qx: q.x,
    qy: q.y,
    qz: q.z,
    qw: q.w,
    omega: 150,
    steer: -0.06,
  });
}

// Fed at the rate the game runs at, not the rate the recorder samples at:
// the two are deliberately different and the gap between them is where a
// recorder gets its timing wrong.
const rec = new GhostRecorder(origin, { hz: 10 });
for (let step = 0; step < samples.length * 6; step++) {
  const s = samples[Math.min(samples.length - 1, Math.floor(step / 6))];
  rec.update(1 / 60, {
    position: { x: origin.x + s.x, y: origin.y + s.y, z: origin.z + s.z },
    quaternion: { x: s.qx, y: s.qy, z: s.qz, w: s.qw },
    wheels: [{ steer: s.steer }, {}, { omega: s.omega }, {}],
  });
}
const bytes = rec.finish(94.321);

const trace = decodeGhost(bytes);
check('it decodes', Boolean(trace), `${bytes.length} bytes, ${trace?.count} samples`);
check('at ten samples a second', trace.count > 380 && trace.count < 420, `${trace.count}`);
check('the lap time is kept exactly', Math.abs(trace.lapTime - 94.321) < 0.001);
check(
  'it is under twenty bytes a sample',
  bytes.length / trace.count < 20,
  `${(bytes.length / trace.count).toFixed(1)} B`,
);

// Positions are quantised to a tenth of a metre on the ground; the round trip
// is checked directly rather than against the feed, whose sampling phase is
// not something the format promises to preserve.
{
  const rec = new GhostRecorder({ x: 0, y: 0, z: 0 }, { hz: 10 });
  const exact = [];
  for (let i = 0; i < 60; i++) {
    const p = { x: i * 3.333 + 0.07, y: 0.317, z: -i * 1.111 - 0.04 };
    exact.push(p);
    rec.update(0.1, { position: p, quaternion: { x: 0, y: 0, z: 0, w: 1 }, wheels: [{}, {}, {}, {}] });
  }
  const back = decodeGhost(rec.finish(30));
  let worst = 0;
  for (let i = 0; i < back.count; i++) {
    worst = Math.max(
      worst,
      Math.hypot(back.x[i] - exact[i].x, back.z[i] - exact[i].z),
      Math.abs(back.y[i] - exact[i].y),
    );
  }
  check('positions come back within a tenth of a metre', worst < 0.1, `${(worst * 100).toFixed(1)} cm`);
}

check('base64 survives the trip', Boolean(ghostFromText(ghostToText(bytes))?.count));

/* -------------------------------------------------------------- the replay */

console.log('\n=== the replay runs forwards and stops at the end ===');
{
  const player = new GhostPlayer(trace);
  const out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const previous = new THREE.Vector3();
  const steps = [];
  let first = true;

  const end = trace.count / trace.hz;
  for (let t = 0; t <= end; t += 1 / 60) {
    player.at(t, out);
    if (!first) steps.push(out.position.distanceTo(previous));
    previous.copy(out.position);
    first = false;
  }

  // Against the replay's own pace rather than a number picked in advance: a
  // ghost at 216 km/h covers a metre a frame, so "a metre" means nothing on
  // its own. What would be visible is one frame moving several times as far
  // as its neighbours, which is what a gap or a repeated sample looks like.
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const biggest = sorted[sorted.length - 1];
  check(
    'no frame moves further than its neighbours',
    biggest < median * 3,
    `worst ${biggest.toFixed(2)} m against a typical ${median.toFixed(2)} m`,
  );
  // "Backwards" is measured against the path itself rather than against an
  // axis: each frame's movement is compared with the direction the recorded
  // line runs at that point, so this holds for any shape of circuit and does
  // not depend on knowing where the corner's centre is.
  let backwards = 0;
  const here = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  for (let t = 1 / 60; t <= end; t += 1 / 60) {
    player.at(t - 1 / 60, out);
    here.copy(out.position);
    player.at(t, out);
    const moved = ahead.copy(out.position).sub(here);
    if (moved.lengthSq() < 1e-10) continue;
    const i = Math.min(trace.count - 2, Math.floor(t * trace.hz));
    const tangent = new THREE.Vector3(
      trace.x[i + 1] - trace.x[i],
      0,
      trace.z[i + 1] - trace.z[i],
    );
    if (tangent.lengthSq() > 1e-10 && moved.dot(tangent) < 0) backwards++;
  }
  check('it never runs backwards', backwards === 0, `${backwards} frame(s)`);

  player.at(end + 30, out);
  const held = out.position.clone();
  player.at(end + 120, out);
  check('past the end it holds still', held.distanceTo(out.position) < 0.001);
  check('and says it has finished', player.finished === true);

  player.at(0, out);
  check('at zero it is on the first sample', Math.abs(out.position.x - trace.x[0]) < 0.001);
}

/* ------------------------------------------------------- the shipped laps */

console.log('\n=== every lap that ships is a clean one ===');

const files = (await readdir(GHOSTS).catch(() => [])).filter((f) => f.endsWith('.bin')).sort();
check('there are ghosts to race', files.length > 0, `${files.length} lap(s)`);

const tracks = new Map();
for (const file of files) {
  const [circuitId, carId] = file.replace('.bin', '').split('-');
  const circuit = CIRCUITS.find((c) => c.id === circuitId);
  const car = CARS.find((c) => c.id === carId);
  if (!circuit || !car) {
    check(`${file} names a circuit and a car that exist`, false, `${circuitId} / ${carId}`);
    continue;
  }
  if (!tracks.has(circuitId)) tracks.set(circuitId, new Track(circuit));
  const track = tracks.get(circuitId);
  const lap = decodeGhost(new Uint8Array(await readFile(join(GHOSTS, file))));

  let offTrack = 0;
  let worstStep = 0;
  let covered = 0;
  let lastS = null;
  const q = {};
  for (let i = 0; i < lap.count; i++) {
    // The car is a couple of metres wide, so the centre being on the apron is
    // fine; beyond that is not.
    const surface = track.query(lap.x[i], lap.z[i], q).surface;
    if (surface > 2) offTrack++;
    if (i > 0) {
      worstStep = Math.max(
        worstStep,
        Math.hypot(lap.x[i] - lap.x[i - 1], lap.z[i] - lap.z[i - 1]),
      );
    }
    if (lastS !== null) {
      let step = q.s - lastS;
      if (step < -track.length / 2) step += track.length;
      if (step > 0) covered += step;
    }
    lastS = q.s;
  }

  const speed = worstStep * lap.hz * 3.6;
  const ok =
    offTrack === 0 &&
    covered > track.length * 0.9 &&
    lap.lapTime > 20 &&
    speed < 400;
  check(
    `${file.padEnd(22)} ${fmt(lap.lapTime)}`,
    ok,
    `${lap.count} samples · ${offTrack} off · ${(covered / track.length * 100).toFixed(0)}% of the lap · peak ${speed.toFixed(0)} km/h`,
  );
}

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
