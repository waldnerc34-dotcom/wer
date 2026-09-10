#!/usr/bin/env node
/**
 * Scripted handling manoeuvres on a wide synthetic oval: what a car does when
 * a keyboard driver taps, holds and releases the keys at speed, with the
 * driver aids on. Prints the steer, the stability control's counter-steer,
 * yaw rate, lateral g, body slip and both axles' slip angles every quarter
 * second, then a summary line per manoeuvre.
 *
 *   node tools/manoeuvres.mjs [carId] [tap,hold,flick,slam,lift,brake,exit,noesc,straight]
 *
 * A script returns either keys ({throttle, brake, left, right}), which go
 * through the keyboard ramps, or an analogue demand ({throttle, brake,
 * steer}) — a thumb on the touch pad or a stick, which can go to full lock
 * as fast as the rack will move.
 *
 * This is the tool the aids and the key ramps were tuned against: a tap
 * should be a nudge, a hold should settle at the car's limit without the
 * rear stepping out, and a release should straighten the car with no swing
 * back the other way.
 */
import * as THREE from 'three';
import { rampKeys } from '../src/core/Input.js';
import { arc, straight } from '../src/track/Layout.js';
import { Track } from '../src/track/Track.js';
import { CARS, Vehicle } from '../src/physics/Vehicle.js';

const DT = 1 / 120;
// Deliberately enormous. This is a test surface rather than a circuit, and it
// has to be wide enough that no car reaches the edge of it during a
// manoeuvre — a car that runs out of road is measuring the barrier rather
// than its own handling. A grand prix car at 190 km/h holding full lock pulls
// four and a half g and carves clean across an eighty-metre road, which is
// what the first version of this was, and every number it produced after that
// point was an impact.
const WIDTH = 260;
const OVAL = {
  id: 'oval', name: 'Test oval', hdri: 'x',
  segments: [
    straight(2400, { width: WIDTH }), arc(420, 180, { width: WIDTH }),
    straight(2400, { width: WIDTH }), arc(420, 180, { width: WIDTH }),
  ],
};
let track = null;
const oval = () => (track ??= new Track(OVAL));

class Hands {
  constructor() { this.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, steerHeld: 0, steerDir: 0 }; }
  update(keys, dt, speedKph) { return rampKeys(this.state, keys, dt, speedKph); }
}

function spawn(car, kph, assists = {}) {
  const track = oval();
  const v = new Vehicle(car.spec, track);
  Object.assign(v.assists, assists);
  // On the centreline 300 m down the straight, pointing along it.
  const i = track.indexAt(300);
  const p = new THREE.Vector3().fromArray(track.pos, i * 3);
  const fwd = new THREE.Vector3().fromArray(track.tangent, i * 3);
  v.reset(p, Math.atan2(fwd.x, fwd.z));
  v.velocity.copy(fwd).multiplyScalar(kph / 3.6);
  for (const w of v.wheels) w.omega = kph / 3.6 / w.radius;
  // Let the gearbox and suspension settle for a second, holding speed.
  const hands = new Hands();
  for (let i = 0; i < 120; i++) v.update(DT, hands.update({ throttle: true }, DT, v.speedKph));
  return { v, hands };
}

const yawRate = (v) => {
  const q = v.quaternion.clone().invert();
  return v.angularVelocity.clone().applyQuaternion(q).y;
};
const heading = (v) => {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(v.quaternion);
  return Math.atan2(f.x, f.z);
};
const deg = (r) => (r * 180) / Math.PI;
const row = (car, t, v, hands) => {
  const fa = (Math.abs(v.wheels[0].tyre.alpha) + Math.abs(v.wheels[1].tyre.alpha)) / 2;
  const ra = (Math.abs(v.wheels[2].tyre.alpha) + Math.abs(v.wheels[3].tyre.alpha)) / 2;
  const r = yawRate(v);
  const expected = (-v.forwardSpeed * Math.tan(v.effectiveSteer)) / car.spec.wheelbase;
  const escYaw = -(r - expected) * car.spec.escYawDamping * car.spec.inertia.yaw;
  return `${t.toFixed(2).padStart(5)}s v=${v.speedKph.toFixed(0).padStart(3)} key=${hands.state.steer.toFixed(2).padStart(5)} δ=${deg(v.steerAngle).toFixed(1).padStart(5)}° esc=${deg(v.escSteer).toFixed(1).padStart(5)}° eff=${deg(v.effectiveSteer).toFixed(1).padStart(5)}° yaw=${deg(r).toFixed(0).padStart(4)}°/s lat=${v.telemetry.gForceLat.toFixed(2).padStart(5)}g slip=${deg(v.telemetry.slipAngle).toFixed(1).padStart(5)}° fα=${deg(fa).toFixed(1).padStart(4)} rα=${deg(ra).toFixed(1).padStart(4)} escYaw=${(escYaw / 1000).toFixed(1).padStart(6)}kNm tc=${v.tcCut.toFixed(2)}`;
};

