import * as THREE from 'three';

import { approach as approachTo, clamp, damp, lerp, wrapDelta } from '../core/MathUtils.js';
import { Pacing } from '../track/Pacing.js';

const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _oq = {};

/** Seconds of driving that make up one measurement of somebody's pace. */
const PACE_WINDOW = 5;

/**
 * The furthest a driver will move off their own line for anybody, in metres.
 * Two car widths: enough to pass and to leave room, and short of the lane
 * change across the whole circuit that a corner's racing line would otherwise
 * make arithmetically reasonable.
 */
const MOVE = 5;

/**
 * How quick the player actually is.
 *
 * A field pinned to a fixed skill is either a wall you never get past or a
 * queue of traffic, and which one it is has nothing to do with the race and
 * everything to do with who is holding the controller. So the pace is
 * measured rather than assumed.
 *
 * The measurement is a ratio, and deliberately the dullest one available:
 * over a window of a few seconds, how far the car actually travelled against
 * how far the circuit's own speed profile says it should have. One means
 * driving it as the profile plans it; three quarters means giving away a
 * quarter of the lap. Because both halves of the ratio come from the same
 * profile, it means the same thing on every circuit, in every car, wet or
 * dry — which is what lets the drivers use it directly.
 *
 * Time spent stopped, off the circuit or reversing out of a mistake is left
 * out. That is evidence about one corner, not about a driver, and letting it
 * in would have the whole field slow down every time you spun.
 */
export class FieldPace {
  /** @param {import('../track/Pacing.js').Pacing} [reference] the speed profile to measure against */
  constructor(reference = null) {
    this.reference = reference;
    // Until there is evidence, assume a decent club driver: quick enough
    // that the first corner is a race, slow enough that it is not a rout.
    this.pace = 0.86;
    this.covered = 0;
    this.wanted = 0;
    this.elapsed = 0;
    this.samples = 0;
  }

  setReference(reference) {
    this.reference = reference;
    this.covered = this.wanted = this.elapsed = 0;
    this.samples = 0;
  }

  /**
   * @param {number} dt
   * @param {object} car
   * @param {number} car.speed m/s
   * @param {number} car.s     arc length along the circuit
   * @param {boolean} [car.offTrack]
   * @returns {number} the pace, 0.25 (a passenger) … 1.2 (quicker than the profile)
   */
  observe(dt, { speed, s, offTrack = false }) {
    const ref = this.reference;
    if (!ref || !(dt > 0)) return this.pace;

    if (speed > 4 && !offTrack) {
      const want = ref.speedAt(s);
      if (want > 4) {
        this.covered += speed * dt;
        this.wanted += want * dt;
        this.elapsed += dt;
      }
    }

    if (this.elapsed >= PACE_WINDOW) {
      const ratio = clamp(this.covered / Math.max(1, this.wanted), 0.25, 1.2);
      // The first window lands outright — the field should be racing you by
      // the second corner, not the second lap — and every window after it
      // moves the figure a third of the way, so one bad corner does not slow
      // eleven other cars down.
      this.pace = this.samples < 1 ? ratio : lerp(this.pace, ratio, 0.35);
      this.covered = this.wanted = this.elapsed = 0;
      this.samples++;
    }
    return this.pace;
  }
}

/**
 * A computer-controlled driver.
 *
 * It drives the same physics as the player — no rails, no scripted speeds. The
 * controller has four parts: a pure-pursuit steering law aimed at a point down
 * the racing line, a speed target derived from a whole-lap profile, a *form*
 * that tracks the player's measured pace so the race is a race, and the
 * racecraft — following, passing and, above all, not hitting anyone.
 *
 * `skill` (0..1) scales the grip it is willing to use, how far ahead it looks,
 * and how tidy its inputs are, so a field of AI cars has a natural spread.
 * `aggression` decides how long it will sit behind a car before it goes for a
 * move; it never decides whether a move is safe, which is not negotiable.
 */
