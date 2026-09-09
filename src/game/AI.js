import * as THREE from 'three';

import { approach as approachTo, clamp, damp, lerp, wrap, wrapDelta } from '../core/MathUtils.js';

const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * A computer-controlled driver.
 *
 * It drives the same physics as the player — no rails, no scripted speeds. The
 * controller has three parts: a pure-pursuit steering law aimed at a point
 * down the racing line, a speed target derived from the curvature it can see
 * ahead and the grip it believes it has, and a light avoidance term that
 * offsets its line when it finds a car alongside.
 *
 * `skill` (0..1) scales the grip it is willing to use, how far ahead it looks,
 * and how tidy its inputs are, so a field of AI cars has a natural spread.
 */
export class Driver {
  constructor(vehicle, track, { skill = 0.85, name = 'AI', aggression = 0.5 } = {}) {
    this.vehicle = vehicle;
    this.track = track;
    this.skill = clamp(skill, 0, 1);
    this.aggression = aggression;
    this.name = name;

    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.lineOffset = 0;
    this.targetOffset = 0;
    this.recoverTimer = 0;
    this.noisePhase = Math.random() * 100;
    this.q = {};
  }

  /**
   * @param {number} dt
   * @param {Array<{vehicle: import('../physics/Vehicle.js').Vehicle}>} rivals
   */
  update(dt, rivals = []) {
    const v = this.vehicle;
    const track = this.track;
    const speed = v.speed;

    const q = track.query(v.position.x, v.position.z, this.q);
    const s = q.s;

    // --- recovery: spun, stuck, or facing the wrong way -------------------
    _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
    const alongTrack = _fwd.x * q.tx + _fwd.z * q.tz;
    if (alongTrack < 0.15 || (speed < 2.5 && this.recoverTimer > 0)) {
      this.recoverTimer = Math.max(this.recoverTimer, 1.6);
    }
    if (speed < 1.6) this.recoverTimer += dt;
    else {
      this.stuckFor = Math.max(0, (this.stuckFor ?? 0) - dt * 2);
      if (this.recoverTimer > 0) this.recoverTimer -= dt * 0.6;
    }

    if (this.recoverTimer > 1.2) {
      return this.#recover(dt, q, alongTrack);
    }

    /* -- where to aim ------------------------------------------------------ */
    // Pure pursuit is only stable while the aim point stays inside the arc the
    // car can actually follow. Roughly half a second of travel is the classic
    // choice; much further and the car cuts corners and runs wide on exit.
    const lookahead = clamp(7 + speed * lerp(0.34, 0.46, this.skill), 9, 48);
    track.racingLineAt(s + lookahead, _target);

    // Offset the line to avoid whoever is alongside.
    this.targetOffset = this.#avoidance(rivals, s, q);
    this.lineOffset = damp(this.lineOffset, this.targetOffset, 2.2, dt);
    const i = track.indexAt(s + lookahead);
    _v.fromArray(track.lateral, i * 3);
    _target.addScaledVector(_v, this.lineOffset);

    /* -- steering: pure pursuit ------------------------------------------- */
    _v.subVectors(_target, v.position);
    _v.y = 0;
    const distance = Math.max(_v.length(), 0.5);
    _v.normalize();

    // Signed angle between where we point and where we want to go, positive
    // when the target is to the car's right (−X of its heading).
    const cross = _fwd.x * _v.z - _fwd.z * _v.x;
    const dot = clamp(_fwd.x * _v.x + _fwd.z * _v.z, -1, 1);
    const angle = Math.atan2(cross, dot);

    // Pure pursuit: the steer angle that puts the car on an arc through the
    // target point, converted into a normalised steering input.
    const curvature = (2 * Math.sin(angle)) / distance;
    let steer = Math.atan(curvature * v.spec.wheelbase) / v.spec.maxSteerAngle;

    // Counter-steer *into* a slide. The car's slip angle is positive when its
    // velocity points right of the nose, and the correction is to steer right
    // — the same sign. Getting this backwards turns every small slide into a
    // spin, which is exactly what it did.
    const slip = v.telemetry.slipAngle;
    if (Math.abs(slip) > 0.06) {
      steer += (slip - Math.sign(slip) * 0.06) * lerp(0.7, 1.25, this.skill);
    }

    // Only pull back toward the line once genuinely wide, and damp it with the
    // rate the car is already crossing the track — a proportional-only term
    // here weaves the car down the straights.
    // Track +lateral is the car's left when travelling forward, so being wide
    // on the +lateral side calls for right (positive) steer.
    const wide = q.lateral - track.lineOffset[track.indexAt(s)];
    const overshoot = Math.sign(wide) * Math.max(0, Math.abs(wide) - 2.2);
    const crossing = v.velocity.x * q.tz - v.velocity.z * q.tx; // rate toward +lateral
    steer += clamp(overshoot * 0.022 + crossing * 0.02, -0.22, 0.22);

    // A little input noise so the field does not look robotic.
    this.noisePhase += dt;
    steer += Math.sin(this.noisePhase * 1.7) * (1 - this.skill) * 0.02;

    // Everything above is in fractions of the rack's full lock. The rack only
    // offers a speed-dependent share of that, so rescale to what is actually
    // available — otherwise at speed the car gets a third of the angle the
    // driver asked for and runs wide.
    steer *= v.spec.maxSteerAngle / (v.steerLock || v.spec.maxSteerAngle);

    // Rate-limit the driver's hands: no human snaps from lock to lock in one
    // simulation step, and neither should this.
    const maxRate = lerp(2.2, 4.2, clamp(1 - speed / 70, 0, 1));
    this.controls.steer = approachTo(this.controls.steer, clamp(steer, -1, 1), maxRate * dt);

    /* -- speed target ------------------------------------------------------ */
    const targetSpeed = this.#speedTarget(s, speed);
    const error = targetSpeed - speed;

    // A dead band around the target stops the driver pumping the pedals, and
    // brake pressure is eased in rather than stamped on.
    if (error > 0.5) {
      this.controls.throttle = clamp(error * 0.35, 0, 1);
      this.controls.brake = 0;
    } else if (error < -0.8) {
      this.controls.throttle = 0;
      this.controls.brake = clamp((-error - 0.8) * 0.22, 0, 1);
    } else {
      this.controls.throttle = clamp(this.controls.throttle * 0.9, 0, 0.35);
      this.controls.brake = 0;
    }

    // Do not ask for full throttle while the car is still sideways.
    const slipCut = clamp(1 - (Math.abs(slip) - 0.11) * 3.4, 0.25, 1);
    this.controls.throttle *= slipCut;
    this.controls.handbrake = 0;

    return this.controls;
  }

