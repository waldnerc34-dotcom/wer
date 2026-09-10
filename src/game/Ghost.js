import * as THREE from 'three';

const _spare = new THREE.Quaternion();

/**
 * Ghosts: a lap somebody else already drove, running beside you.
 *
 * A ghost is not a car. Nothing decides what it does — it is a recording of
 * where a car was at each moment of a lap, replayed against the clock of the
 * lap you are on now. That is what makes it useful: at eight seconds into your
 * lap you see exactly where the other lap was at eight seconds, so the gap on
 * screen *is* the gap on the timesheet, corner by corner, without a delta
 * readout to interpret.
 *
 * The trace is deliberately small. A ghost needs a position, a heading and
 * enough wheel movement not to look like it is skating; it does not need
 * forces, temperatures or pedal positions. Ten samples a second is plenty
 * because the replay interpolates between them, and a lap of the longest
 * circuit here comes to about twenty kilobytes.
 */

const MAGIC = 0x47484f31; // "GHO1"
const HEADER = 24;
const SAMPLE = 17;

/** Samples a second. The replay interpolates, so this is not a frame rate. */
export const GHOST_HZ = 10;

const Q16 = 32767;
const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));
const clamp8 = (v) => (v > 127 ? 127 : v < -128 ? -128 : Math.round(v));

/**
 * Records one lap.
 *
 * Positions are stored relative to an origin and in tenths of a metre, which
 * is five centimetres of error at worst on a car two metres wide — invisible,
 * and a third of the size of storing them outright.
 */
export class GhostRecorder {
  /** @param {{x:number,y:number,z:number}} origin usually the grid slot */
  constructor(origin, { hz = GHOST_HZ } = {}) {
    this.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.hz = hz;
    this.period = 1 / hz;
    this.samples = [];
    this.time = 0;
    this.due = 0;
  }

  /**
   * @param {number} dt seconds
   * @param {object} vehicle anything with position, quaternion and wheels
   */
  update(dt, vehicle) {
    this.time += dt;
    if (this.time < this.due) return;
    this.due += this.period;
    // A frame so long it skipped a whole slot: take one sample and resync
    // rather than emitting a burst that all shares a timestamp.
    if (this.time > this.due) this.due = this.time + this.period;

    const q = vehicle.quaternion;
    this.samples.push({
      x: vehicle.position.x - this.origin.x,
      y: vehicle.position.y - this.origin.y,
      z: vehicle.position.z - this.origin.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      omega: vehicle.wheels[2]?.omega ?? 0,
      steer: vehicle.wheels[0]?.steer ?? 0,
    });
  }

  /**
   * Seals the recording.
   *
   * @param {number} lapTime the time the lap was actually set in
   * @returns {Uint8Array|null} null if the lap was too short to be a lap
   */
  finish(lapTime) {
    if (this.samples.length < 4 || !Number.isFinite(lapTime)) return null;
    return encodeGhost({ origin: this.origin, hz: this.hz, lapTime, samples: this.samples });
  }
}

export function encodeGhost({ origin, hz, lapTime, samples, label = '' }) {
  const bytes = new Uint8Array(HEADER + samples.length * SAMPLE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC);
  view.setUint8(4, hz);
  view.setUint16(5, samples.length);
  view.setFloat32(7, lapTime);
  view.setFloat32(11, origin.x);
  view.setFloat32(15, origin.y);
  view.setFloat32(19, origin.z);
  view.setUint8(23, Math.min(255, label.length));

  let at = HEADER;
  for (const s of samples) {
    // Tenths of a metre along the ground, centimetres in height: a car moves
    // far in x and z over a lap and hardly at all in y.
    view.setInt16(at, clamp16(s.x * 10));
    view.setInt16(at + 2, clamp16(s.y * 100));
    view.setInt16(at + 4, clamp16(s.z * 10));
    view.setInt16(at + 6, clamp16(s.qx * Q16));
    view.setInt16(at + 8, clamp16(s.qy * Q16));
    view.setInt16(at + 10, clamp16(s.qz * Q16));
    view.setInt16(at + 12, clamp16(s.qw * Q16));
    view.setInt16(at + 14, clamp16(s.omega * 20));
    view.setInt8(at + 16, clamp8(s.steer * 100));
    at += SAMPLE;
  }
  return bytes;
}

