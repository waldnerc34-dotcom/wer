#!/usr/bin/env node
/**
 * Drives a real browser through a session and saves screenshots.
 *
 * Used to verify that a build actually renders — a racing game is not
 * something you can check by reading the diff. Expects a preview server to be
 * running:
 *
 *   npm run build && npm run preview
 *   node tools/screenshot.mjs ./shots [http://127.0.0.1:4173/]
 *
 * Set CHROMIUM_PATH if Playwright's bundled browser is not installed.
 */

import { chromium } from 'playwright';
const P = process.argv[2] || './shots';
const URL = process.argv[3] || 'http://127.0.0.1:4173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(240000);
const logs = [];
page.on('console', m => { if (m.type()==='error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => logs.push(`[fail] ${r.url().slice(-70)}`));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${P}/01-menu.png` });
// Optional: CAR=concept picks the second car; MODE=race exercises the AI
// field; WEATHER=rain|storm|fog|night|overcast; CIRCUIT=<part of the name>.
if (process.env.CAR) {
  const re = new RegExp(process.env.CAR === 'concept' ? 'Khronos' : process.env.CAR, 'i');
  await page.locator('[data-field="car"] .choice').filter({ hasText: re }).first().click();
}
if (process.env.MODE === 'race') {
  await page.getByRole('button', { name: /Race/ }).click();
}
if (process.env.WEATHER) {
  const re = new RegExp(`^${process.env.WEATHER}`, 'i');
  await page.locator('[data-field="weather"] .choice').filter({ hasText: re }).first().click();
}
if (process.env.CIRCUIT) {
  const re = new RegExp(process.env.CIRCUIT, 'i');
  await page.locator('[data-field="circuit"] .choice').filter({ hasText: re }).first().click();
}
await page.locator('[data-start]').click();
await page.waitForSelector('#hud:not(.hidden)', { timeout: 240000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${P}/02-spawn.png` });

// Detached showroom camera: side-on, three-quarter, and a wide track view.
const views = [
  ['03-side',   [4.2, 1.15, 0.2],  [0, 0.55, 0]],
  ['04-threeq', [4.6, 1.9, -5.2],  [0, 0.5, 0]],
  ['05-wide',   [26, 12, -34],     [0, 0, 14]],
];
for (const [name, off, look] of views) {
  await page.evaluate(([off, look]) => {
    const g = window.APEX.game;
    g.paused = true;
    const p = g.player.position, c = g.renderer.camera;
    c.position.set(p.x + off[0], p.y + off[1], p.z + off[2]);
    c.up.set(0, 1, 0);
    c.lookAt(p.x + look[0], p.y + look[1], p.z + look[2]);
    c.fov = 42; c.updateProjectionMatrix();
    g.renderer.render(0.016);
  }, [off, look]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${P}/${name}.png` });
}
await page.evaluate(() => { window.APEX.game.paused = false; });

// Drive: hold the throttle for a few seconds and shoot the chase view, which
// is where the pacing arrows, spray and rain are actually seen.
// Headless Chromium's frame clock can stand still, so step the simulation
// by hand: a fixed 60 Hz delta, one game frame per iteration.
const drive = async (seconds) => page.evaluate((secs) => {
  const g = window.APEX.game;
  g.clock.getDelta = () => 1 / 60;
  for (let i = 0; i < Math.round(secs * 60); i++) g.frame();
}, seconds);
await page.keyboard.down('KeyW');
await drive(6);
await page.screenshot({ path: `${P}/06-driving.png` });
await page.keyboard.up('KeyW');
await page.keyboard.down('KeyS');
await drive(1.2);
await page.screenshot({ path: `${P}/07-braking.png` });
await page.keyboard.up('KeyS');
const driven = await page.evaluate(() => {
  const g = window.APEX.game; const s = g.state();
  return { speedKph: Math.round(s.speedKph), weather: s.weather, wet: s.wet, pace: s.pace,
    paceSpeedKph: Math.round(s.paceSpeedKph), arrows: g.racingLine?.mesh.count, arrowsVisible: g.racingLine?.visible,
    rainVisible: g.rain?.mesh.visible, headlights: s.headlights, wetUniform: g.materials.wetUniform.value,
    fps: Math.round(s.fps) };
});
console.log('driving:', JSON.stringify(driven));

// HUD geometry check
const hud = await page.evaluate(() => {
  const panel = document.querySelector('.timing');
  const last = panel.lastElementChild;
  return { panel: panel.getBoundingClientRect().toJSON(), lastChild: last.getBoundingClientRect().toJSON(),
    scrollH: panel.scrollHeight, clientH: panel.clientHeight };
});
console.log('HUD timing panel:', JSON.stringify(hud));

const st = await page.evaluate(() => {
  const g = window.APEX.game; const c = {};
  g.scenery.group.children.forEach(x => { const k = x.name.split(':')[0]; c[k] = (c[k]||0) + x.count; });
  const wheels = g.playerRig.wheels.map((w) => (w ? w.hub.children.length : 0));
  let tris = 0; g.playerRig.group.traverse((o) => { if (o.isMesh) tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
  return { scenery: g.scenery.instanceCount, byKind: c, wheelsBound: wheels, carTriangles: Math.round(tris) };
});
console.log('scenery:', JSON.stringify(st));
console.log('--- issues ---'); console.log([...new Set(logs)].slice(0,15).join('\n') || '(none)');
await browser.close();
