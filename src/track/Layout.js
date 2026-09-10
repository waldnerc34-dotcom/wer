import { clamp, deg, lerp } from '../core/MathUtils.js';

/**
 * A circuit is authored the way a real one is described: a run of straights and
 * constant-radius arcs, each with its own width, banking and elevation change.
 *
 * Hand-authored segment lists almost never close the loop exactly, so
 * `solveClosure` nudges the segment lengths and arc angles by the smallest
 * amount that brings the end of the lap back onto its start — position and
 * heading both. The result keeps genuine straights and genuine constant-radius
 * corners, which is what makes a circuit learnable to drive.
 */

/* ---------------------------------------------------------------- authoring */

export const straight = (length, opts = {}) => ({ type: 'straight', length, ...opts });
export const arc = (radius, angle, opts = {}) => ({ type: 'arc', radius, angle, ...opts });

/* ------------------------------------------------------------- integration */

/**
 * Walks the segment list, emitting centreline samples roughly `step` metres
 * apart. Heading is measured in the XZ plane; +Y is up.
 */
function integrate(segments, step = 4) {
  const pts = [];
  let x = 0;
  let z = 0;
  let y = 0;
  let heading = 0; // radians, 0 = +Z

  const push = (width, bank, corner) => {
    pts.push({ x, y, z, width, bank, corner });
  };

  push(segments[0].width ?? 12, 0, null);

  for (const seg of segments) {
    const width = seg.width ?? 12;
    const bank = deg(seg.bank ?? 0);
    const rise = seg.rise ?? 0;

    if (seg.type === 'straight') {
      const n = Math.max(1, Math.round(seg.length / step));
      const dx = Math.sin(heading);
      const dz = Math.cos(heading);
      for (let i = 1; i <= n; i++) {
        const d = seg.length / n;
        x += dx * d;
        z += dz * d;
        y += rise / n;
        push(width, bank * (i / n), seg.name ?? null);
      }
    } else {
      // Positive angle bends toward +X — the driver's left.
      const total = deg(seg.angle);
      const arcLen = Math.abs(total) * seg.radius;
      const n = Math.max(2, Math.round(arcLen / step));
      for (let i = 1; i <= n; i++) {
        const dTheta = total / n;
        // Advance along the chord, then rotate the heading.
        const d = arcLen / n;
        x += Math.sin(heading + dTheta * 0.5) * d;
        z += Math.cos(heading + dTheta * 0.5) * d;
        heading += dTheta;
        y += rise / n;
        // Ease banking in and out so the surface never kinks.
        const t = i / n;
        const ease = Math.sin(Math.min(t, 1 - t) * Math.PI) ** 0.5;
        push(width, bank * clamp(ease * 1.4, 0, 1), seg.name ?? null);
      }
    }
  }

  return { pts, end: { x, y, z, heading } };
}

/* ---------------------------------------------------------------- closure */

/**
 * Damped least-squares nudge of the segment parameters until the lap closes.
 *
 * Unknowns are one scale factor per segment (arc angle for corners, length for
 * straights). Residuals are the end-of-lap position error and the heading error
 * against a full turn. A regularisation term keeps every scale near 1 so the
 * authored shape survives.
 */
