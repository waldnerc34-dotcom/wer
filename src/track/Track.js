import * as THREE from 'three';

import { clamp, lerp, wrap } from '../core/MathUtils.js';
import { buildCentreline } from './Layout.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Surface identifiers returned by `Track.query`. */
export const SURFACE = {
  ROAD: 0,
  KERB: 1,
  APRON: 2,
  GRAVEL: 3,
  GRASS: 4,
};

/** Peak friction multiplier for each surface, relative to dry asphalt. */
export const SURFACE_GRIP = [1.0, 0.92, 0.95, 0.55, 0.42];
/** Grip in the wet, relative to the same surface dry. Painted kerbs and
 *  grass lose far more than tarmac; gravel hardly changes. */
export const SURFACE_WET = [0.74, 0.5, 0.72, 0.9, 0.55];
/** Extra rolling resistance (N per kN of load) once off the racing surface. */
export const SURFACE_DRAG = [0, 0.004, 0.002, 0.09, 0.045];
/** How rough each surface feels through the chassis. */
export const SURFACE_RUMBLE = [0.02, 1.0, 0.06, 0.55, 0.3];

/**
 * The runtime circuit.
 *
 * Holds the resampled centreline, a precomputed racing line, and a uniform
 * spatial hash so the physics can ask "what is under this point?" in constant
 * time. Geometry generation lives in TrackBuilder; this class is the model the
 * simulation and the AI drive against.
 */
export class Track {
  constructor(definition) {
    this.def = definition;
    this.name = definition.name;

    const raw = buildCentreline(definition.segments, { step: 3 });
    this.#resample(raw, 2.5);
    this.#computeFrames();
    this.#computeCurvature();
    this.#computeRacingLine();
    this.#buildSpatialHash();

    // Set by the weather: 0 dry … 1 soaked. Read by the tyres, the AI's
    // planner and the pacing arrows.
    this.wetness = 0;
  }

  /** Grip multiplier for a surface under the current weather. */
  grip(surface) {
    const dry = SURFACE_GRIP[surface] ?? 1;
    const wet = SURFACE_WET[surface] ?? 0.7;
    return dry * lerp(1, wet, this.wetness);
  }

  /**
   * Kerb profile, metres above the road plane: a raised lip with the ridges
   * that make a kerb rumble through the suspension. Period 0.6 m, so at
   * 150 km/h it buzzes at ~70 Hz, which is about right.
   */
  kerbHeight(s) {
    return 0.035 + 0.022 * Math.sin((s / 0.6) * Math.PI * 2);
  }

  /* ------------------------------------------------------------- sampling */

  /** Resamples the authored centreline to a uniform arc-length spacing. */
  #resample(raw, spacing) {
    const n = raw.length;
    const cum = [0];
    for (let i = 1; i <= n; i++) {
      const a = raw[i - 1];
      const b = raw[i % n];
      cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
    }
    const total = cum[n];
    const count = Math.max(64, Math.round(total / spacing));
    this.spacing = total / count;
    this.length = total;
    this.count = count;

    this.pos = new Float32Array(count * 3);
    this.width = new Float32Array(count);
    this.bank = new Float32Array(count);
    this.cornerName = new Array(count).fill(null);

    let seg = 0;
    for (let i = 0; i < count; i++) {
      const target = (i * total) / count;
      while (seg < n && cum[seg + 1] < target) seg++;
      const t = (target - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
      const a = raw[seg];
      const b = raw[(seg + 1) % n];
      this.pos[i * 3] = lerp(a.x, b.x, t);
      this.pos[i * 3 + 1] = lerp(a.y, b.y, t);
      this.pos[i * 3 + 2] = lerp(a.z, b.z, t);
      this.width[i] = lerp(a.width, b.width, t);
      this.bank[i] = lerp(a.bank, b.bank, t);
      this.cornerName[i] = t < 0.5 ? a.corner : b.corner;
    }

    // A light smoothing pass removes the resampling jitter that would
    // otherwise show up as visible facets on long straights.
    this.#smoothPositions(2);
  }