  /**
   * The highest speed the car could hold through the tightest corner it can
   * see, working back from that with a braking model.
   */
  #speedTarget(s, speed) {
    const track = this.track;
    const v = this.vehicle;

    // Grip the driver is willing to use, in m/s². Well short of the 13-14 m/s²
    // the car can actually produce: a driver that plans to use every last
    // newton arrives at the apex with nothing left for mid-corner corrections.
    const lateralG = lerp(7.6, 10.4, this.skill);
    const brakingG = lerp(7.4, 10.2, this.skill);

    let best = 130;
    // Scan ahead as far as we could brake from the current speed.
    const horizon = clamp(30 + (speed * speed) / (2 * brakingG), 40, 420);
    const step = track.spacing * 2;

    for (let d = 0; d < horizon; d += step) {
      const i = track.indexAt(s + d);
      const k = Math.abs(track.lineCurvature[i]);

      // Downforce raises the cornering limit at speed.
      const aero = 1 + clamp((speed - 40) / 90, 0, 1) * 0.5;
      const corner = k > 1e-5 ? Math.sqrt((lateralG * aero) / k) : 140;

      // Speed we may carry here so that we can still slow to `corner`.
      const allowed = Math.sqrt(Math.max(0, corner * corner + 2 * brakingG * d));
      best = Math.min(best, allowed);
    }

