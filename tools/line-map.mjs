#!/usr/bin/env node
/**
 * Draws a circuit from above — road, centreline, and the racing line as the
 * pacing arrows the player sees (green accelerate, yellow hold, red brake) —
 * so a change to the line or the layout can be judged without a browser.
 *
 *   node tools/line-map.mjs <circuit id> <out.png> [s0,s1]
 *
 * The optional s0,s1 window (metres of arc length) zooms in on one section.
 */
import sharp from 'sharp';

import { CIRCUITS } from '../src/track/Layout.js';
import { Pacing } from '../src/track/Pacing.js';
import { Track } from '../src/track/Track.js';

const id = process.argv[2] ?? 'apex';
const out = process.argv[3] ?? `./line-${id}.png`;
const focus = process.argv[4] ? process.argv[4].split(',').map(Number) : null;

const circuit = CIRCUITS.find((c) => c.id === id);
if (!circuit) throw new Error(`unknown circuit "${id}" — one of ${CIRCUITS.map((c) => c.id).join(', ')}`);
const track = new Track(circuit);
const pacing = new Pacing(track);
const n = track.count;

const at = (i, off) => [track.pos[i * 3] + track.lateral[i * 3] * off, track.pos[i * 3 + 2] + track.lateral[i * 3 + 2] * off];
const range = focus ? [track.indexAt(focus[0]), track.indexAt(focus[1])] : [0, n - 1];
const idxs = [];
for (let i = range[0]; ; i = (i + 1) % n) {
  idxs.push(i);
  if (i === range[1]) break;
}

let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
for (const i of idxs) {
  const [x, z] = at(i, 0);
  minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z);
}
const W = 1400, H = 1000, pad = 40;
const sc = Math.min((W - 2 * pad) / (maxx - minx + 1), (H - 2 * pad) / (maxz - minz + 1));
// +X is the driver's left when heading +Z, so flip X to draw the circuit as
// seen from above rather than from below.
const X = (x) => pad + (maxx - x) * sc;
const Y = (z) => H - pad - (z - minz) * sc;
const path = (off) => idxs.map((i, k) => { const [x, z] = at(i, off(i)); return `${k ? 'L' : 'M'}${X(x).toFixed(1)},${Y(z).toFixed(1)}`; }).join(' ');

const colours = ['#2ee06a', '#f2c81a', '#ff3b2f'];
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#3b6b3a"/>`;
const left = path((i) => track.width[i] / 2);
const right = [...idxs].reverse().map((i) => { const [x, z] = at(i, -track.width[i] / 2); return `L${X(x).toFixed(1)},${Y(z).toFixed(1)}`; }).join(' ');
svg += `<path d="${left} ${right} Z" fill="#555" stroke="#eee" stroke-width="2"/>`;
svg += `<path d="${path(() => 0)}" fill="none" stroke="#999" stroke-width="1" stroke-dasharray="6,6"/>`;

const step = Math.max(1, Math.round(5 / track.spacing));
for (const i of idxs) {
  if (i % step) continue;
  const j = (i + 1) % n;
  const [x, z] = at(i, track.lineOffset[i]);
  const [x2, z2] = at(j, track.lineOffset[j]);
  const a = Math.atan2(-(z2 - z), -(x2 - x));
  const s = Math.max(3, 1.2 * sc);
  svg += `<g transform="translate(${X(x).toFixed(1)},${Y(z).toFixed(1)}) rotate(${((a * 180) / Math.PI).toFixed(1)})"><path d="M ${-s} ${-s * 0.7} L 0 0 L ${-s} ${s * 0.7} L ${-s * 0.6} ${s * 0.7} L ${s * 0.35} 0 L ${-s * 0.6} ${-s * 0.7} Z" fill="${colours[pacing.phase[i]]}"/></g>`;
}
let last = null;
for (const i of idxs) {
  const c = track.cornerName[i];
  if (c && c !== last) {
    const [x, z] = at(i, 0);
    svg += `<text x="${X(x) + 8}" y="${Y(z) - 8}" font-size="14" fill="#fff" font-family="sans-serif">${c.replace(/&/g, '&amp;')}</text>`;
  }
  last = c;
}
svg += `<text x="${pad}" y="${H - 12}" font-size="16" fill="#fff" font-family="sans-serif">${circuit.name} · ${(track.length / 1000).toFixed(2)} km · ideal lap ${pacing.lapTime().toFixed(1)} s</text></svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out}`);
