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

/**
 * Puts the car somewhere round the lap and sets the bloom's blend function.
 *
 * Moving the *light* does not move the sun: the visible one lives in the sky
 * texture, so the only way to look at it is to look the way the report was
 * looking. `fraction` is how far round the lap to teleport to.
 */
const place = async (fraction, blend) =>
  page.evaluate(
    ({ f, b }) => {
      const game = window.APEX?.game;
      if (!game) return 'no game handle';
      const track = game.track;
      const s = track.length * f;
      // A real Vector3, borrowed rather than imported.
      const at = game.player.position.clone();
      track.aiLineAt(s, 0.5, at);
      const i = track.indexAt(s);
      const heading = Math.atan2(track.tangent[i * 3], track.tangent[i * 3 + 2]);
      game.player.reset(at, heading);
      game.camera.reset(game.player);
      game.renderer.bloom.blendMode.blendFunction = b;
      return `lap ${(f * 100).toFixed(0)}%, bloom blend ${b === 0 ? 'ADD' : 'SCREEN'}`;
    },
    { f: fraction, b: blend },
  );

const AT = Number(process.env.AT || 0.22);
for (const [name, blend] of [['screen', 28], ['add', 0]]) {
  console.log(await place(AT, blend));
  await page.waitForTimeout(Number(process.env.HOLD || 12000));
  await page.screenshot({ path: `shots/sun-${name}.png` });
  console.log(`  wrote shots/sun-${name}.png`);
}

if (logs.length) console.log('console:\n  ' + logs.slice(0, 6).join('\n  '));
await browser.close();
