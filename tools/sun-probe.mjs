#!/usr/bin/env node
/**
 * Points the sun straight down the camera and photographs it, with the
 * highlight guard on and off, in one page load.
 *
 * The black-disc-with-a-ring at the sun is only visible from angles a
 * stationary car on the grid does not have, which made it impossible to check
 * from an ordinary screenshot. This moves the sun to the camera instead.
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:4173/';
const QUALITY = process.env.QUALITY || 'Quality';
const [W, H] = (process.env.VIEWPORT || '900x420').split('x').map(Number);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.setDefaultTimeout(300000);
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));

await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(1200);
await page.locator('[data-field="quality"] .choice').filter({ hasText: new RegExp(QUALITY, 'i') }).first().click();
await page.locator('[data-start]').click();
await page.waitForSelector('#hud:not(.hidden)', { timeout: 300000 });
await page.waitForTimeout(Number(process.env.SETTLE || 8000));

/** Aims the sun along the camera's own heading, and sets the guard's limit. */
const aim = async (limit) =>
  page.evaluate((lim) => {
    const game = window.APEX?.game;
    if (!game) return 'no game handle';
    const r = game.renderer;
    // The camera's forward is the negated third column of its world matrix;
    // reaching for a Vector3 would need three.js in the page's scope.
    const m = r.camera.matrixWorld.elements;
    const az = (Math.atan2(-m[8], -m[10]) * 180) / Math.PI;
    r.setSun(az, 9);
    if (r.highlights) r.highlights.limit = lim;
    return `sun at az ${az.toFixed(0)}°, guard limit ${lim}`;
  }, limit);

for (const [name, limit] of [['guard-off', 1e9], ['guard-on', 32]]) {
  console.log(await aim(limit));
  await page.waitForTimeout(Number(process.env.HOLD || 12000));
  await page.screenshot({ path: `shots/sun-${name}.png` });
  console.log(`  wrote shots/sun-${name}.png`);
}

if (logs.length) console.log('console:\n  ' + logs.slice(0, 6).join('\n  '));
await browser.close();
