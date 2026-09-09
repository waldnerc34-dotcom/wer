#!/usr/bin/env node
/**
 * Optional pass that shrinks the shipped glTF models.
 *
 * Draco-compresses geometry, prunes unused data, and re-encodes textures as
 * WebP at a size appropriate to what they are. Run after `npm run assets`;
 * the committed models are the output of this pass. Re-running it on already
 * optimised files is harmless.
 *
 *   node scripts/optimize-assets.mjs [--dry]
 */

import { readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO, PropertyType } from '@gltf-transform/core';
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

  // Scenery textures are flat colour swatches; cars carry real detail.
  const isCar = file.includes('/cars/');
  const maxTexture = isCar ? 2048 : 512;

  const doc = await io.read(file);
  await doc.transform(
    // Materials are deliberately not deduplicated: the car rig classifies
    // parts by material *name*, and merging two identical-looking materials
    // would silently drop one of those names.
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE, PropertyType.MESH] }),
    // Keep empty nodes — wheel hubs in some models are transform-only groups.
    prune({ keepLeaves: true, keepAttributes: true }),
    resample(),
    weld(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [maxTexture, maxTexture],
      quality: isCar ? 88 : 80,
    }),
    draco({ method: 'edgebreaker' }),
  );

  const bytes = await io.writeBinary(doc);
  if (!DRY) await writeFile(file, bytes);
  after += bytes.length;

  const pct = (100 * (1 - bytes.length / sizeBefore)).toFixed(0);
  console.log(
    `  ${file.replace(ROOT + '/', '').padEnd(44)} ${(sizeBefore / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB  (-${pct}%)`,
  );
}

console.log(
  `\n${DRY ? '(dry run) ' : ''}total ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB`,
);
