import * as THREE from 'three';

import { approach, clamp, lerp, sign } from '../core/MathUtils.js';
import { SURFACE_DRAG } from '../track/Track.js';
import { Tyre, TYRE_SPECS } from './TireModel.js';
import { Drivetrain, V8_NA, V10_TT } from './Drivetrain.js';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const SUBSTEP = 1 / 240;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _f = new THREE.Vector3();
const _l = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** One corner of the car: strut, hub, brake and tyre. */
class Wheel {
  constructor(spec, side, axle) {
    this.side = side; // -1 left, +1 right
    this.axle = axle; // 'front' | 'rear'
    this.steered = axle === 'front';
    this.driven = axle === 'rear' || spec.drivetrainLayout === 'awd';

    const s = axle === 'front' ? spec.front : spec.rear;
    // Body frame: +Z forward, +Y up — so the car's right is −X, and the left
    // wheel (side −1) sits at +X.
    this.mount = new THREE.Vector3(
      (-side * s.track) / 2,
      spec.restLength + (s.radius - spec.cogHeight),
      axle === 'front' ? spec.cogToFrontAxle : -spec.cogToRearAxle,
    );

    this.radius = s.radius;
    this.springRate = s.springRate;
    this.bumpDamping = s.bumpDamping;
    this.reboundDamping = s.reboundDamping;
    this.antiRoll = s.antiRoll;
    this.maxBrakeTorque = s.maxBrakeTorque;
    this.restLength = spec.restLength;
    this.maxTravel = spec.maxTravel;

    this.tyre = new Tyre({ ...TYRE_SPECS[axle], radius: s.radius });

    this.reset();
  }

  reset() {
    this.length = this.restLength;
    this.prevLength = this.restLength;
    this.omega = 0;
    this.steer = 0;
    this.spin = 0; // visual rotation angle
    this.grounded = false;
    this.load = 0;
    this.compression = 0;
    this.surface = 0;
    this.contact = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.worldPos = new THREE.Vector3();
    this.slipSpeed = 0;
    this.lockup = 0;
    this.spinning = 0;
    this.tyre.reset();
  }

  /** Free length of the spring, derived from its static load. */
  freeLength(staticLoad) {
    return this.restLength + staticLoad / this.springRate;
  }
}

/**
 * A racing car.
 *
 * The chassis is a six-degree-of-freedom rigid body. Each corner raycasts
 * against the circuit, resolves a spring/damper strut, and feeds a vertical
 * load into the tyre model; the tyre returns forces in the contact plane which
 * are applied back at the contact point. Load transfer, body roll, wheelspin,
 * lockup and the way grip changes with all of them fall out of that loop
 * rather than being scripted.
 */
export class Vehicle {
  constructor(spec, track) {
    this.spec = spec;
    this.track = track;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.matrix = new THREE.Matrix4();

    this.wheels = [
      new Wheel(spec, -1, 'front'),
      new Wheel(spec, 1, 'front'),
      new Wheel(spec, -1, 'rear'),
      new Wheel(spec, 1, 'rear'),
    ];

    this.drivetrain = new Drivetrain(spec.engine);
    // Share of driveline stiffness each driven wheel sees, for the implicit
    // wheel step.
    const awd = spec.drivetrainLayout === 'awd';
    const bias = spec.frontTorqueSplit ?? 0.4;
    for (const w of this.wheels) {
      if (!w.driven) continue;
      w.torqueShare = awd ? (w.axle === 'front' ? bias : 1 - bias) * 0.5 : 0.5;
    }
    this.tcCut = 0;

    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.assists = {
      abs: true,
      tractionControl: true,
      stability: true,
      // Speed-sensitive lock. A keyboard or a touch slider can only ask for
      // "full", so full has to mean something the tyres can use. The AI
      // computes its own angles and keeps the whole rack.
      steerLimiter: true,
      autoShift: true,
      // Holding the brake at a standstill selects reverse; the pedals then
      // swap so the brake pedal backs the car up and the throttle pedal
      // brakes, then pulls away forward. Off for the AI, which shifts itself.
      autoReverse: false,
    };
    this.pedals = { throttle: 0, brake: 0 };
    this.reverseHold = 0;
    this.dragScale = 1;

    this.telemetry = {
      speed: 0,
      gForceLong: 0,
      gForceLat: 0,
      slipAngle: 0,
      wheelsOnTrack: 4,
      airborne: false,
    };

    this.steerAngle = 0;
    this.steerLock = spec.maxSteerAngle;
    this.effectiveSteer = 0;
    this.escSteer = 0;
    this.accumulator = 0;
    this.query = {};
    this.lastVelocity = new THREE.Vector3();
    this.damage = 0;

    // Static corner loads, used to size the springs.
    const m = spec.mass;
    this.staticLoadFront = (m * GRAVITY * spec.frontWeightBias) / 2;
    this.staticLoadRear = (m * GRAVITY * (1 - spec.frontWeightBias)) / 2;
  }