function solveClosure(segments, turns = 1) {
  const params = segments.map(() => 1);
  const target = turns * Math.PI * 2;

  const apply = (p) =>
    segments.map((s, i) =>
      s.type === 'arc' ? { ...s, angle: s.angle * p[i] } : { ...s, length: s.length * p[i] },
    );

  const residual = (p) => {
    const { end } = integrate(apply(p), 12); // coarse step: closure only
    return [end.x, end.z, (end.heading - target) * 60];
  };

  for (let iter = 0; iter < 24; iter++) {
    const r = residual(params);
    const err = Math.hypot(r[0], r[1], r[2] / 60);
    if (err < 1e-3) break;

    // Finite-difference Jacobian (3 × n).
    const n = params.length;
    const J = [];
    const h = 1e-4;
    for (let i = 0; i < n; i++) {
      const p2 = params.slice();
      p2[i] += h;
      const r2 = residual(p2);
      J.push([(r2[0] - r[0]) / h, (r2[1] - r[1]) / h, (r2[2] - r[2]) / h]);
    }

    // Solve (JᵀJ + λI) δ = -Jᵀr in the 3-residual space via the normal
    // equations on JJᵀ, which is only 3×3.
    const A = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += J[i][a] * J[i][b];
        A[a][b] = sum + (a === b ? 1e-6 : 0);
      }
    }
    const lambda = 1e-3;
    for (let a = 0; a < 3; a++) A[a][a] += lambda;

    const w = solve3(A, [-r[0], -r[1], -r[2]]);
    if (!w) break;

    for (let i = 0; i < n; i++) {
      const delta = J[i][0] * w[0] + J[i][1] * w[1] + J[i][2] * w[2];
      params[i] = clamp(params[i] + delta, 0.55, 1.8);
    }
  }

  return apply(params);
}