  #smoothPositions(passes) {
    const { count, pos } = this;
    for (let p = 0; p < passes; p++) {
      const out = pos.slice();
      for (let i = 0; i < count; i++) {
        const a = ((i - 1) + count) % count;
        const b = (i + 1) % count;
        for (let k = 0; k < 3; k++) {
          out[i * 3 + k] = pos[a * 3 + k] * 0.25 + pos[i * 3 + k] * 0.5 + pos[b * 3 + k] * 0.25;
        }
      }
      pos.set(out);
    }
  }

  /** Tangent / lateral / normal frame at every sample, including banking. */
  #computeFrames() {
    const { count, pos, bank } = this;
    this.tangent = new Float32Array(count * 3);
    this.lateral = new Float32Array(count * 3);
    this.normal = new Float32Array(count * 3);

    const t = new THREE.Vector3();
    const l = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const prev = ((i - 1) + count) % count;
      const next = (i + 1) % count;
      a.fromArray(pos, prev * 3);
      b.fromArray(pos, next * 3);
      t.subVectors(b, a).normalize();

      // Flat lateral, then rolled about the tangent by the bank angle.
      l.crossVectors(UP, t).normalize();
      const tb = Math.tan(bank[i]);
      l.addScaledVector(UP, -tb).normalize();
      nrm.crossVectors(t, l).normalize();
      if (nrm.y < 0) nrm.negate();

      t.toArray(this.tangent, i * 3);
      l.toArray(this.lateral, i * 3);
      nrm.toArray(this.normal, i * 3);
    }
  }

  /** Signed curvature (1/m); positive bends toward +lateral. */
  #computeCurvature() {
    const { count, pos, spacing } = this;
    this.curvature = new Float32Array(count);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const lat = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      a.fromArray(pos, (((i - 1) + count) % count) * 3);
      b.fromArray(pos, i * 3);
      c.fromArray(pos, ((i + 1) % count) * 3);
      v1.subVectors(b, a);
      v2.subVectors(c, b);
      v1.y = 0;
      v2.y = 0;
      const cross = v1.x * v2.z - v1.z * v2.x;
      const angle = Math.atan2(cross, v1.dot(v2));
      lat.fromArray(this.lateral, i * 3);
      // Sign so that positive curvature means "turns toward +lateral".
      this.curvature[i] = -angle / spacing;
    }
    this.curvature = smoothArray(this.curvature, 3);
  }

  /**
   * Constrained Laplacian relaxation inside the track corridor.
   *
   * Repeatedly pulling each point toward the midpoint of its neighbours
   * straightens the path; clamping the result to the usable width keeps it on
   * the road. What falls out is a close approximation of the minimum-curvature
   * line — late apexes on slow corners, early on fast ones — which is what both
   * the AI and the rubbered-in visual line follow.
   */
  #computeRacingLine(iterations = 600) {
    const { count, pos, lateral, width } = this;
    const offset = new Float32Array(count);
    const margin = 1.6; // keep the tyres inside the white line

    const p = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const next = new THREE.Vector3();
    const lat = new THREE.Vector3();
    const mid = new THREE.Vector3();

    const at = (i, out) => {
      out.fromArray(pos, i * 3);
      lat.fromArray(lateral, i * 3);
      return out.addScaledVector(lat, offset[i]);
    };

    for (let iter = 0; iter < iterations; iter++) {
      const relax = lerp(0.35, 0.08, iter / iterations);
      for (let i = 0; i < count; i++) {
        const ia = ((i - 1) + count) % count;
        const ib = (i + 1) % count;
        at(ia, prev);
        at(ib, next);
        at(i, p);
        mid.addVectors(prev, next).multiplyScalar(0.5);
        lat.fromArray(lateral, i * 3);
        // Component of the straightening move that lies across the track.
        const delta = mid.sub(p).dot(lat);
        const limit = Math.max(0.5, width[i] * 0.5 - margin);
        offset[i] = clamp(offset[i] + delta * relax, -limit, limit);
      }
    }

    this.lineOffset = smoothArray(offset, 2);

    // Cache world-space racing-line points and their curvature-derived speed.
    this.linePos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      at(i, p);
      p.toArray(this.linePos, i * 3);
    }
    this.lineCurvature = smoothArray(curvatureOf(this.linePos, count, this.spacing), 4);
  }

  /* ------------------------------------------------------- spatial lookup */

  /**
   * Buckets sample indices into a uniform XZ grid so `query` never has to scan
   * the whole centreline.
   */
  #buildSpatialHash() {
    const { count, pos } = this;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      minX = Math.min(minX, pos[i * 3]);
      maxX = Math.max(maxX, pos[i * 3]);
      minZ = Math.min(minZ, pos[i * 3 + 2]);
      maxZ = Math.max(maxZ, pos[i * 3 + 2]);
    }
    const pad = 140;
    this.bounds = { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
    this.cell = 24;
    this.gridW = Math.ceil((this.bounds.maxX - this.bounds.minX) / this.cell);
    this.gridH = Math.ceil((this.bounds.maxZ - this.bounds.minZ) / this.cell);
    this.grid = Array.from({ length: this.gridW * this.gridH }, () => []);

    // Insert each sample into every cell within reach of the track edge.
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      const reach = this.width[i] * 0.5 + 26;
      const gx0 = this.#gx(x - reach);
      const gx1 = this.#gx(x + reach);
      const gz0 = this.#gz(z - reach);
      const gz1 = this.#gz(z + reach);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          this.grid[gz * this.gridW + gx].push(i);
        }
      }
    }
  }

  #gx(x) {
    return clamp(Math.floor((x - this.bounds.minX) / this.cell), 0, this.gridW - 1);
  }

  #gz(z) {
    return clamp(Math.floor((z - this.bounds.minZ) / this.cell), 0, this.gridH - 1);
  }

  /* ---------------------------------------------------------------- query */

  /**
   * Locates a world XZ position relative to the circuit.
   *
   * Returns the nearest centreline index, the arc-length `s` along the lap,
   * the signed lateral offset in metres, the surface height and normal at that
   * point, and which material the tyre is on.
   */
  query(x, z, out = {}) {
    const bucket = this.grid[this.#gz(z) * this.gridW + this.#gx(x)];
    let best = -1;
    let bestD = Infinity;

    const list = bucket.length ? bucket : null;
    if (list) {
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const dx = x - this.pos[i * 3];
        const dz = z - this.pos[i * 3 + 2];
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    } else {
      // Far outside the circuit: fall back to a coarse scan.
      for (let i = 0; i < this.count; i += 4) {
        const dx = x - this.pos[i * 3];
        const dz = z - this.pos[i * 3 + 2];
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }

    // Refine between the two neighbouring samples by projecting onto the
    // tangent, so `s` and `lateral` are continuous rather than stepped.
    const i0 = best;
    const px = this.pos[i0 * 3];
    const py = this.pos[i0 * 3 + 1];
    const pz = this.pos[i0 * 3 + 2];
    const tx = this.tangent[i0 * 3];
    const tz = this.tangent[i0 * 3 + 2];
    const along = (x - px) * tx + (z - pz) * tz;
    const frac = clamp(along / this.spacing, -1, 1);

    const iN = frac >= 0 ? (i0 + 1) % this.count : ((i0 - 1) + this.count) % this.count;
    const blend = Math.abs(frac);

    const lx = lerp(this.lateral[i0 * 3], this.lateral[iN * 3], blend);
    const lz = lerp(this.lateral[i0 * 3 + 2], this.lateral[iN * 3 + 2], blend);
    const ll = Math.hypot(lx, lz) || 1;
    const lateral = ((x - px) * lx + (z - pz) * lz) / ll;

    const width = lerp(this.width[i0], this.width[iN], blend);
    const bank = lerp(this.bank[i0], this.bank[iN], blend);
    const cy = lerp(py, this.pos[iN * 3 + 1], blend);

    out.index = i0;
    out.s = wrap(i0 * this.spacing + along, this.length);
    out.lateral = lateral;
    out.width = width;
    out.bank = bank;
    out.curvature = lerp(this.curvature[i0], this.curvature[iN], blend);
    out.centreHeight = cy;
    out.height = cy - lateral * Math.tan(bank);
    const edge = width * 0.5;
    const absLat = Math.abs(lateral);
    if (absLat > edge && absLat <= edge + this.kerbWidth(out.curvature ?? 0)) {
      out.height += this.kerbHeight(out.s ?? 0);
    }
    out.nx = lerp(this.normal[i0 * 3], this.normal[iN * 3], blend);
    out.ny = lerp(this.normal[i0 * 3 + 1], this.normal[iN * 3 + 1], blend);
    out.nz = lerp(this.normal[i0 * 3 + 2], this.normal[iN * 3 + 2], blend);
    out.tx = lerp(this.tangent[i0 * 3], this.tangent[iN * 3], blend);
    out.tz = lerp(this.tangent[i0 * 3 + 2], this.tangent[iN * 3 + 2], blend);
    out.surface = this.surfaceAt(Math.abs(lateral), width, out.curvature);
    out.offTrack = Math.abs(lateral) > width * 0.5 + 0.4;
    return out;
  }

  /** Which material sits at a given distance from the centreline. */
  surfaceAt(absLateral, width, curvature) {
    const edge = width * 0.5;
    if (absLateral <= edge) return SURFACE.ROAD;
    if (absLateral <= edge + this.kerbWidth(curvature)) return SURFACE.KERB;
    if (absLateral <= edge + 9) return Math.abs(curvature) > 0.006 ? SURFACE.GRAVEL : SURFACE.APRON;
    return SURFACE.GRASS;
  }

  /** Kerbs only exist through corners, and widen with the corner's severity. */
  kerbWidth(curvature) {
    const k = Math.abs(curvature);
    // Below roughly a 250 m radius a corner does not get a kerb.
    if (k < 0.004) return 0;
    return clamp(0.55 + (k - 0.004) * 190, 0.55, 1.35);
  }

  /* -------------------------------------------------------------- helpers */

  /** World position of the centreline at arc length `s`. */
  sampleAt(s, out = new THREE.Vector3()) {
    const f = wrap(s / this.spacing, this.count);
    const i0 = Math.floor(f);
    const i1 = (i0 + 1) % this.count;
    const t = f - i0;
    return out.set(
      lerp(this.pos[i0 * 3], this.pos[i1 * 3], t),
      lerp(this.pos[i0 * 3 + 1], this.pos[i1 * 3 + 1], t),
      lerp(this.pos[i0 * 3 + 2], this.pos[i1 * 3 + 2], t),
    );
  }

  /** World position on the racing line at arc length `s`. */
  racingLineAt(s, out = new THREE.Vector3()) {
    const f = wrap(s / this.spacing, this.count);
    const i0 = Math.floor(f);
    const i1 = (i0 + 1) % this.count;
    const t = f - i0;
    return out.set(
      lerp(this.linePos[i0 * 3], this.linePos[i1 * 3], t),
      lerp(this.linePos[i0 * 3 + 1], this.linePos[i1 * 3 + 1], t),
      lerp(this.linePos[i0 * 3 + 2], this.linePos[i1 * 3 + 2], t),
    );
  }

  /** Index of the centreline sample nearest arc length `s`. */
  indexAt(s) {
    return Math.floor(wrap(s / this.spacing, this.count));
  }

  /** Name of the corner a car at arc length `s` is in, if any. */
  cornerAt(s) {
    return this.cornerName[this.indexAt(s)];
  }

  /**
   * Grid-start pose for the nth car: staggered either side of the centreline,
   * behind the start/finish line.
   */
  gridSlot(n) {
    const row = Math.floor(n / 2);
    const side = n % 2 === 0 ? -1 : 1;
    const s = wrap(this.length - 22 - row * 9, this.length);
    const i = this.indexAt(s);
    const p = this.sampleAt(s, new THREE.Vector3());
    // The lateral basis is already rolled by the bank angle, so moving along
    // it puts the point on the road surface without a separate height fixup.
    const lat = new THREE.Vector3().fromArray(this.lateral, i * 3);
    p.addScaledVector(lat, side * this.width[i] * 0.22);
    const t = new THREE.Vector3().fromArray(this.tangent, i * 3);
    return { position: p, heading: Math.atan2(t.x, t.z) };
  }
}

/* ----------------------------------------------------------------- utils */

function smoothArray(src, passes) {
  let a = Float32Array.from(src);
  const n = a.length;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] =
        a[((i - 1) + n) % n] * 0.25 + a[i] * 0.5 + a[(i + 1) % n] * 0.25;
    }
    a = out;
  }
  return a;
}

function curvatureOf(points, count, spacing) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = ((i - 1) + count) % count;
    const b = (i + 1) % count;
    const v1x = points[i * 3] - points[a * 3];
    const v1z = points[i * 3 + 2] - points[a * 3 + 2];
    const v2x = points[b * 3] - points[i * 3];
    const v2z = points[b * 3 + 2] - points[i * 3 + 2];
    const cross = v1x * v2z - v1z * v2x;
    const dot = v1x * v2x + v1z * v2z;
    out[i] = Math.atan2(cross, dot) / spacing;
  }
  return out;
}