  /* ----------------------------------------------------------------- setup */

  reset(position, heading) {
    this.position.copy(position);
    this.position.y += this.spec.cogHeight + 0.02;
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.steerAngle = 0;
    this.effectiveSteer = 0;
    this.escSteer = 0;
    this.damage = 0;
    this.reverseHold = 0;
    for (const w of this.wheels) w.reset();
    this.drivetrain.reset();
    this.#updateMatrix();
    this.#settleSuspension();
  }

  /**
   * Puts every strut at the length its geometry actually implies before the
   * first step runs, so the dampers do not see a step change in travel and
   * launch the car off the grid.
   */
  #settleSuspension() {
    const up = _v2.set(0, 1, 0).applyQuaternion(this.quaternion);
    for (const w of this.wheels) {
      const mount = _v.copy(w.mount).applyMatrix4(this.matrix);
      const q = this.track.query(mount.x, mount.z, this.query);
      const t = (q.height + w.radius - mount.y) / -up.y;
      w.length = clamp(t, w.restLength - w.maxTravel, w.restLength + w.maxTravel);
      w.prevLength = w.length;
      w.compression = (w.restLength + w.maxTravel - w.length) / (2 * w.maxTravel);
    }
  }

  get speed() {
    return this.velocity.length();
  }

  get speedKph() {
    return this.velocity.length() * 3.6;
  }

  /** Signed forward speed, m/s. */
  get forwardSpeed() {
    _f.set(0, 0, 1).applyQuaternion(this.quaternion);
    return this.velocity.dot(_f);
  }

  #updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, _v.set(1, 1, 1));
  }

  /* ----------------------------------------------------------------- step */

  /** Advances the simulation by `dt`, in fixed substeps. */
  update(dt, controls) {
    Object.assign(this.controls, controls);
    this.drivetrain.autoShift = this.assists.autoShift;

    _v2.copy(this.velocity); // frame-start velocity, for the g-force readout
    this.frameStartVelocity = this.frameStartVelocity ?? new THREE.Vector3();
    this.frameStartVelocity.copy(_v2);

    this.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (this.accumulator >= SUBSTEP && steps < 40) {
      this.#step(SUBSTEP);
      this.accumulator -= SUBSTEP;
      steps++;
    }
    this.#updateTelemetry(dt);
  }

  #step(h) {
    const spec = this.spec;
    const c = this.controls;

    /* -- steering rack ----------------------------------------------------- */
    // Full lock at 100 km/h would put the front tyres some 20° past their
    // peak slip angle: they stop turning the car, and the first touch of
    // throttle spins the rear. So the available lock is what the tyres can
    // use at this speed — the angle that produces the car's lateral limit,
    // plus a margin of slip to provoke and catch a slide — capped at the
    // rack's mechanical limit for parking. Rate-limited on top, so the car
    // cannot be flicked instantaneously.
    const speed = this.speed;
    const usable =
      Math.atan((spec.wheelbase * spec.steerLimitAccel) / Math.max(speed, 3) ** 2) +
      spec.steerLimitMargin;
    this.steerLock = this.assists.steerLimiter ? Math.min(spec.maxSteerAngle, usable) : spec.maxSteerAngle;
    const target = c.steer * this.steerLock;
    this.steerAngle = approach(this.steerAngle, target, spec.steerRate * h);

    // Stability control's steering half: once the body slips past a dead
    // band, add lock *into* the slide — the counter-steer a good driver would
    // apply, at the speed they would apply it. It may exceed the
    // speed-sensitive lock (that limits what the driver can ask for, not what
    // it takes to catch the car) but never the rack's mechanical limit.
    let assist = 0;
    if (this.assists.stability && speed > 3) {
      const slip = this.telemetry.slipAngle;
      const beyond = Math.max(0, Math.abs(slip) - spec.escDeadBand) * Math.sign(slip);
      const wanted = beyond * spec.escCounterSteer;
      this.escSteer = approach(this.escSteer, wanted, spec.escSteerRate * h);
      assist = this.escSteer;
    } else {
      this.escSteer = approach(this.escSteer, 0, spec.escSteerRate * h);
    }
    this.effectiveSteer = clamp(this.steerAngle + assist, -spec.maxSteerAngle, spec.maxSteerAngle);

    this.#applyAckermann();

    /* -- forces ------------------------------------------------------------ */
    const force = _v.set(0, -spec.mass * GRAVITY, 0);
    const torque = _v2.set(0, 0, 0);
    const forceAcc = new THREE.Vector3().copy(force);
    const torqueAcc = new THREE.Vector3();

    this.#updateMatrix();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);

    // Suspension + tyres, one corner at a time.
    let grounded = 0;
    for (const w of this.wheels) {
      if (this.#solveWheel(w, up, h, forceAcc, torqueAcc)) grounded++;
    }
    this.#applyAntiRoll(up, forceAcc, torqueAcc);

    /* -- drivetrain -------------------------------------------------------- */
    const driven = this.wheels.filter((w) => w.driven);
    const avgOmega = driven.reduce((s, w) => s + w.omega, 0) / driven.length;

    this.#resolvePedals(h);
    let throttle = this.pedals.throttle;
    if (this.assists.tractionControl) throttle *= this.#tractionControl(driven);
    if (this.assists.stability) throttle *= this.#stabilityControl();

    const shaftTorque = this.drivetrain.update(throttle, avgOmega, h, {
      speed: this.forwardSpeed,
      brake: c.brake,
      // What the driven wheels *would* turn at if they were rolling: the
      // gearbox must pick gears from the road speed, not from wheels that
      // are locked or spinning.
      roadOmega: this.forwardSpeed / driven[0].radius,
    });

    // A centre differential splits torque between the axles on all-wheel
    // drive; each axle then has its own limited-slip diff.
    const [fl, fr, rl, rr] = this.wheels;
    if (spec.drivetrainLayout === 'awd') {
      const bias = spec.frontTorqueSplit ?? 0.4;
      this.#driveAxle(fl, fr, shaftTorque * bias);
      this.#driveAxle(rl, rr, shaftTorque * (1 - bias));
    } else if (spec.drivetrainLayout === 'fwd') {
      this.#driveAxle(fl, fr, shaftTorque);
    } else {
      this.#driveAxle(rl, rr, shaftTorque);
    }

    /* -- wheel spin -------------------------------------------------------- */
    for (const w of this.wheels) {
      this.#integrateWheel(w, h);
      w.driveTorque = 0;
    }

    /* -- aerodynamics ------------------------------------------------------ */
    this.#applyAero(forceAcc, torqueAcc);

    /* -- stability control: yaw ------------------------------------------- */
    if (this.assists.stability) this.#yawDamping(torqueAcc);

    /* -- integrate --------------------------------------------------------- */
    this.#integrateBody(forceAcc, torqueAcc, h);
    this.#resolveBarriers(h);

    this.groundedCount = grounded;
  }

  /* --------------------------------------------------------------- wheels */

  #applyAckermann() {
    const { wheelbase, front } = this.spec;
    const d = this.effectiveSteer;
    if (Math.abs(d) < 1e-4) {
      for (const w of this.wheels) if (w.steered) w.steer = d;
      return;
    }
    // True Ackermann: the inside wheel follows the tighter radius.
    const R = wheelbase / Math.tan(Math.abs(d));
    const inner = Math.atan(wheelbase / Math.max(0.5, R - front.track / 2));
    const outer = Math.atan(wheelbase / (R + front.track / 2));
    for (const w of this.wheels) {
      if (!w.steered) continue;
      const isInner = sign(d) === w.side;
      w.steer = sign(d) * (isInner ? inner : outer);
    }
  }

  /**
   * Raycasts one corner against the circuit, resolves the strut, and applies
   * the resulting suspension and tyre forces. Returns true if the tyre is in
   * contact with the ground.
   */
  #solveWheel(w, up, h, forceAcc, torqueAcc) {
    const mountWorld = _v.copy(w.mount).applyMatrix4(this.matrix);
    w.worldPos.copy(mountWorld);

    // Surface under the strut. The track model answers this analytically, so
    // there is no mesh raycast in the hot loop.
    const q = this.track.query(mountWorld.x, mountWorld.z, this.query);
    const groundY = q.height;
    _n.set(q.nx, q.ny, q.nz);

    // Distance down the strut axis at which the tyre would touch.
    const dirY = -up.y;
    const t = Math.abs(dirY) < 1e-3 ? w.restLength + w.maxTravel : (groundY + w.radius - mountWorld.y) / dirY;

    const minLen = w.restLength - w.maxTravel;
    const maxLen = w.restLength + w.maxTravel;

    w.prevLength = w.length;
    w.surface = q.surface;

    if (t > maxLen || t < -1) {
      // Wheel is off the ground: droop out and carry no load.
      w.length = maxLen;
      w.grounded = false;
      w.load = 0;
      w.compression = 0;
      w.slipStiffness = 0;
      w.forceLong = 0;
      w.tyre.forces(0, 1);
      return false;
    }

    w.length = clamp(t, minLen, maxLen);
    w.grounded = true;
    w.compression = (maxLen - w.length) / (2 * w.maxTravel);

    const staticLoad = w.axle === 'front' ? this.staticLoadFront : this.staticLoadRear;
    const free = w.freeLength(staticLoad);

    let springForce = w.springRate * (free - w.length);
    // Progressive bump stop over the last 20 mm of travel.
    if (w.length < minLen + 0.02) {
      const into = minLen + 0.02 - w.length;
      springForce += into * into * 2.6e6;
    }

    const velocity = (w.prevLength - w.length) / h; // + = compressing
    const damping = velocity > 0 ? w.bumpDamping : w.reboundDamping;
    const dampForce = clamp(damping * velocity, -14000, 14000);

    let Fz = Math.max(0, springForce + dampForce);
    w.load = Fz;
    w.antiRollForce = 0;

    // Contact point, one tyre radius below the hub.
    const contact = w.contact
      .copy(mountWorld)
      .addScaledVector(up, -w.length)
      .addScaledVector(up, -w.radius + 0.0);
    contact.y = groundY;
    w.normal.copy(_n);

    // Suspension load acts along the surface normal.
    _r.subVectors(contact, this.position);
    this.#addForceAtPoint(forceAcc, torqueAcc, _f.copy(_n).multiplyScalar(Fz), _r);

    /* -- tyre ------------------------------------------------------------- */
    // Wheel heading, flattened into the contact plane. Positive steer turns
    // toward the car's right, which is −X in the body frame.
    _f.set(-Math.sin(w.steer), 0, Math.cos(w.steer)).applyQuaternion(this.quaternion);
    _f.addScaledVector(_n, -_f.dot(_n)).normalize();
    _l.crossVectors(_n, _f).normalize();

    // Velocity of the contact patch.
    _v2.copy(this.angularVelocity).cross(_r).add(this.velocity);
    const vLong = _v2.dot(_f);
    const vLat = _v2.dot(_l);

    w.tyre.updateSlip(vLong, vLat, w.omega, h);
    // Surface and weather, then standing water: past ~130 km/h a soaked
    // road starts to lift the tyre off the tarmac.
    let grip = this.track.grip(w.surface);
    if (this.track.wetness > 0.5 && w.surface === 0) {
      grip *= 1 - clamp((this.speed - 36) / 45, 0, 1) * 0.18 * (this.track.wetness - 0.5) * 2;
    }
    w.tyre.forces(Fz, grip);

    let Fx = w.tyre.Fx;
    const Fy = w.tyre.Fy;

    // Rolling resistance and surface drag always oppose travel.
    const drag = Fz * (w.tyre.rollingResistance + (SURFACE_DRAG[w.surface] ?? 0));
    Fx -= Math.sign(vLong) * Math.min(drag, Math.abs(vLong) * Fz * 0.5);

    w.forceLong = Fx;
    w.vLong = vLong;
    w.slipStiffness = w.tyre.slipStiffness(Fz, grip);
    w.slipSpeed = Math.hypot(vLong - w.omega * w.radius, vLat);
    w.tyre.thermal(w.slipSpeed, h, this.speed);

    _f.multiplyScalar(Fx).addScaledVector(_l, Fy);
    this.#addForceAtPoint(forceAcc, torqueAcc, _f, _r);

    // Signals the effects layer uses for smoke, skid marks and audio.
    w.lockup = clamp(-w.tyre.kappa * 2.2, 0, 1);
    w.spinning = clamp(w.tyre.kappa * 1.4, 0, 1);
    return true;
  }

  /**
   * Maps the two pedals onto drive and brake, including the automatic's
   * reverse: brake held for half a second at a standstill selects it, and
   * throttle from a standstill in reverse selects first again.
   */
  #resolvePedals(h) {
    const c = this.controls;
    const box = this.drivetrain;
    this.pedals.throttle = c.throttle;
    this.pedals.brake = c.brake;
    if (!this.assists.autoShift || !this.assists.autoReverse) return;

    const v = this.forwardSpeed;
    if (box.gear < 0) {
      if (c.throttle > 0.2 && v > -0.8) {
        box.shiftTo(1);
        return;
      }
      this.pedals.throttle = c.brake;
      this.pedals.brake = c.throttle;
      return;
    }
    if (v < 0.8 && c.brake > 0.3 && c.throttle < 0.05) {
      this.reverseHold += h;
      if (this.reverseHold > 0.45) {
        box.shiftTo(-1);
        this.pedals.throttle = c.brake;
        this.pedals.brake = 0;
      }
    } else {
      this.reverseHold = 0;
    }
  }

  /** Sends torque to one axle through its limited-slip differential. */
  #driveAxle(left, right, torque) {
    const [tl, tr] = this.drivetrain.splitTorque(torque, left.omega, right.omega);
    left.driveTorque = tl;
    right.driveTorque = tr;
  }

  /** Integrates hub rotation from drive, brake and road-reaction torques. */
  #integrateWheel(w, h) {
    const c = this.controls;
    const brake = this.pedals.brake;
    const brakeInput = w.axle === 'rear' ? Math.max(brake, c.handbrake) : brake;

    let brakeTorque = brakeInput * w.maxBrakeTorque;
    if (this.assists.abs && c.handbrake < 0.5 && w.grounded) {
      // Release pressure as the tyre approaches lockup.
      const lock = clamp(-w.tyre.kappa / 0.16, 0, 1.6);
      brakeTorque *= clamp(1 - (lock - 0.75) * 1.9, 0.14, 1);
    }

    const roadTorque = w.grounded ? -w.forceLong * w.radius : 0;
    const drive = w.driveTorque ?? 0;
    const I = w.tyre.inertia;

    // Semi-implicit step. The road reaction is linearised about the current
    // slip so the (very stiff) hub-to-road coupling stays stable at 240 Hz:
    //   ω' = ω + (h·T/I) / (1 − h·k/I),  k = ∂T_road/∂ω  (negative)
    // Only the increment is damped — dividing ω itself would act as a brake.
    let k = 0;
    if (w.grounded) {
      const vref = Math.max(Math.abs(w.vLong ?? 0), 0.8);
      k = -(w.slipStiffness * w.tyre.lagLong * w.radius * w.radius) / vref;
    }
    if (w.driven) k += (this.drivetrain.torqueSlope || 0) * (w.torqueShare ?? 0.5);
    w.omega += (h * (drive + roadTorque)) / I / (1 - (h * k) / I);

    // Brakes cannot reverse the wheel, so integrate them as a clamped impulse.
    const brakeDelta = (brakeTorque / w.tyre.inertia) * h;
    if (Math.abs(w.omega) <= brakeDelta) w.omega = 0;
    else w.omega -= Math.sign(w.omega) * brakeDelta;

    if (!w.grounded) {
      // Free wheel gently spins down.
      w.omega *= 1 - 0.6 * h;
    }

    w.spin += w.omega * h;
  }

  /**
   * Anti-roll bars couple the two wheels on each axle.
   *
   * The bar reacts to the *difference in strut travel*, so its rate is in N/m
   * like a spring. When the car rolls it adds load to the compressed side and
   * takes it off the extended one, which is how axle roll stiffness controls
   * the car's balance.
   */
  #applyAntiRoll(up, forceAcc, torqueAcc) {
    for (const axle of ['front', 'rear']) {
      const [l, r] = this.wheels.filter((w) => w.axle === axle);
      if (!l.antiRoll) continue;
      if (!l.grounded && !r.grounded) continue;

      // Positive when the left strut is the more compressed of the two.
      const travelDiff = r.length - l.length;
      const f = clamp(travelDiff * l.antiRoll, -9000, 9000);

      for (const [w, s] of [
        [l, 1],
        [r, -1],
      ]) {
        if (!w.grounded) continue;
        _r.subVectors(w.contact, this.position);
        this.#addForceAtPoint(forceAcc, torqueAcc, _f.copy(up).multiplyScalar(f * s), _r);
        w.load = Math.max(0, w.load + f * s);
      }
    }
  }

  /* ------------------------------------------------------------ assistance */

  /**
   * Cuts throttle when the driven wheels start to overspeed the road.
   *
   * The cut is smoothed rather than applied instantly: a proportional-only
   * response at this authority hunts badly, which shows up as the car surging
   * out of slow corners.
   */
  #tractionControl(driven) {
    let worst = 0;
    let cornering = 0;
    for (const w of driven) {
      worst = Math.max(worst, w.tyre.kappa);
      cornering = Math.max(cornering, Math.abs(w.tyre.alpha) / w.tyre.alphaPeak);
    }
    // Aim at the peak of the longitudinal curve — but the tyre has one
    // budget, and a rear that is already leaning on its lateral peak has no
    // longitudinal slip to spare. Lower the target as the corner takes its
    // share, which is what stops a full-throttle exit becoming a power slide.
    const target = 0.1 * lerp(1, 0.35, clamp(cornering - 0.5, 0, 1) / 0.6);
    // Authority up to a 95% cut: a system that can only take 18% off does
    // nothing against 600 hp.
    const cut = clamp((worst - target) * 7, 0, 0.95);
    // Quick to cut, slower to give the torque back.
    this.tcCut = lerp(this.tcCut ?? 0, cut, cut > (this.tcCut ?? 0) ? 0.35 : 0.08);
    return 1 - this.tcCut;
  }

  /**
   * Stability control's throttle half: once the body slip angle passes what
   * the rear tyres can hold, bleed the throttle so the driver's foot cannot
   * keep the slide going. Gently — snatching it away mid-corner in a
   * mid-engined car is lift-off oversteer, the very thing this prevents.
   */
  #stabilityControl() {
    const slip = Math.abs(this.telemetry.slipAngle);
    if (slip < 0.09 || this.speed < 4) return 1;
    // Proportional, so it never snatches: three quarters of the throttle
    // left at 10° of slip, under half at 15°, and a fifth from 20° on —
    // enough torque to keep the car driving, not enough to hold a slide.
    return clamp(1 - (slip - 0.09) * 3.2, 0.2, 1);
  }

  /**
   * Stability control's yaw half. A real system brakes individual wheels to
   * pull the car's rotation back toward what the steering implies; this
   * applies the equivalent moment directly. The reference is the kinematic
   * yaw rate for the current steer and speed, so a car that is rotating
   * faster than its front wheels are pointed gets damped — and one that is
   * simply cornering does not.
   */
  #yawDamping(torqueAcc) {
    const spec = this.spec;
    const v = this.forwardSpeed;
    if (Math.abs(v) < 3) return;

    _q.copy(this.quaternion).invert();
    const wb = _v.copy(this.angularVelocity).applyQuaternion(_q);
    // Positive steer (right) means yaw about −Y in a right-handed Y-up frame.
    const expected = (-v * Math.tan(this.effectiveSteer)) / spec.wheelbase;
    const excess = wb.y - expected;
    const torque = -excess * spec.escYawDamping * spec.inertia.yaw;
    _f.set(0, torque, 0).applyQuaternion(this.quaternion);
    torqueAcc.add(_f);
  }

  /* ------------------------------------------------------------------ aero */

  #applyAero(forceAcc, torqueAcc) {
    const spec = this.spec;
    const v = this.speed;
    if (v < 0.5) return;

    const qPressure = 0.5 * AIR_DENSITY * v * v;

    // Drag opposes the velocity vector. `dragScale` drops in another car's
    // slipstream, and so does the downforce — the wake is dirty air.
    _f.copy(this.velocity).normalize().multiplyScalar(-qPressure * spec.dragArea * this.dragScale);
    forceAcc.add(_f);
    const wake = lerp(0.82, 1, this.dragScale);

    // Downforce acts on the body's own up axis at the two axle lines, so it
    // both loads the tyres and trims the car's attitude.
    const up = _n.set(0, 1, 0).applyQuaternion(this.quaternion);
    for (const [clA, z] of [
      [spec.downforceFront, spec.cogToFrontAxle],
      [spec.downforceRear, -spec.cogToRearAxle],
    ]) {
      _f.copy(up).multiplyScalar(-qPressure * clA * wake);
      _r.set(0, 0, z).applyQuaternion(this.quaternion);
      this.#addForceAtPoint(forceAcc, torqueAcc, _f, _r);
    }
  }

  /* ------------------------------------------------------------- integrate */

  #addForceAtPoint(forceAcc, torqueAcc, force, offset) {
    forceAcc.add(force);
    torqueAcc.x += offset.y * force.z - offset.z * force.y;
    torqueAcc.y += offset.z * force.x - offset.x * force.z;
    torqueAcc.z += offset.x * force.y - offset.y * force.x;
  }

  #integrateBody(force, torque, h) {
    const spec = this.spec;

    // Linear.
    this.lastVelocity.copy(this.velocity);
    this.velocity.addScaledVector(force, h / spec.mass);
    this.position.addScaledVector(this.velocity, h);

    // Angular, in the body frame where the inertia tensor is diagonal.
    _q.copy(this.quaternion).invert();
    const tb = _v.copy(torque).applyQuaternion(_q);
    const wb = _v2.copy(this.angularVelocity).applyQuaternion(_q);
    const I = spec.inertia;

    // Euler's equations: ω̇ = I⁻¹ (τ − ω × Iω)
    const Ix = I.pitch;
    const Iy = I.yaw;
    const Iz = I.roll;
    const gx = wb.y * (Iz * wb.z) - wb.z * (Iy * wb.y);
    const gy = wb.z * (Ix * wb.x) - wb.x * (Iz * wb.z);
    const gz = wb.x * (Iy * wb.y) - wb.y * (Ix * wb.x);

    wb.x += ((tb.x - gx) / Ix) * h;
    wb.y += ((tb.y - gy) / Iy) * h;
    wb.z += ((tb.z - gz) / Iz) * h;

    // A touch of damping keeps the solver honest without deadening the car.
    wb.multiplyScalar(1 - 0.35 * h);

    this.angularVelocity.copy(wb).applyQuaternion(this.quaternion);

    // Quaternion integration: q̇ = ½ ω ⊗ q
    const w = this.angularVelocity;
    const q = this.quaternion;
    const dx = 0.5 * (w.x * q.w + w.y * q.z - w.z * q.y);
    const dy = 0.5 * (w.y * q.w + w.z * q.x - w.x * q.z);
    const dz = 0.5 * (w.z * q.w + w.x * q.y - w.y * q.x);
    const dw = -0.5 * (w.x * q.x + w.y * q.y + w.z * q.z);
    q.set(q.x + dx * h, q.y + dy * h, q.z + dz * h, q.w + dw * h).normalize();
  }

  /* -------------------------------------------------------------- barriers */

  /** Keeps the car inside the armco, with a loss of speed for hitting it. */
  #resolveBarriers(h) {
    const q = this.track.query(this.position.x, this.position.z, this.query);
    const limit = q.width * 0.5 + 12.6;
    const over = Math.abs(q.lateral) - limit;
    if (over <= 0) return;

    const dir = Math.sign(q.lateral);
    _l.set(0, 0, 0);
    // Lateral direction at this point on the circuit.
    const i = q.index;
    _l.fromArray(this.track.lateral, i * 3).multiplyScalar(dir);

    // Push out of the wall and reflect the component of velocity into it.
    this.position.addScaledVector(_l, -over);
    const into = this.velocity.dot(_l);
    if (into > 0) {
      this.velocity.addScaledVector(_l, -into * 1.45);
      this.velocity.multiplyScalar(0.86);
      this.angularVelocity.multiplyScalar(0.5);
      this.damage = clamp(this.damage + into * 0.0055, 0, 1);
      this.lastImpact = into;
    }
  }

  /* ------------------------------------------------------------- telemetry */

  #updateTelemetry(dt) {
    const t = this.telemetry;
    t.speed = this.speed;

    _f.set(0, 0, 1).applyQuaternion(this.quaternion);
    _l.set(-1, 0, 0).applyQuaternion(this.quaternion); // the car's right

    _v.subVectors(this.velocity, this.frameStartVelocity).divideScalar(Math.max(dt, 1e-4));
    t.gForceLong = _v.dot(_f) / GRAVITY;
    t.gForceLat = _v.dot(_l) / GRAVITY; // positive in a right-hand corner

    const vLong = this.velocity.dot(_f);
    const vLat = this.velocity.dot(_l);
    t.slipAngle = Math.abs(vLong) > 1.5 ? Math.atan2(vLat, Math.abs(vLong)) : 0;

    t.wheelsOnTrack = this.wheels.filter((w) => w.grounded && w.surface <= 2).length;
    t.airborne = this.wheels.every((w) => !w.grounded);
    t.rpm = this.drivetrain.rpm;
    t.gear = this.drivetrain.gear;
  }

  /** Places the car back on the racing line, stationary and facing forwards. */
  respawn() {
    const q = this.track.query(this.position.x, this.position.z, {});
    const s = q.s;
    const i = this.track.indexAt(s);
    const p = this.track.racingLineAt(s, new THREE.Vector3());
    _f.fromArray(this.track.tangent, i * 3);
    this.reset(p, Math.atan2(_f.x, _f.z));
  }
}

