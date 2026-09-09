#!/usr/bin/env node
/**
 * Drives the game as a phone would: an emulated iPhone in landscape, real
 * touch events through the DevTools protocol, and screenshots along the way.
 *
 *   npm run build && npm run preview
 *   node tools/mobile-check.mjs ./shots
 */

import { chromium, devices } from 'playwright';

const P = process.argv[2] || './shots';
const URL = process.argv[3] || 'http://127.0.0.1:4173/';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ ...devices['iPhone 13 landscape'] });
const page = await context.newPage();
page.setDefaultTimeout(300000);
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(1000);

const menu = await page.evaluate(() => ({
  touch: document.documentElement.classList.contains('is-touch'),
  steeringField: !document.querySelector('[data-field="steering"]').hidden,
  keysHidden: document.querySelector('[data-keys]').hidden,
  quality: document.querySelector('[data-field="quality"] [aria-pressed="true"]')?.textContent.trim().split('\n')[0],
  viewport: [innerWidth, innerHeight],
}));
console.log('menu', JSON.stringify(menu));
await page.screenshot({ path: `${P}/m1-menu.png` });

await page.locator('[data-start]').tap();
await page.waitForSelector('#hud:not(.hidden)');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${P}/m2-spawn.png` });

const boot = await page.evaluate(() => {
  const g = window.APEX.game;
  return {
    quality: g.renderer.qualityName,
    post: Boolean(g.renderer.composer),
    pixelRatio: g.renderer.renderer.getPixelRatio(),
    drawingBuffer: [g.renderer.renderer.domElement.width, g.renderer.renderer.domElement.height],
    touchVisible: !document.getElementById('touch').classList.contains('hidden'),
    scenery: g.scenery.instanceCount,
    opponents: g.opponents.length,
    wheels: g.playerRig.wheels.filter(Boolean).length,
  };
});
console.log('boot', JSON.stringify(boot));

// Real touches: hold the throttle pad and press the steering slider left.
const cdp = await context.newCDPSession(page);
const rect = async (sel) => page.locator(sel).boundingBox();
const gas = await rect('#touch [data-throttle]');
const steer = await rect('#touch [data-steer]');
const points = [
  { x: gas.x + gas.width / 2, y: gas.y + gas.height / 2, id: 0 },
  { x: steer.x + steer.width * 0.2, y: steer.y + steer.height / 2, id: 1 },
];
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
await page.waitForTimeout(300);

const held = await page.evaluate(() => {
  const g = window.APEX.game;
  return { throttle: g.touch.state.throttle, steer: +g.touch.steer.toFixed(2), steering: g.touch.steering };
});
console.log('held', JSON.stringify(held));

// Let the simulation run under those inputs, then release.
await page.waitForTimeout(5000);
await page.screenshot({ path: `${P}/m3-driving.png` });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(300);

const after = await page.evaluate(() => {
  const g = window.APEX.game;
  return {
    kph: Math.round(g.player.speedKph),
    steerInput: +g.input.state.steer.toFixed(2),
    throttleInput: +g.input.state.throttle.toFixed(2),
    released: { throttle: g.touch.state.throttle, steering: g.touch.steering },
    frames: g.frameTimes.length,
  };
});
console.log('after', JSON.stringify(after));

// Camera button, then pause button.
await page.locator('#touch [data-cam]').tap();
await page.waitForTimeout(200);
await page.locator('#touch [data-pause]').tap();
await page.waitForTimeout(500);
const paused = await page.evaluate(() => ({
  paused: window.APEX.game.paused,
  pauseMenu: Boolean(document.querySelector('[data-resume]')),
  camera: window.APEX.game.camera.mode,
}));
console.log('paused', JSON.stringify(paused));
await page.screenshot({ path: `${P}/m4-pause.png` });

console.log('--- issues ---');
console.log([...new Set(logs)].slice(0, 12).join('\n') || '(none)');
await browser.close();
