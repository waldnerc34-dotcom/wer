#!/usr/bin/env node
/**
 * Loads the game at a given quality preset in a real browser and reports
 * whether it drew anything.
 *
 *   QUALITY=Mobile VIEWPORT=844x390 DPR=3 node tools/gfx-probe.mjs
 *
 * "Drew anything" is measured rather than assumed: a lost context and a
 * working one are both a page with a canvas on it, and the difference — a
 * black rectangle where the circuit should be — is invisible to any check
 * that only asks whether the game started.
 *
 * The measurement comes from a screenshot rather than from reading the canvas
 * back inside the page. Without `preserveDrawingBuffer` the drawing buffer is
 * gone by the time script runs again, so an in-page read returns black for a
 * perfectly healthy frame — which is a false alarm about exactly the bug this
 * is here to catch.
 */
import { chromium } from 'playwright';
import zlib from 'node:zlib';

const URL = process.env.URL || 'http://127.0.0.1:4173/';
const QUALITY = process.env.QUALITY || 'Mobile';
const [W, H] = (process.env.VIEWPORT || '844x390').split('x').map(Number);
const DPR = Number(process.env.DPR || 3);
const SHOT = process.env.SHOT || null;

/** Minimal PNG reader: enough to get pixels out of a screenshot. */
function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 3;
  const chunks = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(pos + 8);
      height = buffer.readUInt32BE(pos + 12);
      channels = buffer[pos + 17] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      chunks.push(buffer.subarray(pos + 8, pos + 8 + length));
    }
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(line, 0, read, read + stride);
    read += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
  }
  return { width, height, channels, data: out };
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
  isMobile: DPR > 1.5,
  hasTouch: DPR > 1.5,
});
page.setDefaultTimeout(300000);
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning' || process.env.VERBOSE) {
    logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
  }
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(1200);
await page.locator('[data-field="quality"] .choice').filter({ hasText: new RegExp(QUALITY, 'i') }).first().click();
if (process.env.MODE === 'race') await page.getByRole('button', { name: /Race/ }).click();
if (process.env.CIRCUIT) {
  await page.locator('[data-field="circuit"] .choice')
    .filter({ hasText: new RegExp(process.env.CIRCUIT, 'i') }).first().click();
}
if (process.env.WEATHER) {
  await page.locator('[data-field="weather"] .choice')
    .filter({ hasText: new RegExp(`^${process.env.WEATHER}`, 'i') }).first().click();
}
await page.locator('[data-start]').click();
await page.waitForSelector('#hud:not(.hidden)', { timeout: 300000 });
await page.waitForTimeout(Number(process.env.SETTLE || 6000));

const state = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  return {
    drawing: `${gl.drawingBufferWidth}×${gl.drawingBufferHeight}`,
    lost: gl.isContextLost(),
    hud: document.querySelector('#hud')?.innerText?.replace(/\s+/g, ' ').slice(0, 110),
  };
});

const shot = await page.screenshot(SHOT ? { path: SHOT } : {});
const png = decodePng(SHOT ? (await import('node:fs')).readFileSync(SHOT) : shot);
const { width, height, channels, data } = png;
let lit = 0;
let total = 0;
let sum = 0;
const tones = new Set();
for (let y = (height / 4) | 0; y < (height * 3) / 4; y += 3) {
  for (let x = (width / 4) | 0; x < (width * 3) / 4; x += 3) {
    const o = y * width * channels + x * channels;
    const v = (data[o] + data[o + 1] + data[o + 2]) / 3;
    sum += v;
    total++;
    if (v > 12) lit++;
    tones.add(`${data[o] >> 4},${data[o + 1] >> 4},${data[o + 2] >> 4}`);
  }
}
const litShare = lit / total;
const mean = sum / total;

console.log(`${QUALITY} @ ${W}×${H} dpr ${DPR}`);
console.log(`  drawing buffer ${state.drawing} · context ${state.lost ? 'LOST' : 'ok'}`);
console.log(`  ${(litShare * 100).toFixed(1)}% lit · mean ${mean.toFixed(0)}/255 · ${tones.size} tones`);
if (state.hud) console.log(`  hud: ${state.hud.trim()}`);
if (logs.length) console.log('  console:\n' + logs.slice(0, 14).map((l) => '    ' + l).join('\n'));
await browser.close();
// A live frame of a circuit in daylight is nearly all lit and has hundreds of
// tones in it. A dead one is neither.
process.exit(state.lost || litShare < 0.85 || tones.size < 60 ? 1 : 0);
