import * as THREE from 'three';

import { clamp, lerp, wrap } from '../core/MathUtils.js';
import { Pacing } from './Pacing.js';
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

    // Set by the weather: 0 dry … 1 soaked. Read by the tyres, the AI's
    // planner and the pacing arrows — and by the racing line's lap-time
    // model, so it must exist before the line is computed.
    this.wetness = 0;

    const raw = buildCentreline(definition.segments, { step: 3 });
    this.#resample(raw, 2.5);
    this.#computeFrames();
    this.#computeCurvature();
    this.#computeRacingLine();
    this.#buildSpatialHash();
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
   * The racing line: the minimum-curvature path through the track corridor,
   * then nudged for lap time.
   *
   * The lateral offset of the line is described by control points every
   * ~12 m. Minimising the summed squared curvature of the line over those
   * offsets is a quadratic problem — the curvature is linear in the offsets
   * — with a box constraint from the track edges, solved here by an
   * active-set method: solve unconstrained, pin whatever left the road at
   * the edge it crossed, re-solve, release anything pinned that the gradient
   * wants back inside, and repeat. What falls out is the classic line — wide
   * on entry, clipping the inside at the apex, wide again on exit, straight
   * across the road between corners that face the same way — because that
   * is the path with the least curvature the corridor allows.
   *
   * Least curvature is not quite least time: a corner onto a straight wants
   * a later apex than its geometry suggests, so a second pass tries moving
   * each control point near a corner and keeps whatever the pacing model
   * says is quicker round the lap. Both the AI and the arrows follow the
   * result, and the wear baked into the road does too.
   */
  #computeRacingLine() {
    const { count: n, pos, lateral, width } = this;
    const margin = 1.6; // keep the tyres inside the white line

    const limit = new Float32Array(n);
    for (let i = 0; i < n; i++) limit[i] = Math.max(0.5, width[i] * 0.5 - margin);

    /* -- control points and the linear model ------------------------------ */
    const started = performance.now();
    const K = Math.max(2, Math.round(15 / this.spacing));
    const m = Math.ceil(n / K);
    // Sample i sits between control points j and j+1 with weight t.
    const ctrlOf = (i) => {
      const f = i / K;
      const j = Math.floor(f) % m;
      return [j, (j + 1) % m, f - Math.floor(f)];
    };
    const ctrlLimit = new Float64Array(m);
    for (let j = 0; j < m; j++) ctrlLimit[j] = limit[(j * K) % n];

    // Curvature vector at sample i: second difference of the line's XZ
    // position, d_i = u_i + Σ_j G_ij α_j, with u from the centreline alone.
    const nx = (i) => lateral[i * 3];
    const nz = (i) => lateral[i * 3 + 2];
    const H = new Float64Array(m * m);
    const g = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const ux = pos[a * 3] - 2 * pos[i * 3] + pos[b * 3];
      const uz = pos[a * 3 + 2] - 2 * pos[i * 3 + 2] + pos[b * 3 + 2];
      // Contributions of the three samples' offsets, each spread over its two
      // control points.
      const terms = [];
      for (const [k, w] of [[a, 1], [i, -2], [b, 1]]) {
        const [j0, j1, t] = ctrlOf(k);
        terms.push([j0, w * (1 - t) * nx(k), w * (1 - t) * nz(k)]);
        terms.push([j1, w * t * nx(k), w * t * nz(k)]);
      }
      for (const [j, gx, gz] of terms) {
        g[j] += 2 * (gx * ux + gz * uz);
        for (const [j2, gx2, gz2] of terms) H[j * m + j2] += 2 * (gx * gx2 + gz * gz2);
      }
    }
    // A touch of ridge keeps the system positive definite on a straight
    // where the curvature does not care where the line is.
    for (let j = 0; j < m; j++) H[j * m + j] += 1e-6;

    // The same construction for the *shortest* path — first differences
    // instead of second — gives the other classic line: hug the inside of
    // every corner, run straight between them.
    const Hl = new Float64Array(m * m);
    const gl = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const b = (i + 1) % n;
      const ux = pos[b * 3] - pos[i * 3];
      const uz = pos[b * 3 + 2] - pos[i * 3 + 2];
      const terms = [];
      for (const [k, w] of [[i, -1], [b, 1]]) {
        const [j0, j1, t] = ctrlOf(k);
        terms.push([j0, w * (1 - t) * nx(k), w * (1 - t) * nz(k)]);
        terms.push([j1, w * t * nx(k), w * t * nz(k)]);
      }
      for (const [j, gx, gz] of terms) {
        gl[j] += 2 * (gx * ux + gz * uz);
        for (const [j2, gx2, gz2] of terms) Hl[j * m + j2] += 2 * (gx * gx2 + gz * gz2);
      }
    }
    for (let j = 0; j < m; j++) Hl[j * m + j] += 1e-6;

    /* -- active-set quadratic solves ------------------------------------- */
    const alpha = solveBoxedQuadratic(H, g, ctrlLimit, m);
    const alphaShort = solveBoxedQuadratic(Hl, gl, ctrlLimit, m);
    const solveMs = performance.now() - started;

    /* -- lap-time refinement --------------------------------------------- */
    // The solve used straight lines between control points; the line the
    // car drives is a Catmull-Rom spline through them, so its curvature is
    // continuous — a polyline would put a kink, and a speed ripple, at
    // every control point.
    const applyOffsets = (ctrl, out) => {
      for (let i = 0; i < n; i++) {
        const [j1, j2, t] = ctrlOf(i);
        const p0 = ctrl[(j1 - 1 + m) % m];
        const p1 = ctrl[j1];
        const p2 = ctrl[j2];
        const p3 = ctrl[(j2 + 1) % m];
        const v =
          0.5 *
          (2 * p1 +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
        out[i] = clamp(v, -limit[i], limit[i]);
      }
      return out;
    };
    const lineOf = (offset, out) => {
      for (let i = 0; i < n; i++) {
        out[i * 3] = pos[i * 3] + lateral[i * 3] * offset[i];
        out[i * 3 + 1] = pos[i * 3 + 1] + lateral[i * 3 + 1] * offset[i];
        out[i * 3 + 2] = pos[i * 3 + 2] + lateral[i * 3 + 2] * offset[i];
      }
      return out;
    };

    const offset = new Float32Array(n);
    this.linePos = new Float32Array(n * 3);
    this.lineOffset = smoothArray(applyOffsets(alpha, offset), 2);
    lineOf(this.lineOffset, this.linePos);
    this.lineCurvature = smoothArray(curvatureOf(this.linePos, n, this.spacing), 4);
    this.lineDs = spacingOf(this.linePos, n);

    this.#refineForLapTime(alpha, alphaShort, m, K, applyOffsets, lineOf);
    this.lineStats.solveMs = solveMs;
    this.lineStats.totalMs = performance.now() - started;
  }

  /**
   * Least curvature is not least time. The fastest line through a corner
   * lies between the minimum-curvature path and the shortest one — how far
   * toward the shortest depends on the corner: a slow hairpin onto a long
   * straight wants a later, tighter apex than a fast sweeper. So each
   * corner gets a blend weight, and the pacing model's lap time chooses it:
   * a global weight first, then each corner on its own.
   */
  #refineForLapTime(alphaCurve, alphaShort, m, K, applyOffsets, lineOf) {
    const n = this.count;
    const pacing = new Pacing(this);
    const offset = new Float32Array(n);
    const line = new Float32Array(n * 3);
    const alpha = new Float64Array(m);

    // Corner zones: runs of control points where the road itself bends,
    // widened by ~60 m each way so the entry and exit come with it.
    const zone = new Int16Array(m).fill(-1);
    const bends = new Uint8Array(m);
    const reach = Math.max(1, Math.round(60 / (K * this.spacing)));
    for (let j = 0; j < m; j++) {
      if (Math.abs(this.curvature[(j * K) % n]) < 0.003) continue;
      for (let d = -reach; d <= reach; d++) bends[(j + d + m) % m] = 1;
    }
    let zones = 0;
    // Start labelling at a straight so a zone that wraps the seam stays whole.
    let origin = 0;
    while (origin < m && bends[origin]) origin++;
    if (origin === m) origin = 0;
    for (let step = 0; step < m; step++) {
      const j = (origin + step) % m;
      const prev = (j - 1 + m) % m;
      if (!bends[j]) continue;
      zone[j] = bends[prev] && step > 0 && zone[prev] >= 0 ? zone[prev] : zones++;
    }
    const weights = new Float64Array(zones);

    const evaluate = () => {
      // Blend per control point, smoothed so the weight never steps.
      const w = new Float64Array(m);
      for (let j = 0; j < m; j++) w[j] = zone[j] >= 0 ? weights[zone[j]] : 0;
      for (let pass = 0; pass < 2; pass++) {
        const prev = Float64Array.from(w);
        for (let j = 0; j < m; j++) w[j] = 0.25 * prev[(j - 1 + m) % m] + 0.5 * prev[j] + 0.25 * prev[(j + 1) % m];
      }
      for (let j = 0; j < m; j++) alpha[j] = alphaCurve[j] * (1 - w[j]) + alphaShort[j] * w[j];
      lineOf(applyOffsets(alpha, offset), line);
      const curv = smoothArray(curvatureOf(line, n, this.spacing), 4);
      pacing.compute(curv, spacingOf(line, n));
      return pacing.lapTime();
    };

    const baseline = evaluate();
    let best = baseline;

    // One weight for every corner first.
    let bestGlobal = 0;
    for (const w of [0.15, 0.3, 0.45, 0.6, 0.75]) {
      weights.fill(w);
      const t = evaluate();
      if (t < best - 1e-4) {
        best = t;
        bestGlobal = w;
      }
    }
    weights.fill(bestGlobal);

    // Then each corner on its own, twice round.
    for (let round = 0; round < 2; round++) {
      const step = round === 0 ? 0.2 : 0.1;
      for (let z = 0; z < zones; z++) {
        const original = weights[z];
        for (const dir of [1, -1]) {
          const trial = clamp(original + dir * step, 0, 0.9);
          if (trial === original) continue;
          weights[z] = trial;
          const t = evaluate();
          if (t < best - 1e-4) {
            best = t;
            break;
          }
          weights[z] = original;
        }
      }
    }

    // Apply the winner.
    evaluate();
    this.lineOffset = smoothArray(applyOffsets(alpha, offset), 2);
    lineOf(this.lineOffset, this.linePos);
    this.lineCurvature = smoothArray(curvatureOf(this.linePos, n, this.spacing), 4);
    this.lineDs = spacingOf(this.linePos, n);
    this.lineStats = { baselineLap: baseline, refinedLap: best, weights: Array.from(weights) };
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
  /**
   * A point on a line between the centre and the racing line: `share` 1 is
   * the racing line itself, 0 the centreline. The AI drives at less than 1,
   * because it tracks the line with a little error and the full line runs
   * close enough to the edge that the error would put wheels on the grass.
   */
  aiLineAt(s, share, out = new THREE.Vector3()) {
    const f = wrap(s / this.spacing, this.count);
    const i0 = Math.floor(f);
    const i1 = wrap(i0 + 1, this.count);
    const t = f - i0;
    const off = lerp(this.lineOffset[i0], this.lineOffset[i1], t) * share;
    out.set(
      lerp(this.pos[i0 * 3], this.pos[i1 * 3], t) + lerp(this.lateral[i0 * 3], this.lateral[i1 * 3], t) * off,
      lerp(this.pos[i0 * 3 + 1], this.pos[i1 * 3 + 1], t) + lerp(this.lateral[i0 * 3 + 1], this.lateral[i1 * 3 + 1], t) * off,
      lerp(this.pos[i0 * 3 + 2], this.pos[i1 * 3 + 2], t) + lerp(this.lateral[i0 * 3 + 2], this.lateral[i1 * 3 + 2], t) * off,
    );
    return out;
  }

  /**
   * Curvature of the line `aiLineAt` drives at a given share, smoothed the
   * same way as the racing line's, so a driver's speed plan matches the path
   * it actually follows. Cached per share.
   */
  lineCurvatureFor(share) {
    this.curvatureCache ??= new Map();
    const key = share.toFixed(3);
    if (this.curvatureCache.has(key)) return this.curvatureCache.get(key);
    const n = this.count;
    const line = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const off = this.lineOffset[i] * share;
      line[i * 3] = this.pos[i * 3] + this.lateral[i * 3] * off;
      line[i * 3 + 1] = this.pos[i * 3 + 1] + this.lateral[i * 3 + 1] * off;
      line[i * 3 + 2] = this.pos[i * 3 + 2] + this.lateral[i * 3 + 2] * off;
    }
    const curv = smoothArray(curvatureOf(line, n, this.spacing), 4);
    this.curvatureCache.set(key, curv);
    return curv;
  }

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

