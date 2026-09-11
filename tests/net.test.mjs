/**
 * The netcode, without a network.
 *
 * Everything here is the part of multiplayer that cannot be seen when it goes
 * wrong: a quantisation that loses a degree of yaw, a buffer that plays
 * snapshots back out of order, an interpolator that runs a car backwards for
 * one frame when a packet is late. On screen all of those look like "lag", and
 * none of them can be found by looking. So they are measured instead — against
 * a simulated connection with real jitter, real loss and real reordering.
 *
 *   node tests/net.test.mjs
 */

import * as THREE from 'three';

import { pack, peek, unpack } from '../src/net/Direct.js';
import { Interpolator } from '../src/net/Remote.js';
import { KIND, SNAPSHOT_BYTES, readState, writeState } from '../src/net/Snapshot.js';
import { Sync } from '../src/net/Sync.js';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* ------------------------------------------------------------ the wire */

console.log('\n=== a car survives the trip ===');

const view = new DataView(new ArrayBuffer(SNAPSHOT_BYTES));
const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.13, 2.41, -0.06));
const sent = {
  seq: 70123,
  t: 1234567,
  x: -812.4471,
  y: 13.2065,
  z: 4109.8823,
  qx: q.x,
  qy: q.y,
  qz: q.z,
  qw: q.w,
  vx: -61.42,
  vy: 0.37,
  vz: 18.09,
  steer: -0.317,
  omega: 189.4,
  throttle: 0.72,
  brake: 0,
  slip: 11,
  surface: 3,
  grounded: true,
};
writeState(view, 0, sent);
const got = readState(view, 0);

check('the packet is one datagram', SNAPSHOT_BYTES <= 1200, `${SNAPSHOT_BYTES} bytes`);
check('it says it is a car', view.getUint8(0) === KIND.STATE);
check('sequence and stamp are exact', got.seq === sent.seq && got.t === sent.t);
check(
  'position is millimetre-accurate',
  ['x', 'y', 'z'].every((k) => Math.abs(got[k] - sent[k]) < 0.001),
  ['x', 'y', 'z'].map((k) => (got[k] - sent[k]).toExponential(1)).join(' '),
);

// Yaw is the one that shows: a car a degree out of line looks wrong even when
// it is in exactly the right place.
const back = new THREE.Quaternion(got.qx, got.qy, got.qz, got.qw).normalize();
const degrees = (2 * Math.acos(Math.min(1, Math.abs(back.dot(q)))) * 180) / Math.PI;
check('orientation is within a hundredth of a degree', degrees < 0.01, `${degrees.toFixed(4)}°`);

check(
  'velocity is within a centimetre a second',
  ['vx', 'vy', 'vz'].every((k) => Math.abs(got[k] - sent[k]) <= 0.01),
);
check('steering is within half a degree', Math.abs(got.steer - sent.steer) < 0.009);
check('surface and contact survive', got.surface === 3 && got.grounded === true);
check('pedals survive', Math.abs(got.throttle - 0.72) < 0.005 && got.brake === 0);

/* -------------------------------------------------- the moving picture */

// One car at 50 m/s, sending 20 times a second, going round a 200 m radius
// corner. A curve rather than a straight, deliberately: linear interpolation
// reproduces a straight line exactly, so a straight would measure nothing.
// On a curve the interpolator has to cut the corner between snapshots, and
// how much it cuts is the accuracy actually on offer.
const HZ = 20;
const SPEED = 50;
const RADIUS = 200;
const OMEGA = SPEED / RADIUS; // rad/s round the circle

const truthAt = (t) => {
  const a = (t / 1000) * OMEGA;
  return { x: RADIUS * Math.sin(a), z: RADIUS * (1 - Math.cos(a)), a };
};

/** Distance from where the car really was at `t`. */
const errorAt = (t, x, z) => {
  const p = truthAt(t);
  return Math.hypot(x - p.x, z - p.z);
};

const snapshotAt = (seq, t) => {
  const p = truthAt(t);
  const heading = p.a;
  return {
    seq,
    t,
    x: p.x,
    y: 0,
    z: p.z,
    qx: 0,
    qy: Math.sin(-heading / 2),
    qz: 0,
    qw: Math.cos(-heading / 2),
    vx: SPEED * Math.cos(p.a),
    vy: 0,
    vz: SPEED * Math.sin(p.a),
    steer: 0.04,
    omega: 0,
    throttle: 1,
    brake: 0,
    slip: 0,
    surface: 0,
    grounded: true,
  };
};

