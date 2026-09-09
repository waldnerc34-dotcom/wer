/** Small numeric helpers shared by the simulation and the track builder. */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const deg = (d) => (d * Math.PI) / 180;
export const sign = (v) => (v < 0 ? -1 : 1);

/** Frame-rate independent exponential smoothing. */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Moves `current` toward `target` by at most `maxDelta`. */
export function approach(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wraps a value into [0, range). */
export const wrap = (v, range) => ((v % range) + range) % range;

/** Shortest signed difference between two positions on a loop of `range`. */
export function wrapDelta(a, b, range) {
  let d = (a - b) % range;
  if (d > range * 0.5) d -= range;
  if (d < -range * 0.5) d += range;
  return d;
}

/**
 * Piecewise-linear lookup over a table of [x, y] pairs, clamped at both ends.
 * Used for engine torque curves and grip-vs-temperature curves.
 */
export function curve(table, x) {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return last[1];
}

/** Deterministic PRNG so scenery scatter is identical on every load. */
export function makeRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
