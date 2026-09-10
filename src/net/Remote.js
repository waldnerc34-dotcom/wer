import * as THREE from 'three';

import { clamp } from '../core/MathUtils.js';

const _q = new THREE.Quaternion();

/**
 * How far behind live a remote car is drawn, in milliseconds.
 *
 * This is the one number that decides whether multiplayer feels smooth or
 * feels like lag, and the two pull in opposite directions. Draw a car at the
 * newest snapshot you have and you are guessing about the present: every late
 * packet is a stutter and every early one a jump. Draw it slightly in the past
 * and you always have a snapshot on either side of the moment you want, so the
 * motion is exact and continuous — at the cost of seeing the car where it was
 * a tenth of a second ago.
 *
 * A tenth of a second at 200 km/h is five and a half metres, which sounds
 * ruinous and is not: both cars are drawn under the same rule on both screens,
 * so side by side down a straight neither driver can tell. It only shows in
 * contact, and contact is decided locally anyway.
 *
 * The delay is set from the connection rather than fixed, so a good one is
 * quicker to respond and a bad one still never stutters.
 */
const MIN_DELAY = 60;
const MAX_DELAY = 260;

/** Snapshots kept per car — six seconds at 20 Hz, far more than needed. */
const BUFFER = 120;

/** How long to keep guessing after the last snapshot before giving up. */
const EXTRAPOLATE_MS = 220;

/**
 * The stream of snapshots for one remote car, and the answer to "where is it
 * right now".
 */
export class Interpolator {
  constructor() {
    this.buffer = [];
    this.newestSeq = -1;
    this.delay = 120;
    this.jitter = 0;
    this.gap = 50;
    this.lastArrival = 0;
    this.extrapolating = false;
    this.stale = true;
    // The moment being drawn, which is not simply `now - delay`: see sample().
    this.renderTime = null;
    this.lastSample = null;
  }

  /**
   * Files a snapshot.
   *
   * @param {object} state decoded snapshot; `t` is on the sender's clock
   * @param {number} offset milliseconds to add to the sender's clock to get
   *                        this machine's
   * @param {number} now local clock
   */
  push(state, offset, now) {
    // Out of order. The newer snapshot already on the buffer says everything
    // this one would have, so it goes in the bin rather than rewinding the car.
    if (state.seq <= this.newestSeq) return;

    // How irregularly packets are arriving, which is what the delay has to
    // cover. Measured on arrival rather than on the stamps inside, because it
    // is the arrival that has to be smoothed over.
    if (this.lastArrival) {
      const since = now - this.lastArrival;
      this.gap += (since - this.gap) * 0.08;
      this.jitter += (Math.abs(since - this.gap) - this.jitter) * 0.12;
    }
    this.lastArrival = now;
    this.newestSeq = state.seq;
    this.stale = false;

    // One packet interval to have something on the far side, plus room for
    // the connection's own unevenness.
    this.delay = clamp(this.gap * 1.35 + this.jitter * 2.5, MIN_DELAY, MAX_DELAY);

    this.buffer.push({ ...state, at: state.t + offset });
    if (this.buffer.length > BUFFER) this.buffer.shift();
  }