/* ------------------------------------------------------------------ specs */

/** Shared chassis geometry for a mid-engined, rear-drive supercar. */
function supercar(overrides) {
  const wheelbase = overrides.wheelbase ?? 2.65;
  const bias = overrides.frontWeightBias ?? 0.42;
  return {
    wheelbase,
    frontWeightBias: bias,
    cogToFrontAxle: wheelbase * (1 - bias),
    cogToRearAxle: wheelbase * bias,
    cogHeight: 0.37,
    restLength: 0.19,
    maxTravel: 0.085,
    maxSteerAngle: 0.58, // ~33°, the rack's mechanical limit
    steerLimitAccel: 12, // m/s² of cornering the lock is sized for at speed
    steerLimitMargin: 0.22, // rad of slip beyond that, to provoke and catch a slide
    steerRate: 3.4, // rad/s at the wheel
    // Stability control (ESC).
    escDeadBand: 0.05, // rad of body slip before it acts (~3°)
    escCounterSteer: 1.3, // rad of lock per rad of slip beyond that
    escSteerRate: 7, // rad/s — faster than a driver, as a real system is
    escYawDamping: 4.2, // 1/s on yaw rate in excess of what the steer implies
    drivetrainLayout: 'rwd',
    dragArea: 0.68,
    downforceFront: 0.34,
    downforceRear: 0.52,
    ...overrides,
  };
}

