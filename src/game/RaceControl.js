/**
 * The start procedure, the race length, and the flag at the end of it.
 *
 * A race that begins with the cars already moving and ends whenever you get
 * bored is not a race, it is a track day. This owns the three things that
 * make it one:
 *
 *  - **The start.** Everyone is held on the grid with the engines running
 *    while the gantry lights fill up, and released the instant they go out.
 *    The pause between the last lamp and lights-out is not fixed — it never
 *    is — so the launch is a reaction rather than a memorised count.
 *  - **The distance.** A set number of laps, chosen before the session, with
 *    the lap counter reading against it.
 *  - **The flag.** The moment the leader completes the distance the order is
 *    frozen and classified, and the cars are handed back their brakes.
 */

/** Race distances offered on the start screen. */
export const RACE_LENGTHS = [
  { id: 3, label: '3 laps', note: 'A sprint — one mistake decides it' },
  { id: 5, label: '5 laps', note: 'Long enough for the tyres to matter' },
  { id: 8, label: '8 laps', note: 'A proper race' },
  { id: 12, label: '12 laps', note: 'Bring a drink' },
];

/* The procedure, in seconds from the moment the session starts. */
const SETTLE = 1.6; // engines running, nobody moving, camera settling
const STEP = 0.7; // between one lamp and the next
const LAMPS = 5;
const COUNT_FROM = 3; // "3 … 2 … 1 …" on the way to lights out
const GO_FOR = 1.4; // how long GO stays on screen

export class RaceControl {
  /**
   * @param {object} [options]
   * @param {number} [options.laps]      race distance; 0 for an open session
   * @param {boolean} [options.standing] run the grid procedure at all
   * @param {() => number} [options.random] injectable, so a test can pin the hold
   */
  constructor({ laps = 0, standing = true, random = Math.random } = {}) {
    this.laps = laps;
    this.standing = standing;
    // The pause between the last lamp and lights out. Between a quarter of a
    // second and a second and a bit, as it is in the real thing: long enough
    // that anticipating it is a gamble, short enough that it is not a wait.
    this.hold = 0.25 + random() * 0.95;
    this.time = 0;
    this.phase = standing ? 'settle' : 'racing';
    /** Lamps currently lit, 0…5. */
    this.lamps = 0;
    /** What the screen should show: '3', '2', '1', 'GO', or null. */
    this.callout = null;
    /** Final classification once the flag is out. */
    this.classification = null;
    /** Seconds between the lights going out and the player's first input. */
    this.reaction = null;
    this.releasedAt = null;
  }

  /** True while nobody is allowed to move. */
  get holding() {
    return this.phase === 'settle' || this.phase === 'lights';
  }

  /** True once the flag is out and the result is decided. */
  get finished() {
    return this.phase === 'finished';
  }

  /** The moment the lights go out, in seconds from the session start. */
  get releaseAt() {
    return SETTLE + COUNT_FROM + this.hold;
  }

  update(dt) {
    this.time += dt;
    if (this.phase === 'finished') return;

    if (this.phase === 'settle' || this.phase === 'lights') {
      const t = this.time - SETTLE;
      if (t < 0) {
        this.phase = 'settle';
        this.lamps = 0;
        this.callout = null;
        return;
      }
      this.phase = 'lights';
      // Five lamps across the three-second count, so the last one lands on
      // "1" and the hold after it is the whole drama.
      this.lamps = Math.min(LAMPS, Math.floor(t / STEP) + 1);
      const remaining = COUNT_FROM - t;
      this.callout = String(Math.max(1, Math.ceil(remaining)));
      if (this.time >= this.releaseAt) {
        this.phase = 'go';
        this.lamps = 0;
        this.callout = 'GO';
        this.releasedAt = this.time;
      }
      return;
    }

    if (this.phase === 'go' && this.time - this.releasedAt > GO_FOR) {
      this.phase = 'racing';
      this.callout = null;
    }
  }

  /**
   * How quickly the player got off the line, recorded once.
   * @param {boolean} moving whether the player has asked for any throttle
   */
  noteLaunch(moving) {
    if (this.reaction !== null || this.releasedAt === null || !moving) return;
    this.reaction = Math.max(0, this.time - this.releasedAt);
  }

  /**
   * Called every frame with everyone's progress. Returns true on the lap the
   * flag comes out.
   *
   * @param {Array<{name: string, laps: number, distance: number, isPlayer?: boolean, best?: number|null}>} cars
   */
  check(cars) {
    if (this.phase === 'finished' || !this.laps) return false;
    if (!cars.some((c) => c.laps >= this.laps)) return false;

    // Whoever is furthest round wins; everyone else is classified where they
    // were when the leader crossed the line, which is what the flag means.
    this.classification = [...cars]
      .sort((a, b) => b.distance - a.distance)
      .map((c, i) => ({ ...c, position: i + 1 }));
    this.phase = 'finished';
    this.callout = null;
    return true;
  }
}
