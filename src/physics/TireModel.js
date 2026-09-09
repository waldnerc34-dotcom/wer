import { clamp, lerp } from '../core/MathUtils.js';

/**
 * A Pacejka-style tyre.
 *
 * Longitudinal and lateral forces come from the Magic Formula, combined
 * through a slip circle so that a locked wheel cannot also generate cornering
 * force — the behaviour that makes trail braking and throttle-steer work.
 *
 * On top of the steady-state curve the model carries the three things that
 * actually decide lap time in a real car:
 *
 *  - **Load sensitivity.** Peak grip rises less than linearly with vertical
 *    load, so a car that transfers weight badly loses total grip.
 *  - **Relaxation length.** Slip builds over distance travelled, not instantly.
 *    This is what stops the solver exploding at low speed and gives the car
 *    its slight delay between steering input and response.
 *  - **Temperature.** Grip peaks in a working window; abuse the tyres and they
 *    go off.
 */
export class Tyre {
  constructor(config = {}) {
    Object.assign(
      this,
      {
        // Magic Formula coefficients (B stiffness, C shape, E curvature).
        //
        // Slip is fed in normalised by `kappaPeak` / `alphaPeak`, so B is
        // chosen to put the peak of the curve at a normalised slip of 1.0
        // rather than in raw slip units — B ≈ 1.7 rather than the ≈ 10 that
        // the same C and E would need on un-normalised inputs.
        Bx: 1.66,
        Cx: 1.65,
        Ex: 0.42,
        By: 1.8,
        Cy: 1.38,
        Ey: -0.6,

        /** Peak friction coefficient at the reference load. */
        mu: 1.48,
        /** Reference vertical load, N. */
        Fz0: 3800,
        /** Load-sensitivity falloff: higher = more grip lost when overloaded. */
        loadSensitivity: 0.14,

        /** Slip at which each curve peaks; used to normalise the slip circle. */
        kappaPeak: 0.11,
        alphaPeak: 0.16, // radians (~9°)

        /** Relaxation lengths, metres. */
        relaxLong: 0.28,
        relaxLat: 0.42,

        /** Temperature model, °C. */
        tempOptimal: 88,
        tempWindow: 45,
        tempCold: 0.82, // grip multiplier far below the window
        tempAmbient: 22,
        heatRate: 0.00052, // °C per joule of slip work
        coolRate: 0.05,
        tempStart: 68,

        /** Rolling resistance coefficient. */
        rollingResistance: 0.014,

        radius: 0.345,
        inertia: 1.35,
      },
      config,
    );

    this.reset();
  }

  reset() {
    this.kappa = 0; // lagged slip ratio
    this.alpha = 0; // lagged slip angle, radians
    this.temp = this.tempStart ?? 68;
    this.wear = 0; // 0 fresh … 1 worn out
    this.load = 0;
    this.Fx = 0;
    this.Fy = 0;
    this.slipSpeed = 0;
    this.gripUsed = 0;
    this.slipNorm = 0;
    this.lagLong = 1;
  }

  /** Grip multiplier from the current carcass temperature. */
  temperatureFactor() {
    const d = Math.abs(this.temp - this.tempOptimal) / this.tempWindow;
    if (d <= 1) return lerp(1, 0.955, d * d);
    // Falls away either side of the window, cold more forgivingly than hot.
    const over = clamp(d - 1, 0, 2.2);
    const hot = this.temp > this.tempOptimal;
    return clamp(0.955 - over * (hot ? 0.16 : 0.09), this.tempCold, 1);
  }

  /**
   * Advances the lagged slip state.
   *
   * @param {number} vLong   contact-patch speed along the wheel, m/s
   * @param {number} vLat    contact-patch speed across the wheel, m/s
   * @param {number} omega   wheel angular velocity, rad/s
   * @param {number} dt      timestep, s
   */
  updateSlip(vLong, vLat, omega, dt) {
    const speed = Math.max(Math.abs(vLong), 0.6);

    const kappaTarget = clamp((omega * this.radius - vLong) / speed, -4, 4);
    const alphaTarget = Math.atan2(-vLat, speed);

    // First-order lag over distance travelled, not time: at a standstill the
    // slip state simply holds instead of ringing.
    const kx = clamp((Math.abs(vLong) * dt) / this.relaxLong, 0, 1);
    const ky = clamp((Math.abs(vLong) * dt) / this.relaxLat, 0, 1);

    // Below walking pace, bleed toward the target on a time constant so the
    // car still responds while parked.
    const floor = clamp(dt * 6, 0, 1);
    this.lagLong = Math.max(kx, floor);
    this.kappa = lerp(this.kappa, kappaTarget, this.lagLong);
    this.alpha = lerp(this.alpha, alphaTarget, Math.max(ky, floor));
  }

