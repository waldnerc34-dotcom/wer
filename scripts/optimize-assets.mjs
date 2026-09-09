#!/usr/bin/env node
/**
 * Optional pass that shrinks the shipped glTF models.
 *
 * Draco-compresses geometry, prunes unused data and resizes oversized
 * textures. The game runs fine on the raw downloads — this only matters if you
 * are hosting APEX somewhere bandwidth is expensive.
 *
 *   node scripts/optimize-assets.mjs [--dry]
 */

import { readdir, stat, copyFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, draco, prune, resample, textureCompress, weld } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'public', 'assets', 'models');
const DRY = process.argv.includes('--dry');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (extname(entry.name) === '.glb') yield path;
  }
}

let before = 0;
let after = 0;

for await (const file of walk(MODELS)) {
  const sizeBefore = (await stat(file)).size;
  before += sizeBefore;

  const doc = await io.read(file);
  await doc.transform(
    dedup(),
    prune(),
    resample(),
    weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048] }),
    draco({ method: 'edgebreaker' }),
  );

  const bytes = await io.writeBinary(doc);
  if (!DRY) {
    await copyFile(file, `${file}.orig`);
    await (await import('node:fs/promises')).writeFile(file, bytes);
  }
  after += bytes.length;

  const pct = (100 * (1 - bytes.length / sizeBefore)).toFixed(0);
  console.log(
    `  ${file.replace(ROOT + '/', '').padEnd(44)} ${(sizeBefore / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB  (-${pct}%)`,
  );
}

console.log(
  `\n${DRY ? '(dry run) ' : ''}total ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB`,
);