  /**
   * Samples the car's transform at a moment.
   *
   * @param {number} now local clock
   * @param {object} out `{position, quaternion, velocity}` to write into
   * @returns {boolean} false when there is nothing to draw yet
   */
  sample(now, out) {
    const buf = this.buffer;
    if (!buf.length) return false;

    // The playout clock, and why it is not just `now - delay`.
    //
    // The delay is re-estimated on every packet, and it grows the moment a
    // connection gets worse. Subtracting a growing delay from the wall clock
    // moves the moment being drawn *backwards*, and a car drawn at an earlier
    // moment than the frame before is a car that visibly reverses — a twitch
    // on every burst of jitter, which is the exact fault this whole buffer
    // exists to prevent.
    //
    // So the playout clock is its own clock. It only ever runs forwards, and
    // it runs slightly fast or slightly slow until it has caught up with what
    // the delay is asking for. The car never reverses; it is briefly shown a
    // few milliseconds off where it might have been, which nobody can see.
    const elapsed = this.lastSample === null ? 0 : Math.max(0, now - this.lastSample);
    this.lastSample = now;
    const target = now - this.delay;
    if (this.renderTime === null || Math.abs(target - this.renderTime) > 1000) {
      // First frame, or the stream stopped long enough that catching up
      // gradually would take longer than anyone would wait.
      this.renderTime = target;
    } else {
      const drift = target - this.renderTime;
      this.renderTime += elapsed * clamp(1 + drift * 0.004, 0.9, 1.25);
    }
    const want = this.renderTime;

    // Drop snapshots that are older than the one before the one we want, so
    // the buffer stays short without ever losing the pair being interpolated.
    while (buf.length > 2 && buf[1].at <= want) buf.shift();

    const newest = buf[buf.length - 1];
    if (want >= newest.at) {
      // Nothing has arrived for the moment being drawn. Carry the car on at
      // the velocity it last reported — briefly, because a car that keeps
      // going on a guess ends up in the scenery.
      const ahead = Math.min(want - newest.at, EXTRAPOLATE_MS) / 1000;
      this.extrapolating = want - newest.at > 4;
      out.position.set(
        newest.x + newest.vx * ahead,
        newest.y + newest.vy * ahead,
        newest.z + newest.vz * ahead,
      );
      out.quaternion.set(newest.qx, newest.qy, newest.qz, newest.qw).normalize();
      out.velocity.set(newest.vx, newest.vy, newest.vz);
      out.state = newest;
      return true;
    }

    this.extrapolating = false;
    const oldest = buf[0];
    if (want <= oldest.at) {
      // Still filling the buffer: sit on the oldest thing we have rather than
      // guessing backwards.
      out.position.set(oldest.x, oldest.y, oldest.z);
      out.quaternion.set(oldest.qx, oldest.qy, oldest.qz, oldest.qw).normalize();
      out.velocity.set(oldest.vx, oldest.vy, oldest.vz);
      out.state = oldest;
      return true;
    }

    let i = buf.length - 1;
    while (i > 0 && buf[i - 1].at > want) i--;
    const b = buf[i];
    const a = buf[i - 1];
    const span = b.at - a.at;
    const f = span > 0 ? clamp((want - a.at) / span, 0, 1) : 1;

    out.position.set(
      a.x + (b.x - a.x) * f,
      a.y + (b.y - a.y) * f,
      a.z + (b.z - a.z) * f,
    );
    out.quaternion.set(a.qx, a.qy, a.qz, a.qw).normalize();
    _q.set(b.qx, b.qy, b.qz, b.qw).normalize();
    out.quaternion.slerp(_q, f);
    out.velocity.set(
      a.vx + (b.vx - a.vx) * f,
      a.vy + (b.vy - a.vy) * f,
      a.vz + (b.vz - a.vz) * f,
    );
    out.state = f < 0.5 ? a : b;
    return true;
  }
}

/**
 * A car somebody else is driving.
 *
 * It carries a real `Vehicle` so that everything downstream — the rig, the
 * tyre effects, the slipstream, the collision solver — can treat it exactly
 * like any other car on the circuit. The physics is never stepped: the driver
 * whose car it is has already done that on their own machine, and the results
 * arrive over the wire. All this does is put the transform where the network
 * says, and then read the ground under the wheels so the wheels sit on it.
 */
export class RemoteCar {
  /**
   * @param {import('../physics/Vehicle.js').Vehicle} vehicle
   * @param {object} peer `{id, name, carId}`
   */
  constructor(vehicle, peer) {
    this.vehicle = vehicle;
    this.id = peer.id;
    this.name = peer.name;
    this.carId = peer.carId;
    this.interpolator = new Interpolator();
    this.offset = 0;
    this.lap = 0;
    this.bestLap = null;
    this.progress = 0;
    this.visible = false;
    this.sample = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      state: null,
    };
  }

  /** @param {number} offset sender clock → local clock, milliseconds */
  push(state, offset, now) {
    this.offset = offset;
    this.interpolator.push(state, offset, now);
  }

  /**
   * Draws the car at `now`.
   *
   * @returns {boolean} whether there was anything to draw
   */
  update(dt, now) {
    if (!this.interpolator.sample(now, this.sample)) {
      this.visible = false;
      return false;
    }
    const v = this.vehicle;
    v.position.copy(this.sample.position);
    v.quaternion.copy(this.sample.quaternion);
    v.velocity.copy(this.sample.velocity);

    const s = this.sample.state;
    if (s) {
      v.controls.throttle = s.throttle;
      v.controls.brake = s.brake;
      v.controls.steer = s.steer / (v.spec.maxSteerAngle || 1);
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        w.omega = s.omega;
        w.steer = i < 2 ? s.steer : 0;
        w.slipSpeed = s.slip;
      }
    }
    // The wheels find their own ground: the surface under a car is the same
    // on every machine, so there is no reason to send it and every reason not
    // to — a locally probed contact patch is exactly right rather than a
    // tenth of a second stale.
    v.settle(dt);
    this.visible = true;
    return true;
  }
}
