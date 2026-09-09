#!/usr/bin/env node
/**
 * Serves the built game on every network interface, so a phone on the same
 * Wi-Fi can open it — and prints the addresses to type in.
 *
 *   npm start            build, then serve on port 4173
 *   PORT=8080 npm start  another port
 *
 * Add to Home Screen works from here on iPhone (Share → Add to Home Screen)
 * and on a desktop browser at http://localhost. Android's install prompt
 * needs HTTPS, which a home Wi-Fi address does not have; the GitHub Pages
 * deployment is the address to install from there.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('No build found — run `npm run build` first (or `npm start`, which does).');
  process.exit(1);
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) file = join(ROOT, 'index.html');
  const ext = extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    // Hashed bundles and assets can be cached hard; the shell must not be.
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}).listen(PORT, '0.0.0.0', () => {
  const addresses = [`http://localhost:${PORT}/`];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(`http://${net.address}:${PORT}/`);
    }
  }
  console.log('\nAPEX is up. Open one of these:\n');
  for (const a of addresses) console.log(`  ${a}`);
  console.log('\nOn a phone on the same Wi-Fi use the second address, then Share → Add to Home Screen.\n');
});
