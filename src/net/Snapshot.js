/**
 * What one car looks like on the wire.
 *
 * A snapshot is 40 bytes. At twenty a second that is 800 bytes per car per
 * second, which is nothing — the reason to keep it small is not bandwidth but
 * that a small packet is one packet, and a packet that fits in one datagram
 * either arrives whole or not at all. Nothing here is ever retransmitted: a
 * snapshot that is late is worthless, because a newer one is already on its
 * way, and waiting for it is exactly what people mean when they say lag.
 *
 * Quantisation is chosen so the error is under what the eye can see at the
 * distance you see another car from:
 *
 *   position    float32          millimetre-accurate over a circuit
 *   rotation    4 × int16        1/32768 per component, ~0.006° of angle
 *   velocity    3 × int16        1 cm/s up to ±327 m/s
 *   the rest    one byte each    steer, throttle, brake, slip, surface
 */

export const SNAPSHOT_BYTES = 40;

/** Message kinds on the unreliable channel. */
export const KIND = { STATE: 1, PING: 2, PONG: 3 };

const Q16 = 32767;
const clampQ = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

/**
 * Writes one car's state.
 *
 * @param {DataView} view
 * @param {number} at byte offset
 * @param {object} s
 * @returns {number} the offset just past the record
 */
export function writeState(view, at, s) {
  view.setUint8(at, KIND.STATE);
  // Sequence, so a snapshot that overtakes a newer one can be dropped rather
  // than rewinding the car. Wraps at 24 bits, which is two hours at 20 Hz.
  view.setUint8(at + 1, (s.seq >> 16) & 0xff);
  view.setUint16(at + 2, s.seq & 0xffff);
  // Milliseconds since the sender joined. Unsigned 32 bits is 49 days.
  view.setUint32(at + 4, s.t >>> 0);

  view.setFloat32(at + 8, s.x);
  view.setFloat32(at + 12, s.y);
  view.setFloat32(at + 16, s.z);

  view.setInt16(at + 20, clampQ(s.qx) * Q16);
  view.setInt16(at + 22, clampQ(s.qy) * Q16);
  view.setInt16(at + 24, clampQ(s.qz) * Q16);
  view.setInt16(at + 26, clampQ(s.qw) * Q16);

  view.setInt16(at + 28, clamp16(s.vx * 100));
  view.setInt16(at + 30, clamp16(s.vy * 100));
  view.setInt16(at + 32, clamp16(s.vz * 100));

  view.setInt8(at + 34, clamp8(s.steer * 100));
  view.setInt16(at + 35, clamp16(s.omega * 20));
  view.setUint8(at + 37, byte(s.throttle));
  view.setUint8(at + 38, byte(s.brake));
  // Four flags and the surface index share the last byte, and the tyre's slip
  // rides in the top nibble so a remote car can throw its own spray.
  view.setUint8(
    at + 39,
    (s.surface & 0x07)
      | (s.grounded ? 0x08 : 0)
      | (Math.min(15, Math.round(s.slip / 2)) << 4),
  );
  return at + SNAPSHOT_BYTES;
}

/** Reads one car's state into `out`. */
export function readState(view, at, out = {}) {
  out.seq = (view.getUint8(at + 1) << 16) | view.getUint16(at + 2);
  out.t = view.getUint32(at + 4);

  out.x = view.getFloat32(at + 8);
  out.y = view.getFloat32(at + 12);
  out.z = view.getFloat32(at + 16);

  out.qx = view.getInt16(at + 20) / Q16;
  out.qy = view.getInt16(at + 22) / Q16;
  out.qz = view.getInt16(at + 24) / Q16;
  out.qw = view.getInt16(at + 26) / Q16;

  out.vx = view.getInt16(at + 28) / 100;
  out.vy = view.getInt16(at + 30) / 100;
  out.vz = view.getInt16(at + 32) / 100;

  out.steer = view.getInt8(at + 34) / 100;
  out.omega = view.getInt16(at + 35) / 20;
  out.throttle = view.getUint8(at + 37) / 255;
  out.brake = view.getUint8(at + 38) / 255;

  const packed = view.getUint8(at + 39);
  out.surface = packed & 0x07;
  out.grounded = (packed & 0x08) !== 0;
  out.slip = (packed >> 4) * 2;
  return out;
}

/* ------------------------------------------------------------------ clock */

/** A clock-sync probe: kind, id, and the sender's stamp. */
export function writePing(view, kind, id, t) {
  view.setUint8(0, kind);
  view.setUint32(1, id >>> 0);
  view.setFloat64(5, t);
  return 13;
}

export function readPing(view) {
  return { kind: view.getUint8(0), id: view.getUint32(1), t: view.getFloat64(5) };
}

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));
const clamp8 = (v) => (v > 127 ? 127 : v < -128 ? -128 : Math.round(v));
const byte = (v) => (v > 1 ? 255 : v < 0 ? 0 : Math.round(v * 255));