/**
 * Angle round the circle, as a measure of progress along the road.
 *
 * Unwrapped against the previous reading: atan2 jumps by a whole turn as the
 * car passes the far side, and taking that at face value would report the
 * circumference as a teleport.
 */
let arcLast = null;
const arc = (p) => {
  let a = Math.atan2(p.x, RADIUS - p.z);
  if (arcLast !== null) {
    while (a - arcLast > Math.PI) a -= Math.PI * 2;
    while (a - arcLast < -Math.PI) a += Math.PI * 2;
  }
  arcLast = a;
  return a;
};

const out = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  velocity: new THREE.Vector3(),
  state: null,
};

/**
 * Runs a connection and reports how the car looked.
 *
 * @param {object} link  loss 0..1; jitter ± milliseconds; reorder 0..1
 */
function drive({ loss = 0, jitter = 0, reorder = 0, seconds = 40, seed = 5 } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const interp = new Interpolator();
  arcLast = null;
  const inbox = [];
  let worstError = 0;
  let backwards = 0;
  let gaps = 0;
  let last = null;
  let drawn = 0;

  const frames = seconds * 60;
  for (let f = 0; f < frames; f++) {
    const now = (f / 60) * 1000;

    // The sender's tick.
    const seq = Math.floor(now / (1000 / HZ));
    if (seq !== drive.lastSeq) {
      drive.lastSeq = seq;
      const t = seq * (1000 / HZ);
      if (rand() > loss) {
        const wobble = (rand() - 0.5) * 2 * jitter;
        const late = reorder > 0 && rand() < reorder ? 1000 / HZ : 0;
        inbox.push({ snap: snapshotAt(seq, t), at: now + 30 + wobble + late });
      }
    }

    // Everything that has arrived by now, in arrival order — which after
    // jitter and reordering is not the order it was sent in.
    for (let i = inbox.length - 1; i >= 0; i--) {
      if (inbox[i].at <= now) {
        interp.push(inbox[i].snap, 0, now);
        inbox.splice(i, 1);
      }
    }

    if (!interp.sample(now, out)) continue;
    drawn++;

    // Where the car really was at the moment being drawn. The first second is
    // not counted: the buffer is still filling and the delay still settling,
    // and every connection is allowed to start somewhere.
    const shown = arc(out.position);
    if (now > 1500) {
      worstError = Math.max(
        worstError,
        errorAt(interp.renderTime, out.position.x, out.position.z),
      );
    }

    if (last !== null && now > 1500) {
      // Progress round the circle, so "backwards" means backwards along the
      // road rather than backwards along an axis.
      const step = shown - last;
      if (step < -1e-6) backwards++;
      // A car at 50 m/s covers 0.83 m per frame. Anything over four times
      // that is a jump the eye would catch.
      if (Math.abs(step * RADIUS) > (SPEED / 60) * 4) gaps++;
    }
    last = shown;
  }
  return { worstError, backwards, gaps, drawn, delay: interp.delay };
}

console.log('\n=== a clean connection ===');
let r = drive({ jitter: 0 });
check('the car is drawn every frame', r.drawn > 40 * 60 - 40, `${r.drawn} frames`);
check('it never goes backwards', r.backwards === 0);
check('it never jumps', r.gaps === 0);
check('it is where it should be', r.worstError < 0.02, `worst ${(r.worstError * 1000).toFixed(1)} mm off the true line`);

console.log('\n=== 40 ms of jitter ===');
r = drive({ jitter: 40 });
check('it never goes backwards', r.backwards === 0, `${r.backwards} frame(s)`);
check('it never jumps', r.gaps === 0, `${r.gaps} frame(s)`);
check('it stays accurate', r.worstError < 0.05, `worst ${(r.worstError * 1000).toFixed(1)} mm`);
check('the delay grew to cover it', r.delay > 70, `${r.delay.toFixed(0)} ms`);

console.log('\n=== 20% packet loss ===');
r = drive({ loss: 0.2, jitter: 25 });
check('it never goes backwards', r.backwards === 0, `${r.backwards} frame(s)`);
check('it never jumps', r.gaps === 0, `${r.gaps} frame(s)`);
check('it stays accurate', r.worstError < 0.4, `worst ${(r.worstError * 1000).toFixed(0)} mm`);

console.log('\n=== packets arriving out of order ===');
r = drive({ reorder: 0.25, jitter: 30 });
check('it never goes backwards', r.backwards === 0, `${r.backwards} frame(s)`);
check('it never jumps', r.gaps === 0, `${r.gaps} frame(s)`);

