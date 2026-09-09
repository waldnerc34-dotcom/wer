import { clamp, lerp, wrap } from '../core/MathUtils.js';

/** What the driver should be doing at a point on the racing line. */
export const PHASE = { ACCELERATE: 0, HOLD: 1, BRAKE: 2 };

/**
 * The ideal speed profile around the racing line, and the phase it implies.
 *
 * Three passes: the cornering limit from the line's curvature (with camber),
 * a backward pass that pulls speed down ahead of every corner at whatever
 * braking the friction circle and the grade leave, and a forward pass that
 * lets it climb out at what the engine and traction can give. It is the
 * profile the AI drives to and the arrows are painted from, and it re-runs
 * whenever the weather changes the grip.
 */
export class Pacing {
  /**
   * @param {import('./Track.js').Track} track
   * @param {object} car   lateralG, brakingG (m/s²), powerKw, mass, topSpeed;
   *                       forwardPass=false skips the engine limit
   */
  constructor(track, car = {}) {
    this.track = track;
    this.car = {
      lateralG: 11.2,
      brakingG: 11.5,
      powerKw: 340,
      mass: 1440,
      topSpeed: 92,
      ...car,
    };
    this.speed = new Float32Array(track.count);
    this.phase = new Uint8Array(track.count);
    this.compute();
  }

  compute() {
    const { track, car } = this;
    const n = track.count;
    const ds = track.spacing;
    const grip = track.grip(0);
    const v = this.speed;
    const G = 9.81;

    // Road geometry the tyres feel: the grade (positive uphill) trades against
    // braking and acceleration, and camber that drops the inside of a corner
    // adds to what the tyres can hold across it.
    if (!this.grade) {
      this.grade = new Float32Array(n);
      this.camber = new Float32Array(n);
      this.latMax = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      const y0 = track.pos[i * 3 + 1];
      const y1 = track.pos[wrap(i + 1, n) * 3 + 1];
      this.grade[i] = (y1 - y0) / ds;
      // Positive bank lowers the +lateral side; positive curvature turns
      // toward +lateral. Their product is positive when the inside is lower.
      this.camber[i] = Math.sin(track.bank[i]) * Math.sign(track.curvature[i] || 0);
    }

    // Cornering limit. Downforce lifts it at speed, so iterate once.
    for (let i = 0; i < n; i++) {
      const k = Math.abs(track.lineCurvature[i]);
      const latMax = Math.max(car.lateralG * grip * 0.6, car.lateralG * grip + G * this.camber[i]);
      this.latMax[i] = latMax;
      let vc = car.topSpeed;
      if (k > 1e-5) {
        vc = Math.sqrt(latMax / k);
        const aero = 1 + clamp((vc - 40) / 90, 0, 1) * 0.5;
        vc = Math.min(car.topSpeed, Math.sqrt((latMax * aero) / k));
      }
      v[i] = vc;
    }

    // How much of the tyre is left for braking or driving once the corner has
    // taken its share: the friction circle. Never quite zero — even at the
    // limit a driver can bleed a little speed.
    const longitudinalShare = (i) => {
      const k = Math.abs(track.lineCurvature[i]);
      const lateral = (v[i] * v[i] * k) / this.latMax[i];
      return Math.sqrt(Math.max(0, 1 - lateral * lateral)) * 0.85 + 0.15;
    };

    // Backward pass, twice round so the seam closes: cannot be faster here
    // than we can slow down from for what is coming. Braking downhill has
    // gravity working against it.
    const brake = car.brakingG * grip;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 2 * n; j > 0; j--) {
        const i = wrap(j, n);
        const next = wrap(j + 1, n);
        const aLong = Math.max(0.5, brake * longitudinalShare(next) + G * this.grade[next]);
        v[i] = Math.min(v[i], Math.sqrt(v[next] * v[next] + 2 * aLong * ds));
      }
    }

    // Forward pass: cannot be faster than the engine can make us. Skipped for
    // a planner that only wants to know where it must be slow.
    if (car.forwardPass !== false) {
      const kw = car.powerKw * 1000;
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < 2 * n; j++) {
          const i = wrap(j, n);
          const prev = wrap(j - 1, n);
          const traction = 8.5 * grip * longitudinalShare(prev);
          const accel = Math.max(
            0.3,
            Math.min(traction, kw / (car.mass * Math.max(v[prev], 8))) - G * this.grade[prev],
          );
          v[i] = Math.min(v[i], Math.sqrt(v[prev] * v[prev] + 2 * accel * ds));
        }
      }
    }

    // Phase from the implied acceleration. Braking is unambiguous; between
    // holding through a corner and squeezing back on there is a band where
    // "hold" is the honest instruction.
    for (let i = 0; i < n; i++) {
      const next = wrap(i + 1, n);
      const a = (v[next] * v[next] - v[i] * v[i]) / (2 * ds);
      const k = Math.abs(track.lineCurvature[i]);
      const lateral = (v[i] * v[i] * k) / this.latMax[i]; // share of the limit
      if (a < -1.4) this.phase[i] = PHASE.BRAKE;
      else if (a > 0.9 && lateral < 0.82) this.phase[i] = PHASE.ACCELERATE;
      else this.phase[i] = PHASE.HOLD;
    }

    // The profile's implied acceleration ripples around the thresholds
    // through a long corner, which would paint the arrows brake / hold /
    // brake every few metres. Zones shorter than about 15 m are absorbed
    // into the zone before them, twice over, so what remains reads as
    // instructions rather than noise.
    const minRun = Math.max(2, Math.round(15 / ds));
    for (let pass = 0; pass < 2; pass++) {
      // Start at a zone boundary so the seam does not split a run.
      let origin = 0;
      while (origin < n && this.phase[origin] === this.phase[wrap(origin - 1, n)]) origin++;
      if (origin === n) break; // one phase the whole way round
      let i = origin;
      let runStart = origin;
      let runPhase = this.phase[origin];
      let prevPhase = this.phase[wrap(origin - 1, n)];
      for (let step = 1; step <= n; step++) {
        i = wrap(origin + step, n);
        const ph = this.phase[i];
        if (ph !== runPhase || step === n) {
          const length = wrap(i - runStart, n) || n;
          if (length < minRun) {
            for (let k = 0; k < length; k++) this.phase[wrap(runStart + k, n)] = prevPhase;
          } else {
            prevPhase = runPhase;
          }
          runStart = i;
          runPhase = ph;
        }
      }
    }
    return this;
  }

  /** Ideal speed at arc length `s`, m/s. */
  speedAt(s) {
    const f = wrap(s / this.track.spacing, this.track.count);
    const i0 = Math.floor(f);
    const i1 = wrap(i0 + 1, this.track.count);
    return lerp(this.speed[i0], this.speed[i1], f - i0);
  }

  phaseAt(s) {
    return this.phase[Math.floor(wrap(s / this.track.spacing, this.track.count))];
  }
}