export function decodeGhost(bytes) {
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  if (view.byteLength < HEADER || view.getUint32(0) !== MAGIC) return null;

  const hz = view.getUint8(4);
  const count = view.getUint16(5);
  if (view.byteLength < HEADER + count * SAMPLE) return null;

  const trace = {
    hz,
    lapTime: view.getFloat32(7),
    origin: { x: view.getFloat32(11), y: view.getFloat32(15), z: view.getFloat32(19) },
    count,
    // Kept as flat arrays rather than objects: this is read sixty times a
    // second and allocating a sample each time is the one thing a replay
    // must not do.
    x: new Float32Array(count),
    y: new Float32Array(count),
    z: new Float32Array(count),
    q: new Float32Array(count * 4),
    omega: new Float32Array(count),
    steer: new Float32Array(count),
  };

  let at = HEADER;
  for (let i = 0; i < count; i++) {
    trace.x[i] = trace.origin.x + view.getInt16(at) / 10;
    trace.y[i] = trace.origin.y + view.getInt16(at + 2) / 100;
    trace.z[i] = trace.origin.z + view.getInt16(at + 4) / 10;
    trace.q[i * 4] = view.getInt16(at + 6) / Q16;
    trace.q[i * 4 + 1] = view.getInt16(at + 8) / Q16;
    trace.q[i * 4 + 2] = view.getInt16(at + 10) / Q16;
    trace.q[i * 4 + 3] = view.getInt16(at + 12) / Q16;
    trace.omega[i] = view.getInt16(at + 14) / 20;
    trace.steer[i] = view.getInt8(at + 16) / 100;
    at += SAMPLE;
  }
  return trace;
}

/** Base64, so a trace can live in localStorage or be embedded in a page. */
export function ghostToText(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function ghostFromText(text) {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return decodeGhost(bytes);
  } catch {
    return null;
  }
}

/**
 * Replays a trace against the clock of the lap being driven now.
 *
 * Asking for a moment past the end of the recording holds the ghost on its
 * final sample rather than looping it: a lap you are still driving after the
 * ghost has finished is a lap you have lost, and the ghost sitting on the line
 * says so more plainly than a number would.
 */
export class GhostPlayer {
  /** @param {object} trace from decodeGhost */
  constructor(trace) {
    this.trace = trace;
    this.lapTime = trace.lapTime;
    this.finished = false;
  }

  /**
   * @param {number} seconds into the lap
   * @param {{position: object, quaternion: object}} out written in place
   * @returns {boolean} whether the ghost has anything to show yet
   */
  at(seconds, out) {
    const t = this.trace;
    if (!t.count) return false;

    const exact = Math.max(0, seconds) * t.hz;
    const last = t.count - 1;
    this.finished = exact >= last;

    const i = Math.min(last, Math.floor(exact));
    const j = Math.min(last, i + 1);
    const f = i === j ? 0 : exact - i;

    out.position.set(
      t.x[i] + (t.x[j] - t.x[i]) * f,
      t.y[i] + (t.y[j] - t.y[i]) * f,
      t.z[i] + (t.z[j] - t.z[i]) * f,
    );
    out.quaternion.set(t.q[i * 4], t.q[i * 4 + 1], t.q[i * 4 + 2], t.q[i * 4 + 3]).normalize();
    if (f > 0) {
      _spare.set(t.q[j * 4], t.q[j * 4 + 1], t.q[j * 4 + 2], t.q[j * 4 + 3]).normalize();
      out.quaternion.slerp(_spare, f);
    }
    out.omega = t.omega[i];
    out.steer = t.steer[i];
    return true;
  }
}
