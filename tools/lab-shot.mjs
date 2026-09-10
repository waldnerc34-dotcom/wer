#!/usr/bin/env node
/**
 * Photographs the particle bench at lab.html.
 *
 *   NAME=spray QS='wet=0.9&surface=0' node tools/lab-shot.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:5174/lab.html';
const QS = process.env.QS || 'wet=0.9&surface=0';
const NAME = process.env.NAME || 'lab';
const [W, H] = (process.env.VIEWPORT || '960x540').split('x').map(Number);
const FRAMES = Number(process.env.FRAMES || 150);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240000);
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));

await page.goto(`${URL}?${QS}`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction((n) => (window.__labFrames ?? 0) > n, FRAMES, { timeout: 240000 });
const live = await page.evaluate(() => {
  const s = window.__lab.effects.smoke;
  let n = 0;
  for (let i = 0; i < s.count; i++) if (s.life[i] > 0) n++;
  return n;
});
console.log(`${QS}: ${live} particle(s) alive after ${FRAMES} frames`);
await page.screenshot({ path: `shots/${NAME}.png` });
console.log(`  wrote shots/${NAME}.png`);
if (logs.length) console.log('console:\n  ' + logs.slice(0, 6).join('\n  '));
await browser.close();
