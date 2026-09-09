import { clamp, curve, lerp } from '../core/MathUtils.js';

/**
 * Engine, clutch, gearbox and limited-slip differential.
 *
 * Engine speed is derived from the driven wheels through the gearing rather
 * than integrated separately, which keeps the driveline rigid and stable at
 * the timestep the chassis runs at. The clutch only comes into play when
 * pulling away and during shifts.
 */
export class Drivetrain {
  constructor(spec) {
    this.spec = spec;
    this.reset();
  }

  reset() {
    this.gear = 1; // -1 reverse, 0 neutral, 1..n
    this.engineOmega = (this.spec.idleRpm * Math.PI * 2) / 60;
    this.rpm = this.spec.idleRpm;
    this.shiftTimer = 0;
    this.clutch = 0; // engagement, 0 open … 1 fully clamped
    this.clutchTorque = 0;
    this.torqueSlope = 0;
    this.limiterCut = 0;
    this.autoShift = true;
    this.holdReverse = false;
    this.lastShiftDirection = 0;
  }

  get ratio() {
    const { gearRatios, reverseRatio, finalDrive } = this.spec;
    if (this.gear === 0) return 0;
    if (this.gear < 0) return -reverseRatio * finalDrive;
    return gearRatios[this.gear - 1] * finalDrive;
  }

  get topGear() {
    return this.spec.gearRatios.length;
  }

  /** Engine torque available at the current rpm, before the rev limiter. */
  torqueAt(rpm) {
    return curve(this.spec.torqueCurve, clamp(rpm, 800, this.spec.limiterRpm + 400));
  }

  /** Peak power in kW, used for the UI. */
  get peakPowerKw() {
    let best = 0;
    for (const [rpm, nm] of this.spec.torqueCurve) {
      best = Math.max(best, (nm * rpm * Math.PI * 2) / 60 / 1000);
    }
    return best;
  }

  /**
   * Integrates the engine against the driveline through a friction clutch.
   *
   * The engine carries its own inertia, so it can be revved independently and
   * bogged down under load. The clutch transmits torque proportional to the
   * speed difference across it, saturating at the clamp force it can hold —
   * which is what produces a real launch: slip at first, then lock-up.
   *
   * @param {number} throttle    0..1
   * @param {number} wheelOmega  average angular velocity of the driven wheels
   * @param {number} dt          timestep, s
   * @returns {number} torque delivered to the differential input, Nm
   */
  update(throttle, wheelOmega, dt, { speed = 0, brake = 0, roadOmega = wheelOmega } = {}) {
    const spec = this.spec;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.roadOmega = roadOmega;

    const idleOmega = (spec.idleRpm * Math.PI * 2) / 60;
    const limiterOmega = (spec.limiterRpm * Math.PI * 2) / 60;

    /* -- clutch engagement ------------------------------------------------ */
    // Locks up as the driveline catches the engine, and bites under throttle
    // so the car can be launched from rest.
    const gearOmega = this.gear === 0 ? 0 : wheelOmega * this.ratio;
    const gearRpm = Math.abs(gearOmega) * (60 / (Math.PI * 2));
    const rolling = clamp((gearRpm - spec.idleRpm * 0.5) / (spec.stallRpm - spec.idleRpm * 0.5), 0, 1);
    const bite = clamp(throttle * 1.1, 0, 1);
    const target = this.gear === 0 || this.shiftTimer > 0 ? 0 : Math.max(rolling, bite);
    this.clutch = lerp(this.clutch, target, 1 - Math.exp(-24 * dt));

    // With the clutch open mid-shift the engine is rev-matched to whatever the
    // new gear will ask for. Without this it stays pinned on the limiter and
    // the box walks straight up through every remaining ratio.
    if (this.shiftTimer > 0 && this.gear !== 0) {
      const matched = Math.max(Math.abs(gearOmega), idleOmega);
      this.engineOmega = lerp(this.engineOmega, matched, 1 - Math.exp(-30 * dt));
      this.rpm = this.engineOmega * (60 / (Math.PI * 2));
    }

    /* -- engine ----------------------------------------------------------- */
    const cut = this.limiterCut > 0 ? 0 : 1;
    let engineTorque = this.torqueAt(this.rpm) * throttle * cut;

    // Idle governor: holds the engine off its stop when the driver is off it.
    engineTorque += clamp((idleOmega - this.engineOmega) / 12, 0, 1) * spec.engineBrakeTorque * 2.2;

    // Internal friction and pumping losses rise with rpm.
    engineTorque -=
      spec.engineBrakeTorque * (0.2 + (this.engineOmega / limiterOmega) * 0.8) * (1 - throttle);

    // Clutch torque: proportional to slip, capped by the clamp force. The
    // stiffness is chosen so the lock-up is stable at the physics timestep.
    const slip = this.engineOmega - gearOmega;
    // Ease the clamp force off near idle so a slipping clutch can never drag
    // the engine down and stall it — the same thing a driver does with their
    // left foot when pulling away.
    const headroom = clamp(
      (this.rpm - spec.idleRpm * 0.8) / (spec.stallRpm - spec.idleRpm * 0.8),
      0.12,
      1,
    );
    const capacity = spec.clutchCapacity * this.clutch * headroom;
    this.clutchTorque = clamp(slip * spec.clutchStiffness, -capacity, capacity);

    this.engineOmega += ((engineTorque - this.clutchTorque) / spec.engineInertia) * dt;
    this.engineOmega = Math.max(this.engineOmega, idleOmega * 0.45);
    this.rpm = this.engineOmega * (60 / (Math.PI * 2));

    // Rev limiter: a hard cut with a short recovery, so it audibly bounces.
    if (this.rpm >= spec.limiterRpm) {
      this.limiterCut = 0.045;
      this.engineOmega = limiterOmega;
      this.rpm = spec.limiterRpm;
    }
    this.limiterCut = Math.max(0, this.limiterCut - dt);

    if (this.autoShift) this.#autoShift(throttle, speed, brake, roadOmega);

    if (this.gear === 0 || this.shiftTimer > 0) {
      this.torqueSlope = 0;
      return 0;
    }

    // ∂(wheel torque)/∂(wheel speed) through the clutch. In a low gear the
    // ratio squared makes this enormous, so the wheel integrator needs it to
    // stay stable — otherwise the driveline judders itself apart.
    this.torqueSlope =
      -spec.clutchStiffness * this.ratio * this.ratio * spec.drivelineEfficiency;

    return this.clutchTorque * this.ratio * spec.drivelineEfficiency;
  }

