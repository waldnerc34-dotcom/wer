#!/usr/bin/env node
/**
 * Downloads every third-party asset listed in sources.mjs into public/assets.
 *
 * Assets are committed to the repository, so this only needs re-running when
 * the manifest changes. Existing files are skipped unless --force is passed.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ASSETS, REPOS } from './sources.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');
const FORCE = process.argv.includes('--force');

// Corporate/agent proxies are common in CI sandboxes and Node's global fetch
// ignores *_PROXY, so shell out to curl whenever one is configured.
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';

async function download(url) {
  if (PROXY) {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sSL', '--fail', '--max-time', '180', '--retry', '3', '--retry-delay', '2', '-o', '-', url],
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
    );
    return Buffer.from(stdout);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

async function main() {
  let fetched = 0;
  let skipped = 0;
  let bytes = 0;

  for (const asset of ASSETS) {
    const repo = REPOS[asset.repo];
    if (!repo) throw new Error(`Unknown repo "${asset.repo}" for ${asset.to}`);

    const dest = join(OUT, asset.to);
    if (!FORCE) {
      const existing = await stat(dest).catch(() => null);
      if (existing?.size > 0) {
        skipped++;
        bytes += existing.size;
        continue;
      }
    }

    const url = `${repo.base}/${repo.sha}/${asset.from}`;
    process.stdout.write(`  ↓ ${asset.to} … `);
    const buf = await download(url);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    fetched++;
    bytes += buf.length;
    console.log(kb(buf.length));
  }

  // Attribution manifest, regenerated so credits can never drift from sources.
  const credits = [...new Set(ASSETS.map((a) => a.credit))].sort();
  await writeFile(
    join(OUT, 'CREDITS.md'),
    [
      '# Third-party asset credits',
      '',
      'Every 3D model, HDRI and texture shipped with APEX was downloaded from a',
      'public repository at a pinned commit (see `scripts/sources.mjs`).',
      '',
      ...credits.map((c) => `- ${c}`),
      '',
      '## Upstream repositories',
      '',
      ...Object.entries(REPOS).map(([k, v]) => `- \`${k}\` — ${v.base} @ \`${v.sha}\``),
      '',
    ].join('\n'),
  );

  console.log(
    `\n✔ ${fetched} downloaded, ${skipped} already present — ${(bytes / 1048576).toFixed(1)} MB total`,
  );
}

main().catch((err) => {
  console.error(`\n✖ asset fetch failed: ${err.message}`);
  process.exit(1);
});
