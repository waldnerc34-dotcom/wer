/**
 * Dynamic resolution.
 *
 * The cheapest frame rate in a game like this comes from drawing fewer
 * pixels, and the number of pixels a machine can afford is not knowable in
 * advance: the same preset runs on a laptop with the lid half shut and on a
 * desktop with a discrete GPU, and the same machine is faster on a straight
 * than it is with a full field in the rain.
 *
 * So the renderer measures how long frames take and scales what it draws to
 * fit. Everything else — shadow maps, the post chain, the scenery — stays as
 * the player set it; only the pixel count moves, which is the axis the eye
 * forgives most, because the image is resolved back up to the display and
 * anti-aliased on the way.
 *
 * The control law is deliberately dull:
 *
 *  - Decide on the **median** of a window of frames, not the mean. One
 *    500 ms hitch while a shader compiles should not drop the resolution.
 *  - Correct by the square root of the overshoot, because cost goes with
 *    pixels and pixels go with the square of the scale — so the correction
 *    lands in one move rather than hunting.
 *  - Come down quickly, go back up slowly, and never do either twice in a
 *    row without a fresh window in between: changing the scale reallocates
 *    every render target, which is itself a stutter.
 */
export class ResolutionScaler {
  /**
   * @param {object} [options]
   * @param {number} [options.target]  frames per second to hold
   * @param {number} [options.min]     smallest share of the preset's resolution
   * @param {number} [options.max]     largest share; above 1 is supersampling
   * @param {number} [options.window]  frames measured before each decision
   */
  constructor({ target = 60, min = 0.62, max = 1, window = 30 } = {}) {
    this.target = target;
    this.min = min;
    this.max = max;
    this.window = window;
    this.scale = Math.min(1, max);
    this.samples = [];
    this.changes = 0;
    this.enabled = true;
    /** Windows closed, so a caller can tell a fresh decision from a stale one. */
    this.windows = 0;
    /**
     * The last window's finding: -1 short of the target, +1 room to spare,
     * 0 on it. Pixels are only the first thing a renderer can trade, and when
     * the scale is already on the floor and this still reads -1 there is
     * nothing left to give — which is the renderer's cue to give up a feature
     * instead of another tenth of the resolution.
     */
    this.verdict = 0;
  }

  /** Forgets the current window — after a resize, a pause, or a new session. */
  reset() {
    this.samples.length = 0;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    this.reset();
  }

  /** The largest scale allowed, e.g. when the player changes preset. */
  setBounds(min, max) {
    this.min = min;
    this.max = max;
    this.scale = Math.min(Math.max(this.scale, min), max);
    this.reset();
  }

  /**
   * Records one frame.
   *
   * @param {number} dt seconds the frame took
   * @returns {number|null} the new scale when it changed, otherwise null
   */
  frame(dt) {
    if (!this.enabled) return null;
    // A frame this long is a tab switch, a shader compile or a breakpoint —
    // evidence about the machine's schedule, not about its GPU.
    if (!(dt > 0) || dt > 0.5) return null;

    this.samples.push(dt);
    if (this.samples.length < this.window) return null;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.samples.length = 0;

    const budget = 1 / this.target;
    const previous = this.scale;
    this.windows++;
    this.verdict = median > budget * 1.12 ? -1 : median < budget * 0.74 ? 1 : 0;

    if (median > budget * 1.12) {
      // Cost goes with the pixel count, which goes with the square of the
      // scale, so the square root of the overshoot is the correction. Capped,
      // because one bad window should not halve the image.
      const correction = Math.sqrt(budget / median);
      this.scale = Math.max(this.min, this.scale * Math.max(0.78, correction));
    } else if (median < budget * 0.74 && this.scale < this.max) {
      // Headroom: creep back up. Slowly, so a frame rate sitting just above
      // the target does not sawtooth.
      this.scale = Math.min(this.max, this.scale * 1.06);
    }

    if (Math.abs(this.scale - previous) < 0.015) {
      this.scale = previous;
      return null;
    }
    this.changes++;
    return this.scale;
  }
}