  #autoShift(throttle, speed, brake, roadOmega = 0) {
    if (this.shiftTimer > 0) return;
    const spec = this.spec;

    // Engine speed the road would impose in a given gear. Under hard braking
    // the driven wheels run well below road speed (and under power well
    // above it), and a box that read the engine at those moments would drop
    // to first at 90 km/h — then hurl the rears into a slide when the
    // rev-match caught up. Real automatics choose gears from road speed.
    const roadRpm = (ratio) => (Math.abs(roadOmega) * ratio * 60) / (Math.PI * 2);

    // Pull away — but never override a reverse the driver asked for, or a
    // car trying to back out of a gravel trap would be shifted into first on
    // the very next step.
    if (this.gear <= 0 && !this.holdReverse && throttle > 0.02 && speed > -0.4) {
      this.shiftTo(1);
      return;
    }

    // Upshift on engine speed under power — that is when it matters — but
    // never while the wheels are spinning up faster than the road: a car
    // lighting its rears in first would otherwise be shifted into second
    // mid-slide, and the road-speed check below would drop it straight back.
    const upAt = lerp(spec.upshiftRpm * 0.82, spec.upshiftRpm, clamp(throttle * 1.3, 0, 1));
    if (this.gear > 0 && this.gear < this.topGear && this.rpm > upAt) {
      const inThisGear = roadRpm(this.ratio);
      if (inThisGear > upAt * 0.8) {
        this.shiftTo(this.gear + 1);
        return;
      }
    }

    // Downshift when the next gear down would not over-rev, biased earlier
    // under braking so the car is in the right gear at corner entry. Judged
    // from road speed, so a locked or spinning wheel cannot fool it.
    if (this.gear > 1) {
      const nextRatio = spec.gearRatios[this.gear - 2] * spec.finalDrive;
      const current = roadRpm(this.ratio);
      const projected = roadRpm(nextRatio);
      const threshold = spec.downshiftRpm * (brake > 0.15 ? 1.06 : 1);
      if (current < threshold && projected < spec.limiterRpm * 0.9) {
        this.shiftTo(this.gear - 1);
      }
    }
  }

  shiftTo(gear) {
    if (gear === this.gear) return;
    const clamped = clamp(gear, -1, this.topGear);
    if (clamped === this.gear) return;
    this.lastShiftDirection = Math.sign(clamped - this.gear);
    this.holdReverse = clamped < 0;
    this.gear = clamped;
    this.shiftTimer = this.spec.shiftTime;
    this.clutch = 0;
    this.clutchTorque = 0;
  }

  shiftUp() {
    if (this.gear < this.topGear) this.shiftTo(this.gear + 1);
  }

  shiftDown() {
    if (this.gear > -1) this.shiftTo(this.gear - 1);
  }

  /**
   * Splits drive torque between the two driven wheels through a limited-slip
   * differential: an open diff plus a locking term proportional to the speed
   * difference across it, capped by the torque bias ratio.
   */
  splitTorque(torque, omegaLeft, omegaRight) {
    const { diffPreload, diffLock } = this.spec;
    const half = torque * 0.5;
    const delta = omegaLeft - omegaRight;
    // Locking torque resists the faster wheel.
    const lock = clamp(delta * diffLock + Math.sign(delta) * diffPreload, -Math.abs(torque) * 0.9 - diffPreload, Math.abs(torque) * 0.9 + diffPreload);
    return [half - lock, half + lock];
  }
}

/* ------------------------------------------------------------------ specs */

