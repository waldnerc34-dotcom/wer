#!/usr/bin/env node
/**
 * Draws the app icon and writes every size the platforms ask for.
 *
 * The mark is the game's own signature: a pacing chevron on tarmac, cut by
 * a kerb stripe, lit from the upper left. Drawn as SVG so it stays crisp,
 * rasterised with sharp for the manifest and the home screen.
 *
 *   node tools/make-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'icons');

/** @param {boolean} maskable  full-bleed for maskable icons, rounded otherwise */
function icon(maskable) {
  const r = maskable ? 0 : 118;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2b2f36"/>
      <stop offset="0.55" stop-color="#15171b"/>
      <stop offset="1" stop-color="#0b0c0f"/>
    </linearGradient>
    <linearGradient id="chev" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff5a3c"/>
      <stop offset="1" stop-color="#d81e1e"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.18"/>
    </linearGradient>
    <pattern id="grain" width="6" height="6" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.6" fill="#ffffff" fill-opacity="0.045"/>
      <circle cx="4" cy="4" r="0.5" fill="#000000" fill-opacity="0.12"/>
    </pattern>
    <clipPath id="clip"><rect width="512" height="512" rx="${r}"/></clipPath>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <rect width="512" height="512" fill="url(#grain)"/>
    <!-- kerb stripe along the lower right -->
    <g transform="rotate(-32 256 256)">
      <rect x="-80" y="430" width="700" height="46" fill="#e8e6e1"/>
      ${Array.from({ length: 12 }, (_, i) => `<rect x="${-80 + i * 60}" y="430" width="30" height="46" fill="#c8271f"/>`).join('')}
      <rect x="-80" y="476" width="700" height="10" fill="#000" fill-opacity="0.35"/>
    </g>
    <!-- centre line -->
    <g transform="rotate(-32 256 256)" opacity="0.55">
      ${Array.from({ length: 9 }, (_, i) => `<rect x="${-60 + i * 80}" y="252" width="44" height="7" fill="#e8e6e1"/>`).join('')}
    </g>
    <!-- chevron -->
    <path d="M 256 118 L 396 296 L 342 296 L 256 190 L 170 296 L 116 296 Z" fill="url(#chev)"/>
    <path d="M 256 232 L 340 338 L 286 338 L 256 300 L 226 338 L 172 338 Z" fill="url(#chev)" opacity="0.92"/>
    <path d="M 256 118 L 396 296 L 342 296 L 256 190 L 170 296 L 116 296 Z" fill="#000" opacity="0.12" transform="translate(0 6)"/>
    <rect width="512" height="512" fill="url(#gloss)"/>
  </g>
</svg>`;
}

await mkdir(OUT, { recursive: true });
const jobs = [
  ['icon-512.png', 512, false],
  ['icon-192.png', 192, false],
  ['icon-maskable-512.png', 512, true],
  ['icon-maskable-192.png', 192, true],
  ['apple-touch-icon.png', 180, true],
  ['favicon-64.png', 64, false],
];
for (const [name, size, maskable] of jobs) {
  const svg = Buffer.from(icon(maskable));
  await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(join(OUT, name));
}
await writeFile(join(OUT, 'icon.svg'), icon(false));
console.log(`wrote ${jobs.length} icons to public/icons`);
