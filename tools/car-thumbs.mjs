#!/usr/bin/env node
/**
 * Renders a thumbnail of every car in the game's own renderer — the same
 * paint, lighting and shadows the player sees — for the car picker.
 *
 *   node tools/car-thumbs.mjs [url]   (default http://127.0.0.1:4173/)
 *
 * Writes public/assets/thumbs/<car id>.webp, 640×360.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';

import { CARS } from '../src/physics/Vehicle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets', 'thumbs');
const URL = process.argv[2] || 'http://127.0.0.1:4173/';
const ONLY = process.argv[3] ? process.argv[3].split(',') : null;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

for (const car of CARS) {
  if (ONLY && !ONLY.includes(car.id)) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${car.id}] console: ${m.text().slice(0, 160)}`); });
  page.on('pageerror', (e) => console.log(`  [${car.id}] error: ${String(e).slice(0, 160)}`));
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.locator('[data-field="car"] .choice').filter({ hasText: car.name.split(' ').slice(-2).join(' ') }).first().click();
  await page.locator('[data-field="weather"] .choice').filter({ hasText: /^Clear/ }).first().click();
  await page.locator('[data-start]').click();
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 240000 });
  // Software rendering needs a moment for the first frames with a heavy model.
  await page.waitForTimeout(4000);
  // Read the frame straight off the canvas in the same task as the render:
  // the compositor's capture of a WebGL canvas has come back black for the
  // heaviest model, and the drawing buffer is only guaranteed until the
  // task ends.
  const dataUrl = await page.evaluate(() => {
    const g = window.APEX.game;
    g.paused = true;
    document.querySelector('#hud').style.display = 'none';
    document.querySelector('#touch').style.display = 'none';
    const p = g.player.position;
    const c = g.renderer.camera;
    // Front three-quarter, low, the way brochures shoot them.
    c.position.set(p.x - 4.6, p.y + 1.25, p.z + 4.9);
    c.up.set(0, 1, 0);
    c.lookAt(p.x, p.y + 0.35, p.z + 0.2);
    c.fov = 34;
    c.updateProjectionMatrix();
    g.renderer.render(0.016);
    g.renderer.render(0.016);
    return g.renderer.renderer.domElement.toDataURL('image/png');
  });
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  const meta = await sharp(png).metadata();
  const sx = meta.width / 1280;
  const sy = meta.height / 720;
  await sharp(png)
    .extract({ left: Math.round(160 * sx), top: Math.round(60 * sy), width: Math.round(960 * sx), height: Math.round(540 * sy) })
    .resize(640, 360)
    .webp({ quality: 84 })
    .toFile(join(OUT, `${car.id}.webp`));
  console.log(`  ${car.id}.webp`);
  await page.close();
}
await browser.close();
