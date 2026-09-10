/** Clock samples kept per peer; the least delayed one is believed. */
const KEEP = 8;

/**
 * Estimates the difference between our clock and one peer's.
 *
 * Both machines are timing from an arbitrary origin, so a snapshot stamped on
 * theirs means nothing here until it is moved onto ours. The measurement is a
 * plain round trip, and the only real question is which sample to believe: the
 * one that came back quickest. A slow round trip has spent unknown and unequal
 * amounts of time in each direction, so its guess at the midpoint is worthless,
 * while the quickest sample of the last few is the one least contaminated by
 * queueing along the way. This is what NTP does, for the same reason.
 */
export class Sync {
  constructor({ keep = KEEP, ease = 0.25 } = {}) {
    this.keep = keep;
    this.ease = ease;
    this.samples = [];
    this.offset = 0;
    this.rtt = 0;
    this.settled = false;
  }

  /**
   * @param {number} offset add this to a peer stamp to land it on our clock
   * @param {number} rtt milliseconds the measurement itself took
   */
  add(offset, rtt) {
    this.samples.push({ offset, rtt });
    if (this.samples.length > this.keep) this.samples.shift();

    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;

    // Ease onto a new estimate rather than stepping to it: a step moves every
    // buffered snapshot at once, and that shows up on screen as a twitch.
    this.offset = this.settled
      ? this.offset + (best.offset - this.offset) * this.ease
      : best.offset;
    this.rtt = best.rtt;
    this.settled = true;
    return this.offset;
  }
}