console.log('\n=== a connection that dies mid-corner ===');
{
  const interp = new Interpolator();
  for (let seq = 0; seq < 20; seq++) {
    const t = seq * (1000 / HZ);
    interp.push(snapshotAt(seq, t), 0, t + 30);
  }
  const lastT = 19 * (1000 / HZ);
  const known = truthAt(lastT);
  let travelled = 0;
  for (let ms = 0; ms <= 4000; ms += 100) {
    interp.sample(lastT + 30 + ms, out);
    travelled = Math.hypot(out.position.x - known.x, out.position.z - known.z);
  }
  check(
    'the car coasts on and then stops, rather than flying away',
    travelled < SPEED * 0.3,
    `${travelled.toFixed(1)} m past its last known position after 4 s`,
  );
  check('it did coast, rather than freezing on the spot', travelled > 1, `${travelled.toFixed(1)} m`);
}

console.log('\n=== a snapshot that overtakes a newer one ===');
{
  const interp = new Interpolator();
  interp.push(snapshotAt(10, 500), 0, 530);
  interp.push(snapshotAt(11, 550), 0, 580);
  const before = interp.buffer.length;
  interp.push(snapshotAt(9, 450), 0, 590); // the straggler
  check('it is dropped rather than rewinding the car', interp.buffer.length === before);
}

/* -------------------------------------------------------------- clocks */

console.log('\n=== telling the time on somebody else\'s clock ===');
{
  // Their clock is 8 400 ms ahead of ours, the link is 40 ms each way, and
  // one measurement in three is stuck behind something for an extra 200.
  const TRUE_OFFSET = -8400;
  const sync = new Sync();
  let s = 11;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 24; i++) {
    const queued = rand() < 0.34 ? 200 * rand() : 0;
    const rtt = 80 + queued;
    // What the round trip would have measured, given where the delay fell.
    const skew = queued * (rand() < 0.5 ? 0.5 : -0.5);
    sync.add(TRUE_OFFSET + skew, rtt);
  }
  check(
    'the estimate ignores the slow samples',
    Math.abs(sync.offset - TRUE_OFFSET) < 12,
    `${sync.offset.toFixed(1)} ms against ${TRUE_OFFSET}`,
  );
  check('the round trip is the quickest seen', sync.rtt < 90, `${sync.rtt.toFixed(0)} ms`);
}

/* -------------------------------------------- an introduction by hand */

console.log('\n=== a handshake somebody can send in a message ===');
{
  // A real offer from Chrome, trimmed to the parts that matter: it is the
  // repetitiveness of this — the same fingerprint, the same addresses, the
  // same attribute names — that makes it worth compressing before anybody is
  // asked to paste it anywhere.
  const sdp = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:7ZqT',
    'a=ice-pwd:FpB1t0Ks0sHCvYn2VxD1yYqz',
    'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    ...Array.from({ length: 8 }, (_, i) =>
      `a=candidate:${842163049 + i} 1 udp 1677729535 203.0.113.${i} ${50000 + i} typ srflx raddr 192.168.1.${i} rport ${40000 + i} generation 0 ufrag 7ZqT network-cost 10`),
  ].join('\r\n');

  const code = await pack({ v: 1, t: 'o', id: 'AbCdEfGhIjKl', room: 'QWERT', sdp });
  check('the code is safe in a URL', /^APEX1-[A-Za-z0-9\-_]+$/.test(code), `${code.length} characters`);
  check('it is much shorter than what it carries', code.length < sdp.length * 0.6, `${code.length} against ${sdp.length}`);

  const back = await unpack(code);
  check('the session description survives exactly', back?.sdp === sdp);
  check('so does who sent it', back?.id === 'AbCdEfGhIjKl' && back?.room === 'QWERT');

  // People paste links, not codes, and they paste them with a stray newline
  // or a wrapped line from a chat app.
  const asLink = `https://example.com/wer/#i=${code}`;
  check('a whole link works as well as the code', (await unpack(asLink))?.sdp === sdp);
  const mangled = code.slice(0, 90) + '\n  ' + code.slice(90);
  check('so does one a chat app wrapped', (await unpack(mangled))?.sdp === sdp);

  check('the room is readable without opening a connection', (await peek(code))?.room === 'QWERT');
  const reply = await pack({ v: 1, t: 'a', id: 'ZzZz', sdp });
  check('a reply is not mistaken for an invite', (await peek(reply)) === null);

  check('nonsense is refused rather than thrown', (await unpack('hello')) === null);
  check('a truncated code is refused too', (await unpack(code.slice(0, code.length - 40))) === null);
  check('an empty box is refused', (await unpack('')) === null);
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
