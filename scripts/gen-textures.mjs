#!/usr/bin/env node
/**
 * Authors the tileable PBR surface maps that the circuit is built from.
 *
 * There is no CC0 asphalt scan available from the mirrors we pin against, so
 * the track surfaces are synthesised here instead: a height field built from
 * wrapped Worley cells (the aggregate) plus fBm grain (the binder), then
 * resolved into base colour / roughness / normal. Everything is periodic, so
 * the maps tile without a visible seam at any repeat count.
 *
 * Output: public/assets/textures/*.png
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets', 'textures');

/* ------------------------------------------------------------------ noise -- */

const hash = (x, y, seed) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Value noise on a lattice that wraps every `period` cells. */
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const u = smooth(xf);
  const v = smooth(yf);
  return lerp(
    lerp(hash(x0, y0, seed), hash(x1, y0, seed), u),
    lerp(hash(x0, y1, seed), hash(x1, y1, seed), u),
    v,
  );
}

/** Fractal Brownian motion; `period` is in cells at the base octave. */
function fbm(x, y, period, octaves, seed, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, period * freq, seed + o * 101);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Wrapped Worley/cellular noise.
 * Returns { f1, f2, id } — distance to nearest feature, to the second nearest,
 * and a stable per-cell random used to tint individual stones.
 */
function worley(x, y, cells, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash(wx, wy, seed);
      const py = cy + hash(wx, wy, seed + 7919);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash(wx, wy, seed + 104729);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, id };
}

/* ------------------------------------------------------------------ write -- */

async function writePNG(name, size, channels, data) {
  await mkdir(OUT, { recursive: true });
  const file = join(OUT, name);
  await sharp(Buffer.from(data), { raw: { width: size, height: size, channels } })
    .png({ compressionLevel: 9 })
    .toFile(file);
  console.log(`  ✎ ${name}  ${size}×${size}`);
}

/**
 * Sobel-differentiates a height field into a tangent-space normal map.
 * Sampling wraps, so the normal map stays seamless.
 */
function heightToNormal(height, size, strength) {
  const rgb = new Uint8Array(size * size * 3);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 3;
      rgb[i] = Math.round((nx * 0.5 + 0.5) * 255);
      rgb[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgb[i + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5);
    }
  }
  return rgb;
}

/* --------------------------------------------------------------- asphalt -- */

async function asphalt(size = 1024) {
  console.log('· asphalt');
  const height = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 3);
  const rough = new Uint8Array(size * size);

  // One tile covers roughly 6 m of road, so these cell counts land the coarse
  // chippings around 4 cm and the fines around 1.5 cm.
  const COARSE = 150;
  const FINE = 380;
  const s = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;

      const c = worley(u * COARSE, v * COARSE, COARSE, 11);
      const f = worley(u * FINE, v * FINE, FINE, 29);

      // Cell *interiors* are the stones; the f2-f1 ridge is the binder gap
      // between them. This reads as packed aggregate rather than blobs.
      const coarseGap = clamp01((c.f2 - c.f1) * 5.5);
      const fineGap = clamp01((f.f2 - f.f1) * 6.5);
      const grain = fbm(u * 260, v * 260, 260, 4, 5);

      // Macro structure: paving passes, patched repairs, bleached vs fresh.
      const patch = fbm(u * 3, v * 3, 3, 5, 71);
      const blotch = fbm(u * 11, v * 11, 11, 4, 233);

      let h = coarseGap * 0.5 + fineGap * 0.26 + grain * 0.16 + patch * 0.08;

      // Hairline cracking, gated to a few regions so it is not uniform.
      const crackMask = clamp01(1 - Math.abs(c.f2 - c.f1) * 4.2);
      const crack = crackMask * clamp01((fbm(u * 8, v * 8, 8, 3, 313) - 0.6) * 5);
      h -= crack * 0.55;

      height[y * size + x] = h;

      // --- base colour -----------------------------------------------------
      // Linear albedo of asphalt sits around 0.04–0.10. Individual chippings
      // are markedly lighter than the bitumen holding them, and whole patches
      // age at different rates.
      const age = patch * 0.55 + blotch * 0.45; // 0 fresh/black … 1 bleached
      let lum = lerp(0.026, 0.061, age);

      // Exposed aggregate, tinted per stone.
      const stone = coarseGap * (0.35 + c.id * 0.65);
      lum += stone * lerp(0.013, 0.044, age);
      lum += fineGap * (0.1 + f.id * 0.2) * 0.035;
      lum *= 0.86 + grain * 0.28;
      lum -= crack * 0.02;

      // Oily/rubbered-in darkening in a few places.
      const rubber = clamp01((fbm(u * 4, v * 4, 4, 4, 907) - 0.58) * 3.6);
      lum = lerp(lum, lum * 0.55, rubber);

      // Bitumen is faintly cool; the chippings are faintly warm.
      const warm = clamp01(stone);
      const r = clamp01(lum * (0.97 + warm * 0.16));
      const g = clamp01(lum * (0.98 + warm * 0.06));
      const b = clamp01(lum * (1.08 - warm * 0.1));

      const i = (y * size + x) * 3;
      albedo[i] = Math.round(Math.sqrt(r) * 255);
      albedo[i + 1] = Math.round(Math.sqrt(g) * 255);
      albedo[i + 2] = Math.round(Math.sqrt(b) * 255);

      // --- roughness -------------------------------------------------------
      // Polished stone faces and rubbered-in areas go glossier; open binder
      // and cracked ground stay near-matte. Wide spread is what sells wet-ish
      // sheen under a low sun.
      let rr = 0.97 - stone * 0.3 - rubber * 0.22 - blotch * 0.1;
      rr += crack * 0.03 - grain * 0.06;
      rough[y * size + x] = Math.round(clamp01(rr) * 255);
    }
  }

  await writePNG('asphalt_basecolor.png', size, 3, albedo);
  await writePNG('asphalt_roughness.png', size, 1, rough);
  await writePNG('asphalt_normal.png', size, 3, heightToNormal(height, size, 1.05));
}

