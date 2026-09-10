import { clamp } from '../core/MathUtils.js';

/**
 * Braking help.
 *
 * The circuit already knows how fast the car should be going everywhere on
 * it: `src/track/Pacing.js` builds a whole-lap speed profile from the racing
 * line's curvature, the camber, the grade and the friction circle, and it is
 * what the coloured arrows on the road are drawn from. So the assist has
 * nothing to invent. It reads the speed the profile wants a moment ahead of
 * where the car is, and if the car is going faster than that, it brakes.
 *
 * Because the profile's backward pass has already spread each corner's
 * braking back up the road, reading it a little ahead is the same thing as
 * braking at the right point — no separate model of stopping distance, and
 * it moves with the weather, since the profile is rebuilt when the grip
 * changes.
 *
 * The levels differ in how much overspeed they tolerate before stepping in,
 * how far ahead they look, and whether they also lift the throttle:
 *
 *  - **Full** brakes for you into every corner and closes the throttle while
 *    it does. Hold the throttle down for a whole lap and the car will still
 *    make the corners; steering is yours.
 *  - **Assisted** lets you brake and only intervenes once you are carrying
 *    more speed than the corner will take, which is how you learn where the
 *    braking points are without being punished for missing one.
 *  - **Safety net** waits until the corner is nearly lost.
 *  - **Off** is off.
 */
export const ASSIST_LEVELS = [
  { id: 'high', label: 'Full', note: 'Brakes for you into every corner' },
  { id: 'medium', label: 'Assisted', note: 'Steps in when you carry too much speed' },
  { id: 'low', label: 'Safety net', note: 'Only when the corner is nearly lost' },
  { id: 'off', label: 'Off', note: 'You do the braking' },
];

/**
 * `look`   seconds of road ahead the assist reads the profile at
 * `margin` m/s of overspeed tolerated before it touches the brake
 * `span`   m/s of overspeed between first touch and full braking
 * `lift`   how hard the throttle is cut per unit of braking; 3 means any
 *          real braking closes it completely, which is what a driver does —
 *          leaving part throttle against part brake has the engine fighting
 *          the discs, and the car arrives at the corner too fast anyway
 * `max`    the most brake it will ever ask for
 */
const TUNING = {
  high: { look: 1.0, margin: 0, span: 5, lift: 3, max: 1 },
  medium: { look: 0.8, margin: 2.5, span: 9, lift: 1.5, max: 0.9 },
  low: { look: 0.6, margin: 7, span: 13, lift: 0, max: 0.8 },
};

export class DrivingAssist {
  /** @param {'high'|'medium'|'low'|'off'} level */
  constructor(level = 'high') {
    this.setLevel(level);
    /** How hard the assist is braking right now, for the HUD. */
    this.braking = 0;
  }

  setLevel(level) {
    this.level = TUNING[level] ? level : 'off';
    this.tuning = TUNING[this.level] ?? null;
    if (!this.tuning) this.braking = 0;
  }

  get active() {
    return Boolean(this.tuning);
  }

  /**
   * Folds the assist into the driver's own controls, in place.
   *
   * It only ever adds brake — a player pressing harder than the assist wants
   * is left alone — and on the full setting it eases the throttle by the
   * same amount, so holding it flat into a hairpin still slows the car.
   *
   * @param {{throttle:number, brake:number}} controls
   * @param {object} context
   * @param {number} context.speed    m/s
   * @param {number} context.s        arc length along the circuit, m
   * @param {import('../track/Pacing.js').Pacing} context.pacing
   * @returns {number} how much brake the assist asked for, 0…1
   */
  apply(controls, { speed, s, pacing }) {
    const t = this.tuning;
    // Below walking pace there is nothing to save anyone from, and reversing
    // out of a gravel trap should not be fought.
    if (!t || !pacing || speed < 8) {
      this.braking = 0;
      return 0;
    }

    // The slowest the profile gets anywhere in the next second of road, not
    // the speed at one point in it. A single sample steps over the entry to
    // a hairpin the way a coarse ray steps over a car: the sample lands
    // before the corner or after it, and the brakes come on late either way.
    const lookahead = Math.max(8, speed * t.look);
    let target = Infinity;
    for (let i = 1; i <= 8; i++) {
      target = Math.min(target, pacing.speedAt(s + (lookahead * i) / 8));
    }
    const over = speed - target - t.margin;
    if (over <= 0) {
      this.braking = 0;
      return 0;
    }

    const demand = clamp(over / t.span, 0, t.max);
    controls.brake = Math.max(controls.brake, demand);
    if (t.lift > 0) controls.throttle = Math.min(controls.throttle, Math.max(0, 1 - demand * t.lift));
    this.braking = demand;
    return demand;
  }
}
