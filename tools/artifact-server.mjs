#!/usr/bin/env node
/**
 * Serves artifact/apex.html the way the artifact host does — wrapped in a
 * bare document shell — under a Content-Security-Policy stricter than any
 * plausible sandbox: nothing may be fetched, no blob: or worker, images only
 * from data: URIs. If the game boots here, it boots there.
 *
 *   node tools/artifact-server.mjs [port]
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 4180);

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "worker-src 'none'",
  "media-src 'none'",
].join('; ');

createServer(async (req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404).end();
    return;
  }
  const content = await readFile(join(ROOT, 'artifact', 'apex.html'), 'utf8');
  const shell = `<!doctype html><html><head><meta charset="utf-8" /><style>body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>\n${content}\n</body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': CSP,
    'Cache-Control': 'no-store',
  });
  res.end(shell);
}).listen(PORT, '127.0.0.1', () => console.log(`artifact shell on http://127.0.0.1:${PORT}/ with CSP: ${CSP}`));