/* ------------------------------------------------------------------ kerb -- */

async function kerb(size = 512) {
  console.log('· kerb');
  const height = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 3);
  const rough = new Uint8Array(size * size);
  const s = 1 / size;

  // Six stripes down the tile; V runs along the kerb.
  const STRIPES = 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      const band = Math.floor(v * STRIPES);
      const red = band % 2 === 0;

      // Slight crown across each kerb tooth, plus cast-concrete pitting.
      const pit = worley(u * 90, v * 90, 90, 401);
      const grain = fbm(u * 150, v * 150, 150, 3, 909);
      const edge = Math.abs(v * STRIPES - band - 0.5) * 2; // 0 mid, 1 at joint
      const joint = clamp01(1 - (1 - edge) * 6);
      let h = 0.55 + Math.cos((u - 0.5) * Math.PI) * 0.18 + grain * 0.12;
      h -= clamp01(1 - pit.f1 * 2.6) * 0.12;
      h -= joint * 0.35;
      height[y * size + x] = h;

      // Painted kerbs scuff badly where cars ride them.
      const wear = clamp01(fbm(u * 7, v * 3, 7, 4, 55) * 1.25 - 0.28);
      const dirt = fbm(u * 40, v * 12, 40, 3, 88) * 0.22;

      let r;
      let g;
      let b;
      if (red) {
        r = 0.24;
        g = 0.026;
        b = 0.024;
      } else {
        r = 0.6;
        g = 0.59;
        b = 0.57;
      }
      // Rubber and grime pull everything toward dark grey.
      const grey = 0.09 + grain * 0.05;
      const k = clamp01(wear * 0.65 + dirt);
      r = lerp(r, grey, k) * (0.9 + grain * 0.2);
      g = lerp(g, grey, k) * (0.9 + grain * 0.2);
      b = lerp(b, grey, k) * (0.9 + grain * 0.2);

      const i = (y * size + x) * 3;
      albedo[i] = Math.round(Math.sqrt(clamp01(r)) * 255);
      albedo[i + 1] = Math.round(Math.sqrt(clamp01(g)) * 255);
      albedo[i + 2] = Math.round(Math.sqrt(clamp01(b)) * 255);

      rough[y * size + x] = Math.round(clamp01(0.52 + wear * 0.35 + grain * 0.1) * 255);
    }
  }

  await writePNG('kerb_basecolor.png', size, 3, albedo);
  await writePNG('kerb_roughness.png', size, 1, rough);
  await writePNG('kerb_normal.png', size, 3, heightToNormal(height, size, 2.6));
}