export class Driver {
  constructor(vehicle, track, { skill = 0.85, name = 'AI', aggression = 0.5, pace = null } = {}) {
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

    // How much of the racing line's offset this driver uses (see update).
    this.lineShare = lerp(0.7, 0.85, this.skill);

    // The speed profile this driver plans to, built for the grip they are
    // willing to use and the line they actually drive, and rebuilt when the
    // weather changes the grip.
    this.pacing = null;
    this.pacingWet = -1;
    this.pacingForm = 1;

    /* -- form: the part that adapts ---------------------------------------- */
    /** Shared measurement of the player's pace, or null for a fixed field. */
    this.field = pace;
    /** What fraction of their own planned speed this driver is using. */
    this.form = 1;
    /** How much quicker than the player this one aims to be. */
    this.edge = lerp(0.955, 1.035, this.skill);
    /** A few per cent for the gap to the player: adrift presses on, clear settles. */
    this.reel = 0;
    /** This driver's own pace, measured exactly as the player's is. */
    this.ownPace = null;
    this.paceCovered = 0;
    this.paceWanted = 0;
    this.paceTime = 0;

    /* -- racecraft --------------------------------------------------------- */
    /** The move being made, once committed to, or null. */
    this.pass = null;
    this.passCooldown = 0;
    /** Speed ceiling set by whoever is in front, m/s. */
    this.speedCap = Infinity;
    /** 0 clear road … 1 about to be in the back of someone. */
    this.urgency = 0;
    /** True while held up, so a queue is not mistaken for being stuck. */
    this.blocked = false;
    /** How hard the driver is forbidden from turning each way, 0…1. */
    this.guardLeft = 0;
    this.guardRight = 0;
    /** How hard the driver must actively move away, 0…1. */
    this.panicLeft = 0;
    this.panicRight = 0;
  }