  /**
   * Evaluates tyre forces for the current slip state.
   *
   * @param {number} Fz          vertical load, N (>= 0)
   * @param {number} surfaceGrip friction multiplier for the surface
   * @returns {{Fx:number, Fy:number}} forces in the contact plane
   */
  forces(Fz, surfaceGrip) {
    this.load = Fz;
    if (Fz <= 1) {
      this.Fx = 0;
      this.Fy = 0;
      this.gripUsed = 0;
      this.slipNorm = 0;
      return this;
    }

    // Peak friction falls off as load rises above the reference.
    const loadRatio = Fz / this.Fz0;
    const muLoad = 1 - this.loadSensitivity * (loadRatio - 1);
    const mu =
      this.mu *
      clamp(muLoad, 0.55, 1.35) *
      surfaceGrip *
      this.temperatureFactor() *
      (1 - this.wear * 0.22);

    // Slip circle: normalise both slips, evaluate one curve, then split the
    // resulting force back along the slip direction.
    const sx = this.kappa / this.kappaPeak;
    const sy = Math.tan(this.alpha) / this.alphaPeak;
    const s = Math.hypot(sx, sy);

    if (s < 1e-6) {
      this.Fx = 0;
      this.Fy = 0;
      this.gripUsed = 0;
      this.slipNorm = 0;
      return this;
    }

    // Blend the longitudinal and lateral shape factors by slip direction so
    // pure braking and pure cornering each keep their own curve shape.
    const w = (sx * sx) / (s * s);
    const B = lerp(this.By, this.Bx, w);
    const C = lerp(this.Cy, this.Cx, w);
    const E = lerp(this.Ey, this.Ex, w);

    const arg = B * s;
    const magic = Math.sin(C * Math.atan(arg - E * (arg - Math.atan(arg))));
    const F = mu * Fz * magic;

    this.Fx = (sx / s) * F;
    this.Fy = (sy / s) * F;
    this.gripUsed = clamp(Math.abs(magic), 0, 1);
    // Combined slip, normalised so the curve peaks at 1: the anti-lock and
    // traction logic read this rather than the longitudinal slip alone,
    // because a tyre already leaning on its cornering grip locks up sooner.
    this.slipNorm = s;
    return this;
  }

  /**
   * Slope of the longitudinal force curve at zero slip, in newtons per unit
   * slip ratio. The wheel-spin integrator needs this to stay stable: the tyre
   * is a very stiff spring between the hub and the road, and an explicit step
   * at any sane timestep would ring.
   */
  slipStiffness(Fz, surfaceGrip) {
    return this.mu * surfaceGrip * Fz * this.Bx * this.Cx / this.kappaPeak;
  }

  /**
   * Heats the tyre from the work done sliding, and cools it toward ambient.
   *
   * @param {number} slipSpeed sliding speed of the contact patch, m/s
   * @param {number} dt        timestep, s
   */
  thermal(slipSpeed, dt, airspeed = 0) {
    this.slipSpeed = slipSpeed;
    const forceMag = Math.hypot(this.Fx, this.Fy);
    const work = forceMag * slipSpeed; // watts dissipated in the patch
    this.temp += work * this.heatRate * dt;
    const cooling = this.coolRate * (1 + airspeed * 0.055);
    this.temp += (this.tempAmbient - this.temp) * cooling * dt;
    this.wear = clamp(this.wear + work * 2.4e-9 * dt, 0, 1);
  }
}

/** Front and rear tyre specs for a mid-engined supercar on road-legal rubber. */
export const TYRE_SPECS = {
  front: {
    radius: 0.3355, // 245/35 R20
    mu: 1.42,
    Fz0: 3400,
    By: 1.86,
    Cy: 1.4,
    alphaPeak: 0.155,
    inertia: 1.25,
  },
  rear: {
    radius: 0.3485, // 305/30 R20
    mu: 1.5,
    Fz0: 4300,
    By: 1.78,
    Cy: 1.36,
    alphaPeak: 0.168,
    inertia: 1.6,
  },
};