/* -------------------------------------------------------------- concrete -- */

async function concrete(size = 512) {
  console.log('· concrete');
  const height = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 3);
  const rough = new Uint8Array(size * size);
  const s = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      const pit = worley(u * 70, v * 70, 70, 1301);
      const grain = fbm(u * 190, v * 190, 190, 4, 77);
      const blotch = fbm(u * 6, v * 6, 6, 4, 151);

      const pockmark = clamp01(1 - pit.f1 * 3.1);
      const h = 0.6 + grain * 0.25 - pockmark * 0.3;
      height[y * size + x] = h;

      const lum = clamp01(0.3 + blotch * 0.16 + grain * 0.07 - pockmark * 0.1);
      const i = (y * size + x) * 3;
      albedo[i] = Math.round(Math.sqrt(lum * 1.0) * 255);
      albedo[i + 1] = Math.round(Math.sqrt(lum * 0.99) * 255);
      albedo[i + 2] = Math.round(Math.sqrt(lum * 0.95) * 255);
      rough[y * size + x] = Math.round(clamp01(0.82 + grain * 0.14) * 255);
    }
  }

  await writePNG('concrete_basecolor.png', size, 3, albedo);
  await writePNG('concrete_roughness.png', size, 1, rough);
  await writePNG('concrete_normal.png', size, 3, heightToNormal(height, size, 1.5));
}

/* --------------------------------------------------------------- sprites -- */

/** Soft, lumpy alpha puff used for tyre smoke and dust. */
async function smoke(size = 256) {
  console.log('· smoke sprite');
  const rgba = new Uint8Array(size * size * 4);
  const s = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s - 0.5;
      const v = y * s - 0.5;
      const d = Math.hypot(u, v) * 2;
      const n = fbm(x * s * 6, y * s * 6, 6, 5, 1997);
      const falloff = clamp01(1 - d);
      let a = Math.pow(falloff, 1.7) * (0.55 + n * 0.85);
      a = clamp01(a - 0.06);
      const i = (y * size + x) * 4;
      const l = Math.round((0.72 + n * 0.28) * 255);
      rgba[i] = l;
      rgba[i + 1] = l;
      rgba[i + 2] = l;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  await writePNG('smoke.png', size, 4, rgba);
}

/** Tyre-mark ribbon: dark, slightly broken up along its length. */
async function skid(size = 128) {
  console.log('· skid mark');
  const rgba = new Uint8Array(size * size * 4);
  const s = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * s;
      const v = y * s;
      // Two contact patches with a gap: tread blocks scrubbing rubber off.
      const across = Math.abs(u - 0.5) * 2;
      const tread = 0.55 + 0.45 * Math.cos(u * Math.PI * 14);
      const n = fbm(u * 10, v * 26, 10, 4, 613);
      let a = clamp01(1 - Math.pow(across, 3.5)) * (0.55 + n * 0.6) * (0.7 + tread * 0.3);
      a = clamp01(a * 1.15 - 0.1);
      const i = (y * size + x) * 4;
      rgba[i] = 14;
      rgba[i + 1] = 13;
      rgba[i + 2] = 13;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  await writePNG('skid.png', size, 4, rgba);
}

/** Metallic-flake normals for car paint: dense, randomly oriented facets. */
async function flake(size = 512) {
  console.log('· paint flake');
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Each texel is one aluminium flake with a random tilt. Most lie flat;
      // a minority catch the light hard, which is what makes metallic paint
      // sparkle as the camera moves.
      const a = hash(x, y, 31) * Math.PI * 2;
      const strength = Math.pow(hash(x, y, 977), 3.2); // heavy tail
      const nx = Math.cos(a) * strength;
      const ny = Math.sin(a) * strength;
      const nz = Math.sqrt(Math.max(0.0001, 1 - nx * nx - ny * ny));
      const i = (y * size + x) * 3;
      rgb[i] = Math.round((nx * 0.5 + 0.5) * 255);
      rgb[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgb[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  await writePNG('flake_normal.png', size, 3, rgb);
}

/* -------------------------------------------------------------------- go -- */

const t0 = Date.now();
await asphalt();
await kerb();
await concrete();
await smoke();
await skid();
await flake();
console.log(`\n✔ surface maps authored in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
