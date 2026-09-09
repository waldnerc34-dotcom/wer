import { wrap, wrapDelta } from '../core/MathUtils.js';

const SECTORS = 3;

/** Formats seconds as m:ss.mmm, or a dash when there is no time yet. */
export function formatLap(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

/** Formats a delta as +/-s.mmm. */
export function formatDelta(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const sign = seconds >= 0 ? '+' : '-';
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}

/**
 * Lap and sector timing for one car.
 *
 * Progress is tracked by arc length rather than by trigger volumes, so a lap
 * only counts if the car actually went the whole way round — cutting back onto
 * the circuit after a spin cannot skip a sector.
 */
export class LapTimer {
  constructor(track, { requiredFraction = 0.92 } = {}) {
    this.track = track;
    this.requiredFraction = requiredFraction;
    this.sectorLength = track.length / SECTORS;
    this.reset();
  }

  reset() {
    this.time = 0;
    this.lap = 0;
    this.lapStart = 0;
    this.lastS = null;
    this.distance = 0;
    this.sector = 0;
    this.sectorStart = 0;
    this.currentSectors = [];
    this.lastLap = null;
    this.bestLap = null;
    this.bestSectors = [null, null, null];
    this.lastSectors = [null, null, null];
    this.laps = [];
    this.invalid = false;
    this.started = false;
    // Best-lap reference samples, for the live delta.
    this.bestTrace = null;
    this.currentTrace = [];
    this.delta = null;
  }

  /**
   * @param {number} dt
   * @param {number} s arc-length position of the car on the circuit
   * @param {boolean} offTrack whether the car currently has wheels off
   */
  update(dt, s, offTrack) {
    this.time += dt;

    if (this.lastS === null) {
      this.lastS = s;
      this.lapStart = this.time;
      this.sectorStart = this.time;
      return;
    }

    // Signed progress, wrapped: negative means the car is going backwards.
    const step = wrapDelta(s, this.lastS, this.track.length);
    this.distance += step;
    this.lastS = s;

    if (offTrack) this.invalid = true;

    // Live delta against the best lap, sampled every 25 m of track.
    const bucket = Math.floor(wrap(s, this.track.length) / 25);
    if (this.currentTrace[bucket] === undefined) {
      this.currentTrace[bucket] = this.time - this.lapStart;
      if (this.bestTrace?.[bucket] !== undefined) {
        this.delta = this.currentTrace[bucket] - this.bestTrace[bucket];
      }
    }

    // Sector boundaries.
    const sectorIndex = Math.min(SECTORS - 1, Math.floor(wrap(s, this.track.length) / this.sectorLength));
    if (sectorIndex !== this.sector) {
      // Only accept a forward transition into the next sector.
      const expected = (this.sector + 1) % SECTORS;
      if (sectorIndex === expected && this.started) {
        const split = this.time - this.sectorStart;
        this.lastSectors[this.sector] = split;
        this.currentSectors[this.sector] = split;
        if (this.bestSectors[this.sector] === null || split < this.bestSectors[this.sector]) {
          this.bestSectors[this.sector] = split;
        }
        this.sectorStart = this.time;
      }
      this.sector = sectorIndex;
    }

    // Crossing the line: requires enough distance covered since the last one.
    const crossed = this.lastS !== null && step > 0 && wrap(s, this.track.length) < step + 0.001;
    if (crossed) this.#crossLine();
  }

  #crossLine() {
    const covered = this.distance;
    this.distance = 0;

    if (!this.started) {
      this.started = true;
      this.lap = 1;
      this.lapStart = this.time;
      this.sectorStart = this.time;
      this.currentTrace = [];
      this.invalid = false;
      return;
    }

    if (covered < this.track.length * this.requiredFraction) {
      // Did not actually complete the circuit — do not credit a lap.
      return;
    }

    const lapTime = this.time - this.lapStart;
    this.lastLap = lapTime;
    this.laps.push({ time: lapTime, invalid: this.invalid, sectors: [...this.currentSectors] });

    if (!this.invalid && (this.bestLap === null || lapTime < this.bestLap)) {
      this.bestLap = lapTime;
      this.bestTrace = this.currentTrace.slice();
    }

    this.lap += 1;
    this.lapStart = this.time;
    this.sectorStart = this.time;
    this.currentSectors = [];
    this.currentTrace = [];
    this.invalid = false;
    this.delta = null;
  }

  get currentLapTime() {
    return this.started ? this.time - this.lapStart : 0;
  }
}