export const CARS = [
  {
    id: 'rosso',
    name: 'Rosso 458',
    badge: 'Mid-engine V8 · RWD',
    model: 'models/cars/ferrari.glb',
    rig: 'ferrari',
    paint: 0x9d0208,
    spec: supercar({
      mass: 1440,
      engine: V8_NA,
      inertia: { pitch: 1950, yaw: 1830, roll: 470 },
      front: {
        track: 1.68,
        radius: 0.3355,
        springRate: 63000,
        bumpDamping: 4300,
        reboundDamping: 6100,
        antiRoll: 26000,
        maxBrakeTorque: 3350,
      },
      rear: {
        track: 1.62,
        radius: 0.3485,
        springRate: 79000,
        bumpDamping: 5100,
        reboundDamping: 7000,
        antiRoll: 17000,
        maxBrakeTorque: 1850,
      },
    }),
  },
  {
    id: 'concept',
    name: 'Khronos Concept',
    badge: 'Twin-turbo V10 · AWD',
    model: 'models/cars/concept.glb',
    rig: 'concept',
    paint: 0x1b2f6b,
    spec: supercar({
      mass: 1610,
      engine: V10_TT,
      wheelbase: 2.72,
      frontWeightBias: 0.44,
      drivetrainLayout: 'awd',
      frontTorqueSplit: 0.38,
      dragArea: 0.74,
      downforceFront: 0.42,
      downforceRear: 0.6,
      inertia: { pitch: 2180, yaw: 2020, roll: 540 },
      front: {
        track: 1.7,
        radius: 0.345,
        springRate: 72000,
        bumpDamping: 4900,
        reboundDamping: 6600,
        antiRoll: 30000,
        maxBrakeTorque: 3600,
      },
      rear: {
        track: 1.66,
        radius: 0.36,
        springRate: 86000,
        bumpDamping: 5600,
        reboundDamping: 7600,
        antiRoll: 20000,
        maxBrakeTorque: 2100,
      },
    }),
  },
];