  /**
   * @param {number} dt
   * @param {Array<{vehicle: import('../physics/Vehicle.js').Vehicle, isPlayer?: boolean, q?: object}>} rivals
   */
  update(dt, rivals = []) {
    const v = this.vehicle;
    const track = this.track;
    const speed = v.speed;

    const q = track.query(v.position.x, v.position.z, this.q);
    const s = q.s;

    _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
    const alongTrack = _fwd.x * q.tx + _fwd.z * q.tz;

    /* -- pace, form, and everyone else ------------------------------------- */
    this.#measurePace(dt, s, speed);
    // The plan for this piece of road, before anybody else is taken into
    // account. The racecraft needs it to know whether there is a move on.
    const paceSpeed = this.#speedTarget(s, speed);
    // Where this driver is aiming, worked out before the racecraft rather
    // than after it: every lateral decision below is measured against that
    // aim point, and measuring them against anything else is how a car ends
    // up bounded to a piece of road it is not driving on.
    const lookahead = clamp(7 + speed * lerp(0.34, 0.46, this.skill), 9, 48);
    const share = this.#share(speed);
    const aim = track.indexAt(s + lookahead);
    this.#racecraft(rivals, s, q, speed, dt, paceSpeed, share, aim);

    // --- recovery: spun, stuck, or facing the wrong way -------------------
    if (alongTrack < 0.15 || (speed < 2.5 && this.recoverTimer > 0 && !this.blocked)) {
      this.recoverTimer = Math.max(this.recoverTimer, 1.6);
    }
    // Queueing behind a slow car is not being stuck, and a driver that
    // respawns out of a traffic jam is worse than one that waits.
    if (speed < 1.6 && !this.blocked) this.recoverTimer += dt;
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
    track.aiLineAt(s + lookahead, share, _target);

    // A committed move is made decisively; drifting across over three seconds
    // is how you end up alongside someone in the braking zone.
    this.lineOffset = damp(this.lineOffset, this.targetOffset, this.pass ? 3.4 : 2.2, dt);
    _v.fromArray(track.lateral, aim * 3);
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
    const wide = q.lateral - track.lineOffset[track.indexAt(s)] * share - this.lineOffset;
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

    // Never turn into a car that is already there. The line may want the
    // apex; the driver does not get to have it while somebody is alongside,
    // and no amount of understeer, noise or racing line outranks that. This
    // is the last word on the steering for exactly that reason: whatever the
    // rest of the controller decided, it does not get to close the door on
    // another car.
    // Positive steer is to the right, toward −lateral.
    if (this.guardLeft > 0 && steer < 0) steer *= 1 - this.guardLeft;
    if (this.guardRight > 0 && steer > 0) steer *= 1 - this.guardRight;
    // Closer than a door's width, and not turning into them is no longer
    // enough: move. The aim point is tens of metres down the road, which is
    // most of a second away at racing speed, and the panels are here now.
    // Weighted down with speed, because it is spent out of the same tyres
    // that are holding the corner. A third of the lock is a swerve at sixty
    // km/h and a spin at two hundred and fifty.
    steer += (this.panicLeft - this.panicRight) * lerp(0.35, 0.08, clamp((speed - 20) / 50, 0, 1));

    // Understeer: once the front tyres are past their peak slip angle, more
    // lock gives *less* cornering force, and a driver who keeps winding it
    // on runs wider and wider. Unwind instead, so the fronts sit at their
    // peak — the only place the car turns hardest.
    const front = v.wheels[0].tyre;
    const frontSlip = (Math.abs(front.alpha) + Math.abs(v.wheels[1].tyre.alpha)) / 2;
    const peak = front.alphaPeak * 1.12;
    if (frontSlip > peak && speed > 8 && Math.sign(steer) === Math.sign(v.steerAngle || steer)) {
      steer *= clamp(peak / frontSlip, 0.3, 1);
    }

    // Rate-limit the driver's hands: no human snaps from lock to lock in one
    // simulation step, and neither should this.
    const maxRate = lerp(2.2, 4.2, clamp(1 - speed / 70, 0, 1));
    this.controls.steer = approachTo(this.controls.steer, clamp(steer, -1, 1), maxRate * dt);

    /* -- speed target ------------------------------------------------------ */
    // The plan, or whatever the car in front leaves of it, whichever is less.
    const targetSpeed = Math.min(paceSpeed, this.speedCap);
    const error = targetSpeed - speed;

    // A dead band around the target stops the driver pumping the pedals, and
    // brake pressure is eased in rather than stamped on.
    if (error > 0.5) {
      this.controls.throttle = clamp(error * 0.35, 0, 1);
      this.controls.brake = 0;
    } else if (error < -0.8) {
      this.controls.throttle = 0;
      // A corner is where the driver planned to brake and the gentle gain is
      // right for it. A car in the way is not planned, and the same gentle
      // gain arrives in the back of it — so the pedal firms up with how close
      // the thing in front is.
      this.controls.brake = clamp((-error - 0.8) * lerp(0.22, 1.1, this.urgency), 0, 1);
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
   * How much of the racing line's offset this driver uses at this speed.
   *
   * The racing line runs 1.6 m from the edge; a driver who tracks it with any
   * error at all needs more room than that, so the AI aims at a line pulled a
   * little toward the centre — the better the driver, the less. Above about
   * 150 km/h it stays nearer the centre still: the line's crossings from one
   * side of the road to the other are lane changes a pure-pursuit controller
   * takes with far more lock than the tyres have at that speed, and the road
   * is all but straight there anyway.
   */
  #share(speed) {
    return this.lineShare * (1 - 0.65 * clamp((speed - 40) / 25, 0, 1));
  }

  /**
   * The speed the driver should be doing here.
   *
   * It comes from a whole-lap profile — cornering limit, then a backward
   * braking pass that respects the friction circle and the grade — rather than
   * a scan of the curvature ahead, because a scan cannot know that braking
   * *into* a downhill corner leaves far less than the full braking figure.
   * Looking a little way down the profile makes the driver brake before the
   * error has grown, which is the difference between trail-braking and
   * arriving at the apex sideways.
   *
   * The profile is the plan; `form` is how much of it this driver is using
   * today, which is what tracks the player.
   */
  #speedTarget(s, speed) {
    const track = this.track;

    // Rebuilt when the weather changes the grip, and when the form has moved
    // far enough to be worth the two passes it costs.
    //
    // The form belongs *here*, in the grip the profile is built from, and not
    // as a multiplier on what the profile returns. That was the first way it
    // was written and it was wrong in a way that took a while to see:
    // cornering speed goes with the square root of grip, so putting a flat six
    // per cent on the speed asks for twelve per cent more braking than the
    // backward pass planned for. Every braking point in the profile is then
    // too late by exactly that much, and a whole field arrives at the corner
    // with the pedal already on the floor. Scaling the grip instead moves the
    // braking points with the speeds, because they were computed from it.
    if (!this.pacing || this.pacingWet !== track.wetness || Math.abs(this.pacingForm - this.form) > 0.02) {
      // Grip the driver is willing to use, in m/s². Well short of the 13-14
      // m/s² the car can actually produce: a driver that plans to use every
      // last newton arrives at the apex with nothing left for corrections.
      // The profile itself scales with what the weather leaves of the tarmac.
      // A car on narrow period tyres, or a two-tonne SUV, cannot corner
      // like a supercar; the spec says how much of that budget it has.
      const grip = (this.vehicle.spec.aiGrip ?? 1) * this.form * this.form;
      const lateralG = lerp(7.6, 10.4, this.skill) * grip;
      const brakingG = lerp(7.4, 10.2, this.skill) * grip;
      const curvature = track.lineCurvatureFor(this.lineShare);
      if (!this.pacing) {
        // A driver off the pace is not only slower through the corners: they
        // are shorter on the straight too, off the throttle earlier and on it
        // later. Ninety-five metres a second is above anything in the garage,
        // so at full form this never binds and only the corners decide.
        this.pacing = new Pacing(track, { lateralG, brakingG, topSpeed: 95, forwardPass: false });
      }
      this.pacing.car.lateralG = lateralG;
      this.pacing.car.brakingG = brakingG;
      this.pacing.car.topSpeed = 95 * this.form;
      this.pacing.compute(curvature);
      this.pacingWet = track.wetness;
      this.pacingForm = this.form;
    }

    const here = this.pacing.speedAt(s);
    const ahead = this.pacing.speedAt(s + Math.max(speed, 6) * 0.35);
    let best = Math.min(here, ahead + 1.0);

    // Back off when running wide onto the marbles or off the circuit.
    const q = this.q;
    const surface = q.surface ?? 0;
    if (surface >= 3) best *= 0.65;

    return best;
  }