    // Back off when running wide onto the marbles or off the circuit.
    const q = this.q;
    const surface = q.surface ?? 0;
    if (surface >= 3) best *= 0.65;

    return best;
  }

  /** Small lateral offsets to keep out of a rival's way, or to go past them. */
  #avoidance(rivals, s, q) {
    const v = this.vehicle;
    const track = this.track;
    let offset = 0;

    for (const other of rivals) {
      if (other === this.vehicle || other === this) continue;
      const ov = other.vehicle ?? other;
      if (ov === v) continue;

      const d = ov.position.distanceTo(v.position);
      if (d > 26) continue;

      const oq = track.query(ov.position.x, ov.position.z, {});
      const gap = wrapDelta(oq.s, s, track.length);

      // Only react to cars roughly alongside or just ahead.
      if (gap < -7 || gap > 22) continue;

      const lateralGap = oq.lateral - q.lateral;
      const urgency = clamp(1 - d / 26, 0, 1);
      // Move away from them, toward whichever side has more room.
      const dir = lateralGap > 0 ? -1 : 1;
      offset += dir * urgency * lerp(2.2, 3.6, this.aggression);
    }

    const limit = Math.max(0.5, q.width * 0.5 - 2.2);
    return clamp(offset, -limit, limit);
  }

  /**
   * Gets a stranded car going again.
   *
   * Most of the time the car is simply off the road facing the right way, and
   * all it needs is to drive back on. Reversing is reserved for actually being
   * pointed at a barrier. If neither works for long enough, the driver gives
   * up and rejoins at the racing line — the same thing the player's R key
   * does, and the only way to guarantee the field keeps circulating.
   */
  #recover(dt, q, alongTrack) {
    const v = this.vehicle;
    this.recoverTimer -= dt * 0.8;
    this.stuckFor = (this.stuckFor ?? 0) + (v.speed < 2 ? dt : -dt * 2);

    if (this.stuckFor > 7) {
      v.respawn();
      this.stuckFor = 0;
      this.recoverTimer = 0;
      this.lineOffset = 0;
      v.drivetrain.shiftTo(1);
      return this.controls;
    }

    const wrongWay = alongTrack < 0.15;
    const towardLine = clamp(q.lateral * 0.09, -1, 1); // +lateral is left: steer right

    if (wrongWay && v.speed < 6) {
      // Pointing the wrong way and slow: back up, steering to swing the nose
      // round toward the direction of travel.
      v.drivetrain.shiftTo(-1);
      this.controls.throttle = 0.5;
      this.controls.brake = 0;
      this.controls.steer = -towardLine;
    } else {
      if (v.drivetrain.gear < 0) v.drivetrain.shiftTo(1);
      this.controls.throttle = 0.42;
      this.controls.brake = 0;
      this.controls.steer = clamp(towardLine + (wrongWay ? Math.sign(towardLine || 1) * 0.6 : 0), -1, 1);
    }
    this.controls.handbrake = 0;

    if (this.recoverTimer <= 0 && v.drivetrain.gear < 0) v.drivetrain.shiftTo(1);
    return this.controls;
  }
}

/** A grid of AI drivers with a believable spread of pace. */
export function makeField(count, base = 0.86) {
  const names = [
    'Vasseur', 'Kaur', 'Moreau', 'Ibarra', 'Lindqvist', 'Okafor',
    'Tanaka', 'Ferreira', 'Novak', 'Bianchi', 'Haugen', 'Reyes',
  ];
  return Array.from({ length: count }, (_, i) => ({
    name: names[i % names.length],
    skill: clamp(base - i * 0.022 + (Math.random() - 0.5) * 0.03, 0.55, 0.99),
    aggression: clamp(0.35 + Math.random() * 0.5, 0, 1),
  }));
}