/** Gaussian elimination for a 3×3 system; returns null if singular. */
function solve3(A, b) {
  const m = [
    [...A[0], b[0]],
    [...A[1], b[1]],
    [...A[2], b[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/**
 * Builds the closed centreline for a circuit definition.
 * Returns evenly-ish spaced samples with width/bank/elevation attached.
 */
export function buildCentreline(segments, { turns = 1, step = 3 } = {}) {
  const solved = solveClosure(segments, turns);
  const { pts } = integrate(solved, step);

  // The solver leaves a residual of a few centimetres at most; blend it away
  // over the final third of the lap so the seam is invisible.
  const first = pts[0];
  const last = pts[pts.length - 1];
  const ex = first.x - last.x;
  const ez = first.z - last.z;
  const ey = first.y - last.y;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = t < 0.66 ? 0 : smoothFade((t - 0.66) / 0.34);
    pts[i].x += ex * w;
    pts[i].z += ez * w;
    pts[i].y += ey * w;
  }
  pts.pop(); // last sample coincides with the first on a closed loop
  return pts;
}

const smoothFade = (t) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

/* -------------------------------------------------------------- circuits */

/**
 * APEX INTERNATIONAL — a 4.6 km road course.
 *
 * Long pit straight into a heavy stop, a technical middle sector over
 * changing elevation, a banked multi-apex sweeper, and a fast run home.
 */
export const APEX_INTERNATIONAL = {
  id: 'apex',
  name: 'Apex International',
  country: 'Circuit de la Vallée',
  hdri: 'venice_sunset_1k.hdr',
  // The sky over this one is a Venetian lagoon at sunset; the water it was
  // photographed over should be there too.
  sea: { level: -52, color: 0x123043 },
  sunAzimuth: 118,
  sunElevation: 14,
  segments: [
    straight(620, { width: 15, name: 'Start / Finish' }),
    arc(72, 88, { width: 14, bank: 4, name: 'T1 — Vallée' }),
    straight(165, { width: 13, rise: -4 }),
    arc(115, -62, { width: 13, bank: -3, name: 'T2' }),
    arc(95, 70, { width: 13, bank: 3, name: 'T3 — Esses' }),
    straight(130, { width: 13, rise: -6 }),
    arc(260, -46, { width: 14, bank: -6, name: 'T4 — Long Right' }),
    straight(330, { width: 14, rise: -5 }),
    arc(34, 168, { width: 15, bank: 5, name: 'T5 — Hairpin' }),
    straight(700, { width: 15, rise: 9, name: 'Back Straight' }),
    arc(155, -34, { width: 14, bank: -4, name: 'T6' }),
    arc(180, 40, { width: 13, bank: 5, name: 'T7 — Crest' }),
    straight(205, { width: 13, rise: 4 }),
    arc(56, -104, { width: 13, bank: -4, name: 'T8 — Descent' }),
    straight(235, { width: 14, rise: -6 }),
    arc(200, 112, { width: 15, bank: 9, name: 'T9 — Banked Sweeper' }),
    straight(165, { width: 14 }),
    arc(80, 74, { width: 14, bank: 4, name: 'T10' }),
    straight(290, { width: 15, rise: 2 }),
    arc(105, 58, { width: 15, bank: 4, name: 'T11 — Onto the straight' }),
  ],
};

/**
 * COASTAL SPRINT — shorter, faster, flowing. Fewer stops, more commitment.
 */
export const COASTAL_SPRINT = {
  id: 'coastal',
  name: 'Costa Brava Sprint',
  country: 'Seaside Circuit',
  hdri: 'quarry_01_1k.hdr',
  // It is called Costa Brava. Below the lowest ground the terrain reaches, so
  // the water only shows where the land runs out — which is the point.
  sea: { level: -34, color: 0x0c3245 },
  sunAzimuth: 210,
  sunElevation: 28,
  segments: [
    straight(360, { width: 14, name: 'Start / Finish' }),
    arc(95, 96, { width: 14, bank: 6, name: 'T1 — Marina' }),
    straight(180, { width: 13, rise: 5 }),
    arc(150, -78, { width: 13, bank: -5, name: 'T2 — Cliff' }),
    straight(240, { width: 13, rise: -7 }),
    arc(42, 128, { width: 14, bank: 4, name: 'T3 — Harbour' }),
    straight(300, { width: 14, rise: 3 }),
    arc(190, 72, { width: 14, bank: 7, name: 'T4 — Sweep' }),
    arc(110, -52, { width: 13, bank: -4, name: 'T5' }),
    straight(200, { width: 13, rise: -2 }),
    arc(70, 94, { width: 14, bank: 5, name: 'T6 — Onto the front' }),
    straight(150, { width: 14 }),
  ],
};

/**
 * COL DE L'AIGLE — a mountain road turned circuit: 3.7 km, 60 m of climb and
 * descent, hairpins stacked up the hillside, narrow and unforgiving.
 */
export const COL_DE_L_AIGLE = {
  id: 'aigle',
  name: "Col de l'Aigle",
  country: 'Mountain Circuit',
  hdri: 'spruit_sunrise_1k.hdr',
  sunAzimuth: 74,
  sunElevation: 19,
  // Anticlockwise round the mountain: a switchback climb up the left flank,
  // the balcony and the col across the top, a fast descent down the right,
  // and the run back along the valley floor. The turn angles sum to +360°,
  // so the closure solve has only a few metres to absorb and the road never
  // meets itself.
  segments: [
    straight(260, { width: 11, rise: 6, name: 'Start / Finish' }),
    arc(38, 150, { width: 11, bank: -3, rise: 4, name: 'T1 — Lacet 1' }),
    straight(150, { width: 11, rise: 9 }),
    arc(32, -150, { width: 11, bank: 4, rise: 4, name: 'T2 — Lacet 2' }),
    straight(200, { width: 11, rise: 11 }),
    arc(120, 40, { width: 11, bank: 3, rise: 5, name: 'T3 — Balcon' }),
    straight(160, { width: 11, rise: 7 }),
    arc(60, 100, { width: 12, bank: 4, rise: 3, name: 'T4 — Col' }),
    straight(220, { width: 12, rise: -4 }),
    arc(150, 60, { width: 12, bank: 5, rise: -8, name: 'T5 — Descente' }),
    straight(240, { width: 12, rise: -16 }),
    arc(70, -70, { width: 11, bank: -2, rise: -6, name: 'T6 — Ravin' }),
    straight(90, { width: 11, rise: -7 }),
    arc(42, 120, { width: 11, bank: 3, rise: -5, name: 'T7 — Épingle' }),
    straight(200, { width: 11, rise: -10 }),
    arc(110, -50, { width: 11, bank: -3, rise: -4, name: 'T8 — Forêt' }),
    straight(180, { width: 11, rise: -6 }),
    arc(80, 90, { width: 11, bank: 4, rise: -4, name: 'T9 — Retour' }),
    straight(150, { width: 11, rise: -3 }),
    arc(60, 70, { width: 11, bank: 3, rise: 0, name: 'T10 — Village' }),
    straight(330, { width: 11, rise: 0 }),
  ],
};

/**
 * SILVERTON GRAND PRIX — 3.9 km of wide, fast, modern circuit: long straights
 * into big stops, a flat-out sweeper sequence, and a slow final complex.
 */
export const SILVERTON_GP = {
  id: 'silverton',
  name: 'Silverton Grand Prix',
  country: 'Grand Prix Circuit',
  hdri: 'blouberg_sunrise_2_1k.hdr',
  sunAzimuth: 150,
  sunElevation: 32,
  segments: [
    straight(820, { width: 16, name: 'Start / Finish' }),
    arc(64, 96, { width: 16, bank: 4, name: 'T1 — Village' }),
    straight(210, { width: 15 }),
    arc(230, -48, { width: 15, bank: -5, name: 'T2 — Farm' }),
    arc(320, 36, { width: 15, bank: 6, name: 'T3 — Becketts' }),
    arc(210, -52, { width: 15, bank: -5, name: 'T4' }),
    arc(260, 44, { width: 15, bank: 5, name: 'T5 — Chapel' }),
    straight(640, { width: 16, rise: 3, name: 'Hangar Straight' }),
    arc(150, 88, { width: 16, bank: 7, name: 'T6 — Stowe' }),
    straight(260, { width: 15, rise: -3 }),
    arc(42, -112, { width: 15, bank: 3, name: 'T7 — Vale' }),
    straight(130, { width: 15 }),
    arc(90, 84, { width: 15, bank: 4, name: 'T8 — Club' }),
    straight(300, { width: 16 }),
    arc(180, 60, { width: 16, bank: 6, name: 'T9 — Abbey' }),
    straight(210, { width: 15, rise: 2 }),
    arc(56, -98, { width: 15, bank: -3, name: 'T10 — Luffield' }),
    straight(120, { width: 15 }),
    arc(75, 72, { width: 15, bank: 4, name: 'T11 — Woodcote' }),
    straight(90, { width: 16 }),
  ],
};

/**
 * DELTA SPEEDBOWL — a 3.1 km banked tri-oval with one chicane: 300 km/h on
 * the banking, then a stop from the fastest point on the circuit.
 */
export const DELTA_SPEEDBOWL = {
  id: 'speedbowl',
  name: 'Delta Speedbowl',
  country: 'Superspeedway',
  hdri: 'pedestrian_overpass_1k.hdr',
  sunAzimuth: 200,
  sunElevation: 46,
  segments: [
    straight(560, { width: 18, name: 'Tri-oval' }),
    arc(240, 96, { width: 18, bank: 18, name: 'T1 — Banking' }),
    straight(120, { width: 18 }),
    arc(240, 84, { width: 18, bank: 18, name: 'T2 — Banking' }),
    straight(420, { width: 18, name: 'Back Straight' }),
    arc(70, -48, { width: 16, bank: 2, name: 'T3 — Chicane' }),
    arc(70, 48, { width: 16, bank: 2, name: 'T4 — Chicane' }),
    straight(220, { width: 18 }),
    arc(240, 90, { width: 18, bank: 18, name: 'T5 — Banking' }),
    straight(120, { width: 18 }),
    arc(240, 90, { width: 18, bank: 18, name: 'T6 — Banking' }),
    straight(140, { width: 18 }),
  ],
};

export const CIRCUITS = [APEX_INTERNATIONAL, COASTAL_SPRINT, SILVERTON_GP, COL_DE_L_AIGLE, DELTA_SPEEDBOWL];

export { lerp };