  /* --------------------------------------------------------------- the form */

  /**
   * Measures this driver's own pace exactly as the player's is measured, so
   * the two figures mean the same thing and can be compared directly.
   *
   * Doing it this way rather than by picking a number for the skill is what
   * makes the adaptation work at all: the loop does not need to know what car
   * anyone is in, how much grip the weather has left, or how the profile was
   * built. It only needs both cars measured with the same ruler.
   */
  #measurePace(dt, s, speed) {
    const ref = this.field?.reference;
    if (!ref || !(dt > 0)) return;

    if (speed > 4 && (this.q.surface ?? 0) < 3) {
      const want = ref.speedAt(s);
      if (want > 4) {
        this.paceCovered += speed * dt;
        this.paceWanted += want * dt;
        this.paceTime += dt;
      }
    }
    if (this.paceTime < PACE_WINDOW) return;

    const ratio = clamp(this.paceCovered / Math.max(1, this.paceWanted), 0.2, 1.3);
    this.ownPace = this.ownPace === null ? ratio : lerp(this.ownPace, ratio, 0.5);
    this.paceCovered = this.paceWanted = this.paceTime = 0;

    // One correction per measurement, not a continuous integrator: the
    // evidence only arrives every few seconds, and pushing on the form in
    // between is how a controller overshoots and the field starts surging.
    const wanted = clamp(this.field.pace * this.edge + this.reel, 0.4, 1.25);
    // The ceiling matters. The profile a driver plans to already leaves grip
    // in hand, so a few per cent over it is a driver pressing on; a lot over
    // it is a driver in the scenery, and a field that beats you by cheating
    // physics is not a field anybody wants to race.
    this.form = clamp(this.form + (wanted - ratio) * 0.55, 0.68, 1.06);
  }

  /* ---------------------------------------------------------------- racecraft */

  /**
   * Everything to do with the other cars: how close it is safe to follow, when
   * there is a move on, which side it goes down, and — the part that is not
   * negotiable — never driving into anybody.
   *
   * Three rules, in order of precedence:
   *
   *  1. **Do not hit the car in front.** A following distance is worked out
   *     from the speed and the closing rate, and the driver's speed is capped
   *     to whatever keeps it. The cap beats the racing line, the plan and the
   *     move; the only way an AI car ends up in the back of another is if
   *     somebody hit *it*.
   *  2. **Leave room alongside.** A car beside this one takes the steering
   *     away in that direction entirely, and pushes the aim point the other
   *     way. Passes here end with one car in front, not with two in a heap.
   *  3. **Then, if there is genuinely the pace and genuinely the room, go
   *     past.** Committed to once and held, down a side chosen for the corner
   *     that is coming, and abandoned quietly if the room disappears.
   */
  #racecraft(rivals, s, q, speed, dt, paceSpeed, share, aim) {
    const v = this.vehicle;
    const track = this.track;
    // Everything below is a displacement from the driver's aim point, and
    // that point is itself well off the centre of the road — so the bound
    // has to be on where the car ends up, not on the size of the move. It
    // also has to be the *same* line the steering is using: bounding a move
    // against the full racing line while the car aims at a flattened one is
    // how five cars politely queued up and drove off the road together.
    const lineLat = track.lineOffset[aim] * share;
    const edge = Math.max(1.2, track.width[aim] * 0.5 - 1.5);
    // And how far off it there is anything to *use*. A car already asking its
    // tyres for a corner has nothing left over to change line with: the room
    // beside the racing line through a bend is not room, it is the reason the
    // line goes where it does. So the size of a move shrinks with cornering
    // load, from two car widths on a straight to almost nothing at the limit
    // — which is the difference between a pass and four cars in the scenery.
    const load = clamp((Math.abs(track.curvature[aim]) * speed * speed) / 9, 0, 1);
    const move = MOVE * (1 - 0.75 * load);

    this.passCooldown = Math.max(0, this.passCooldown - dt);

    let offset = 0;
    let cap = Infinity;
    let urgency = 0;
    let guardLeft = 0;
    let guardRight = 0;
    let panicLeft = 0;
    let panicRight = 0;
    let ahead = null;
    let playerGap = null;
    let seenPassTarget = false;

    for (const other of rivals) {
      const ov = other.vehicle ?? other;
      if (ov === v) continue;

      // Game keeps a track query per car; a frame-old one is a few
      // centimetres stale at racing speed, which is nothing next to what a
      // fresh query per car per driver per frame costs.
      const oq = other.q ?? track.query(ov.position.x, ov.position.z, _oq);
      const gap = wrapDelta(oq.s, s, track.length);
      if (other.isPlayer) playerGap = gap;

      if (ov.position.distanceTo(v.position) > 170) continue;

      const across = oq.lateral - q.lateral; // + is to our left
      const closing = speed - ov.speed;

      if (this.pass && ov === this.pass.ov) {
        this.pass.gap = gap;
        this.pass.closing = closing;
        this.pass.lateral = oq.lateral;
        seenPassTarget = true;
      }

      /* -- 1. the car in front --------------------------------------------- */
      // Half a car length each side of the arc length is where "in front"
      // stops and "alongside" starts.
      if (gap > 3.2 && gap < 150 && Math.abs(across) < 3.4) {
        // A car length, plus what a driver's reaction eats, plus the distance
        // the closing speed actually takes to wash off. That last term is
        // quadratic because braking is: two metres a second of closing needs
        // nothing, forty-five needs a hundred metres, and a following
        // distance that only counts the first of those arrives at the second
        // one flat out.
        const shed = Math.max(0, closing);
        const safe = 5.5 + speed * 0.16 + shed * 0.6 + (shed * shed) / 20;
        if (gap < safe) {
          // Match their speed at the safe distance, and give a metre per
          // second back for every metre closer than that. Smooth, so it
          // reads as a driver backing out rather than a handbrake.
          cap = Math.min(cap, Math.max(0, ov.speed - (safe - gap) * 1.15));
          urgency = Math.max(urgency, clamp(1 - gap / safe, 0, 1));
        }
        if (!ahead || gap < ahead.gap) ahead = { ov, gap, closing, lateral: oq.lateral };
      }

      /* -- 2. alongside ----------------------------------------------------- */
      if (Math.abs(gap) < 9 && Math.abs(across) < 6.5) {
        // Full strength inside 2.1 m — a car's width plus a little — falling
        // away to nothing by 5.3 m, which is a lane apart.
        const near = 1 - clamp((Math.abs(across) - 2.1) / 3.2, 0, 1);
        // And a much sharper band inside that, for when the aim point forty
        // metres down the road is too slow to be any use: two cars a metre
        // and a half apart need the wheel moved this frame.
        //
        // "Alongside" here has to mean genuinely overlapping, not merely
        // nearby. A car tucked into somebody's tow sits a metre and a half
        // across and half a dozen metres back, which is racing; reading that
        // as an emergency and pulling at the wheel every frame put more cars
        // in the scenery than every other rule here put together.
        const panic = Math.abs(gap) < 4.5 ? 1 - clamp((Math.abs(across) - 1.9) / 1.0, 0, 1) : 0;
        if (near > 0) {
          if (across > 0) {
            guardLeft = Math.max(guardLeft, near);
            panicLeft = Math.max(panicLeft, panic);
          } else {
            guardRight = Math.max(guardRight, near);
            panicRight = Math.max(panicRight, panic);
          }
          offset += (across > 0 ? -1 : 1) * near * 2.6;
        }
      }
    }

    /* -- 3. the move -------------------------------------------------------- */
    if (this.pass) {
      this.pass.timer += dt;
      if (!seenPassTarget) this.pass.lost += dt;
      else this.pass.lost = 0;
      const gap = this.pass.gap;
      // Done, gone, or it was never on: let it go and do not immediately
      // start another one.
      const closeIn = this.pass.closing > 0.5 ? gap / this.pass.closing : Infinity;
      if (this.pass.lost > 0.6 || gap < -7 || this.pass.timer > 12 || (gap > 45 && closeIn > 6)) {
        this.passCooldown = gap < -7 ? 0.4 : 1.4;
        this.pass = null;
      }
    }

    if (!this.pass && ahead && speed > 10 && this.passCooldown <= 0 && paceSpeed > ahead.ov.speed + 1.2) {
      const side = this.#chooseSide(ahead, s, speed, edge, lineLat, move);
      if (side !== 0) {
        this.pass = {
          ov: ahead.ov, side, timer: 0, lost: 0,
          gap: ahead.gap, closing: ahead.closing, lateral: ahead.lateral,
        };
      }
    }

    // However many cars are crowding this one, the answer is a move, not a
    // lane change across the whole circuit.
    // Off the road is not a place to be racing anybody. Whatever the move
    // was, it is over: aim at the line, rejoin, and think about the car in
    // front again once there is tarmac under all four wheels.
    if (Math.abs(q.lateral) > q.width * 0.5) {
      this.pass = null;
      this.passCooldown = Math.max(this.passCooldown, 0.8);
    }

    let wanted = this.pass || Math.abs(q.lateral) <= q.width * 0.5 ? clamp(offset, -move * 0.7, move * 0.7) : 0;
    if (this.pass) {
      // Sit a car and a half's width to the chosen side of them — in absolute
      // metres across the road, then expressed as a displacement from where
      // this driver was going to aim anyway.
      wanted += this.pass.lateral + this.pass.side * 3.9 - lineLat;
    }

    // Two bounds, both of them hard. The first is on the size of the move,
    // above: a controller that asks for nine metres in one second gets a car
    // pointing the wrong way rather than a car in a different place. The
    // second is the road itself, which is never traded away for anything — a
    // move that runs out of tarmac is a crash with a longer run-up.
    this.targetOffset = clamp(clamp(wanted, -move, move), -edge - lineLat, edge - lineLat);
    this.speedCap = cap;
    this.urgency = urgency;
    this.blocked = urgency > 0.25;
    this.guardLeft = guardLeft;
    this.guardRight = guardRight;
    // Moving away from one car and into the scenery is not an improvement, so
    // the reflex is only as strong as the road left on the side it moves to.
    // (+lateral is the car's left, so a car on the left is escaped rightwards.)
    this.panicLeft = panicLeft * clamp((q.lateral + q.width * 0.5 - 1.2) / 2, 0, 1);
    this.panicRight = panicRight * clamp((q.width * 0.5 - 1.2 - q.lateral) / 2, 0, 1);

    // A few per cent for the gap to the player. Bounded hard: a field that
    // visibly teleports back onto your gearbox is worse than one that is
    // simply slower than you.
    this.reel = playerGap === null ? 0 : clamp(playerGap / 500, -1, 1) * 0.03;
  }

  /**
   * Which side to go down, or 0 for "not yet".
   *
   * The rule a real driver uses: the inside of the corner that is coming,
   * because that is the side the move sticks on. Failing a corner worth
   * naming, whichever side is the shorter move. And in either case only if
   * the road is actually wide enough there — a pass that runs out of tarmac
   * is a crash with extra steps.
   */
  #chooseSide(ahead, s, speed, edge, lineLat, move) {
    const track = this.track;

    // Not from a mile back in a braking zone. Arriving at the corner with
    // nothing left, from a length nobody would have believed, is the move
    // that puts two cars in the gravel, and it is never worth it — but that
    // is about racing somebody. Something all but stopped in the road is not
    // a rival to be patient with, it is an obstacle, and queueing politely
    // behind it at seventy metres a second is the worse of the two options.
    const here = this.pacing.speedAt(s);
    const soon = this.pacing.speedAt(s + Math.max(20, speed * 1.1));
    if (ahead.ov.speed > 8 && soon < here - 3 && ahead.gap > 13) return 0;

    // How long before this becomes a problem. Distance on its own is the
    // wrong measure: twenty metres behind a car going the same speed is a
    // queue, and twenty metres behind a stationary one is half a second.
    const closeIn = ahead.closing > 0.5 ? ahead.gap / ahead.closing : Infinity;
    // A cautious driver sits and waits for a better chance; a bold one has a
    // go from further back. Neither gets to skip the checks below, and
    // neither gets to wait when the arithmetic says there is no time left.
    if (ahead.gap > lerp(11, 26, this.aggression) && closeIn > lerp(3.0, 6.0, this.aggression)) return 0;

    // Positive curvature bends toward +lateral, so that is the inside.
    const k = track.curvature[track.indexAt(s + Math.max(30, speed * 1.3))];
    const inside = Math.abs(k) > 0.004 ? (k > 0 ? 1 : -1) : 0;

    const order = inside !== 0 ? [inside, -inside] : ahead.lateral < 0 ? [1, -1] : [-1, 1];
    for (const side of order) {
      const lateral = ahead.lateral + side * 3.9;
      // Room on the road for both of us, and close enough to the line this
      // driver was already on that going there is a move rather than a lunge.
      if (Math.abs(lateral) <= edge && Math.abs(lateral - lineLat) <= move) return side;
    }
    return 0;
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
    this.stuckFor = (this.stuckFor ?? 0) + (v.speed < 2 && !this.blocked ? dt : -dt * 2);

    if (this.stuckFor > 7) {
      v.respawn();
      this.stuckFor = 0;
      this.recoverTimer = 0;
      this.lineOffset = 0;
      this.pass = null;
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