/**
 * Runs one scripted manoeuvre and returns its summary; prints the telemetry
 * unless `quiet`.
 */
export function run(car, label, kph, script, { every = 0.25, seconds = 4, assists = {}, quiet = false } = {}) {
  if (!quiet) console.log(`\n### ${label} — ${car.name}`);
  const { v, hands } = spawn(car, kph, assists);
  const h0 = heading(v);
  let peakSlip = 0, peakYaw = 0, minYaw = 0, peakLat = 0;
  let next = 0;
  for (let step = 0; step <= seconds / DT; step++) {
    const t = step * DT;
    const demand = script(t);
    const controls = hands.update(demand, DT, v.speedKph);
    // An analogue source sets the steer itself; the key ramp only shapes
    // throttle and brake.
    if (typeof demand.steer === 'number') controls.steer = demand.steer;
    v.update(DT, controls);
    const r = yawRate(v);
    if (t < 3.3) {
      peakSlip = Math.max(peakSlip, Math.abs(v.telemetry.slipAngle));
      peakYaw = Math.min(peakYaw, r); // right turn = negative yaw
      minYaw = Math.max(minYaw, r);
      peakLat = Math.max(peakLat, Math.abs(v.telemetry.gForceLat));
    }
    if (!quiet && t >= next - 1e-6) { console.log(row(car, t, v, hands)); next += every; }
  }
  let dh = heading(v) - h0;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  const summary = {
    headingDeg: deg(-dh), peakYawDeg: deg(-peakYaw), counterSwingDeg: deg(minYaw), peakLatG: peakLat, peakSlipDeg: deg(peakSlip),
  };
  if (!quiet) console.log(`  => heading change ${summary.headingDeg.toFixed(1)}° · peak yaw ${summary.peakYawDeg.toFixed(0)}°/s · counter-swing ${summary.counterSwingDeg.toFixed(0)}°/s · peak lat ${peakLat.toFixed(2)} g · peak slip ${summary.peakSlipDeg.toFixed(1)}°`);
  return summary;
}

/** The scripted manoeuvres, by name. */
export const MANOEUVRES = {
  tap: (kph) => [`tap right 0.2 s at ${kph} km/h, throttle held`, kph, (t) => ({ throttle: true, right: t >= 0.5 && t < 0.7 }), { seconds: 3 }],
  hold: (kph) => [`hold right 1.5 s at ${kph} km/h, throttle held`, kph, (t) => ({ throttle: true, right: t >= 0.5 && t < 2.0 }), { seconds: 4 }],
  lift: () => ['hold right, lift off mid-corner at 100 km/h', 100, (t) => ({ throttle: t < 1.5, right: t >= 0.5 && t < 3 }), { seconds: 4 }],
  brake: () => ['hold right + brake at 130 km/h', 130, (t) => ({ throttle: t < 0.5, brake: t >= 1.0 && t < 3, right: t >= 0.5 && t < 3 }), { seconds: 4 }],
  exit: () => ['slow corner exit: hold right at 55 km/h, full throttle', 55, (t) => ({ throttle: true, right: t >= 0.3 && t < 3.5 }), { seconds: 4 }],
  noesc: () => ['hold right 1.5 s at 100 km/h, stability OFF', 100, (t) => ({ throttle: true, right: t >= 0.5 && t < 2.0 }), { seconds: 4, assists: { stability: false } }],
  straight: () => ['straight, throttle only, 200 km/h', 200, () => ({ throttle: true }), { seconds: 3, every: 0.5 }],
  // A thumb on the touch pad, or a stick: straight to full lock, no ramp.
  flick: (kph) => [`thumb to full lock at ${kph} km/h, throttle held`, kph, (t) => ({ throttle: true, steer: t >= 0.5 && t < 2.0 ? 1 : 0 }), { seconds: 4 }],
  slam: () => ['thumb slammed full lock and back at 160 km/h', 160, (t) => ({ throttle: true, steer: t >= 0.5 && t < 1.1 ? 1 : t >= 1.1 && t < 1.6 ? -1 : 0 }), { seconds: 4 }],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const car = CARS.find((c) => c.id === (process.argv[2] ?? 'rosso')) ?? CARS[0];
  const which = process.argv[3] ?? 'all';
  const want = (k) => which === 'all' || which.split(',').includes(k);
  for (const [name, make] of Object.entries(MANOEUVRES)) {
    if (!want(name)) continue;
    const speeds = name === 'tap' || name === 'hold' || name === 'flick' ? [60, 100, 160] : [null];
    for (const kph of speeds) run(car, ...make(kph));
  }
}