/** Naturally aspirated mid-engine V8, ~600 hp at 9 000 rpm. */
export const V8_NA = {
  name: '4.5 V8',
  cylinders: 8,
  torqueCurve: [
    [800, 240],
    [1500, 340],
    [2500, 425],
    [3500, 478],
    [4500, 512],
    [5500, 534],
    [6000, 540],
    [7000, 532],
    [8000, 508],
    [9000, 472],
    [9500, 424],
  ],
  idleRpm: 900,
  stallRpm: 1450,
  limiterRpm: 9200,
  upshiftRpm: 8850,
  downshiftRpm: 3400,
  gearRatios: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69],
  reverseRatio: 2.9,
  finalDrive: 4.3,
  shiftTime: 0.075,
  drivelineEfficiency: 0.9,
  engineBrakeTorque: 36,
  engineInertia: 0.34,
  clutchCapacity: 780,
  clutchStiffness: 55,
  diffPreload: 120,
  diffLock: 46,
};

/** Twin-turbo V10 for the concept car: more torque, shorter gearing. */
export const V10_TT = {
  name: '5.2 V10 TT',
  cylinders: 10,
  torqueCurve: [
    [800, 320],
    [1500, 520],
    [2200, 690],
    [3000, 760],
    [4000, 790],
    [5000, 782],
    [6000, 748],
    [7000, 690],
    [8000, 606],
    [8600, 540],
  ],
  idleRpm: 850,
  stallRpm: 1350,
  limiterRpm: 8400,
  upshiftRpm: 8050,
  downshiftRpm: 3100,
  gearRatios: [3.42, 2.32, 1.71, 1.34, 1.09, 0.9, 0.75],
  reverseRatio: 3.1,
  finalDrive: 4.05,
  shiftTime: 0.06,
  drivelineEfficiency: 0.9,
  engineBrakeTorque: 42,
  engineInertia: 0.42,
  clutchCapacity: 1150,
  clutchStiffness: 68,
  diffPreload: 160,
  diffLock: 58,
};

/** Twin-turbo flat-six for the 911: a broad plateau of torque, PDK-quick shifts. */
export const F6_TT = {
  name: '3.0 flat-six TT',
  cylinders: 6,
  torqueCurve: [
    [800, 180],
    [1500, 330],
    [2300, 530],
    [3500, 530],
    [5000, 530],
    [6000, 510],
    [6500, 480],
    [7000, 440],
    [7500, 380],
  ],
  idleRpm: 800,
  stallRpm: 1300,
  limiterRpm: 7500,
  upshiftRpm: 7200,
  downshiftRpm: 3000,
  gearRatios: [3.9, 2.4, 1.72, 1.32, 1.06, 0.88, 0.75, 0.64],
  reverseRatio: 3.5,
  finalDrive: 3.6,
  shiftTime: 0.05,
  drivelineEfficiency: 0.91,
  engineBrakeTorque: 30,
  engineInertia: 0.28,
  clutchCapacity: 900,
  clutchStiffness: 60,
  diffPreload: 100,
  diffLock: 40,
};

/** Twin-turbo V8 for the Urus: 850 Nm from just off idle, an eight-speed automatic. */
export const V8_TT = {
  name: '4.0 V8 TT',
  cylinders: 8,
  torqueCurve: [
    [800, 300],
    [1500, 600],
    [2250, 850],
    [3500, 850],
    [4500, 850],
    [5500, 800],
    [6000, 730],
    [6500, 650],
    [6800, 570],
  ],
  idleRpm: 750,
  stallRpm: 1250,
  limiterRpm: 6800,
  upshiftRpm: 6500,
  downshiftRpm: 2600,
  gearRatios: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67],
  reverseRatio: 3.3,
  finalDrive: 3.3,
  shiftTime: 0.09,
  drivelineEfficiency: 0.89,
  engineBrakeTorque: 48,
  engineInertia: 0.5,
  clutchCapacity: 1400,
  clutchStiffness: 70,
  diffPreload: 150,
  diffLock: 60,
};

/**
 * The Datsun's 2.4 litre straight-six, in period race trim: triple carburettors,
 * a hotter cam, about 200 hp, and a five-speed you shift yourself.
 */
export const L6_RACE = {
  name: '2.4 L24 straight-six',
  cylinders: 6,
  torqueCurve: [
    [800, 120],
    [1500, 170],
    [2500, 205],
    [3500, 222],
    [4500, 232],
    [5500, 232],
    [6300, 222],
    [6800, 205],
    [7200, 180],
  ],
  idleRpm: 950,
  stallRpm: 1400,
  limiterRpm: 7200,
  upshiftRpm: 6900,
  downshiftRpm: 3200,
  gearRatios: [3.32, 2.08, 1.31, 1.0, 0.86],
  reverseRatio: 3.4,
  finalDrive: 3.9,
  shiftTime: 0.18,
  drivelineEfficiency: 0.88,
  engineBrakeTorque: 30,
  engineInertia: 0.25,
  clutchCapacity: 420,
  clutchStiffness: 45,
  diffPreload: 60,
  diffLock: 25,
};
