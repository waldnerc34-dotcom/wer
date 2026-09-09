#!/usr/bin/env node
/**
 * Converts every PNG in public/assets/textures to WebP and removes the PNG.
 *
 * The authored surface maps are written as PNG so they stay exact on disk,
 * but a phone should not have to pull 3 MB for one normal map. Normal maps
 * are encoded near-losslessly (a lossy normal map shows as banding on flat
 * paint and tarmac); everything else is ordinary lossy WebP.
 *
 *   node scripts/compress-textures.mjs
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public', 'assets', 'textures');

let before = 0;
let after = 0;

for (const name of (await readdir(DIR)).sort()) {
  if (!name.endsWith('.png')) continue;
  const src = join(DIR, name);
  const dst = src.replace(/\.png$/, '.webp');
  const isNormal = /normal/i.test(name);
  const isData = /rough|metal|orm/i.test(name);

  const image = sharp(src);
  const meta = await image.metadata();
  const out = image.webp({
    quality: isNormal ? 92 : isData ? 82 : 86,
    alphaQuality: 90,
    effort: 6,
  });

  await out.toFile(dst);
  const a = (await stat(src)).size;
  const b = (await stat(dst)).size;
  before += a;
  after += b;
  await unlink(src);
  console.log(
    `  ${name.padEnd(28)} ${String(meta.width).padStart(4)}² ${(a / 1024).toFixed(0).padStart(5)} KB → ${(b / 1024).toFixed(0).padStart(4)} KB`,
  );
}

console.log(`\n✔ textures ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB`);