/**
 * Minimises ½ αᵀHα + gᵀα subject to |α_j| ≤ limit_j, for a small dense
 * positive-definite H, by active-set iteration with a Cholesky solve on the
 * free variables. Pinned variables sit on their bound and contribute to the
 * right-hand side; a pinned variable is released when the gradient at the
 * bound points back inside.
 */
function solveBoxedQuadratic(H, g, limit, m) {
  const alpha = new Float64Array(m);
  const pinned = new Int8Array(m); // 0 free, ±1 on that bound

  for (let iter = 0; iter < 40; iter++) {
    const free = [];
    for (let j = 0; j < m; j++) {
      if (pinned[j]) alpha[j] = pinned[j] * limit[j];
      else free.push(j);
    }
    const f = free.length;
    if (f > 0) {
      // Reduced system: H_ff x = -(g_f + H_fp α_p).
      const A = new Float64Array(f * f);
      const b = new Float64Array(f);
      for (let r = 0; r < f; r++) {
        const j = free[r];
        let rhs = -g[j];
        for (let k = 0; k < m; k++) if (pinned[k]) rhs -= H[j * m + k] * alpha[k];
        b[r] = rhs;
        for (let c = 0; c < f; c++) A[r * f + c] = H[j * m + free[c]];
      }
      const x = choleskySolve(A, b, f);
      for (let r = 0; r < f; r++) alpha[free[r]] = x[r];
    }

    // Pin the worst violators, release what wants back in.
    let changed = false;
    for (let j = 0; j < m; j++) {
      if (!pinned[j] && Math.abs(alpha[j]) > limit[j]) {
        pinned[j] = alpha[j] > 0 ? 1 : -1;
        changed = true;
      }
    }
    if (!changed) {
      for (let j = 0; j < m; j++) {
        if (!pinned[j]) continue;
        let grad = g[j];
        for (let k = 0; k < m; k++) grad += H[j * m + k] * alpha[k];
        // On the upper bound a positive gradient says "go lower": release.
        if (grad * pinned[j] > 1e-9) {
          pinned[j] = 0;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (let j = 0; j < m; j++) alpha[j] = clamp(alpha[j], -limit[j], limit[j]);
  return alpha;
}

/** Solves A x = b for symmetric positive-definite A (n×n, row-major). */
function choleskySolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(sum, 1e-12));
      else L[i * n + j] = sum / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

/**
 * Signed curvature of a closed polyline, per vertex: the turn angle divided
 * by the distance actually covered there. The distance matters: a line on
 * the inside of a corner turns through the same angle per sample as the
 * centreline but over less road, so it is tighter — and one on the outside
 * is wider. Dividing by the nominal sample spacing would make every
 * concentric line look identical, which is exactly the mistake a racing
 * line cannot afford.
 */
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
    const local = (Math.hypot(v1x, v1z) + Math.hypot(v2x, v2z)) / 2 || spacing;
    out[i] = Math.atan2(cross, dot) / local;
  }
  return out;
}

/** Distance covered per vertex along a closed polyline (mean of its two edges). */
function spacingOf(points, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = ((i - 1) + count) % count;
    const b = (i + 1) % count;
    const d1 = Math.hypot(points[i * 3] - points[a * 3], points[i * 3 + 2] - points[a * 3 + 2]);
    const d2 = Math.hypot(points[b * 3] - points[i * 3], points[b * 3 + 2] - points[i * 3 + 2]);
    out[i] = (d1 + d2) / 2;
  }
  return out;
}
