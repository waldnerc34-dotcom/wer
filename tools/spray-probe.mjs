#!/usr/bin/env node
/**
 * Photographs what the tyres throw up.
 *
 * The software renderer here manages about two frames a second, and the
 * physics clamps its timestep, so a car left to accelerate on its own never
 * reaches a speed that throws anything. This holds the car at a chosen speed
 * instead — the velocity is what the effects read — and photographs the wake
 * on the road and, with LAT set, off it.
 *
 *   WEATHER=Rain node tools/spray-probe.mjs
 *   WEATHER=Clear LAT=11 node tools/spray-probe.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:4173/';
const QUALITY = process.env.QUALITY || 'Quality';
const WEATHER = process.env.WEATHER || 'Rain';
const [W, H] = (process.env.VIEWPORT || '900x420').split('x').map(Number);
const AT = Number(process.env.AT || 0.02);
const LAT = Number(process.env.LAT || 0);
const SPEED = Number(process.env.SPEED || 46);
const NAME = process.env.NAME || 'spray';

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
await page.locator('[data-field="weather"] .choice').filter({ hasText: new RegExp(`^${WEATHER}`, 'i') }).first().click();
await page.locator('[data-start]').click();
await page.waitForSelector('#hud:not(.hidden)', { timeout: 300000 });
await page.waitForTimeout(Number(process.env.SETTLE || 9000));

const report = await page.evaluate(({ f, lat, speed }) => {
  const game = window.APEX?.game;
  if (!game) return 'no game handle';
  const track = game.track;
  const s = track.length * f;
  const at = game.player.position.clone();
  track.aiLineAt(s, 0.5, at);
  const i = track.indexAt(s);
  const tx = track.tangent[i * 3];
  const tz = track.tangent[i * 3 + 2];
  at.x += tz * lat;
  at.z += -tx * lat;
  game.player.reset(at, Math.atan2(tx, tz));
  game.camera.reset(game.player);
  // Skip the start procedure: at two frames a second the lights would take
  // two minutes of wall clock to go out, and the grid pins the car until
  // they do.
  game.race.phase = 'racing';

  // Hold the car at speed: the physics would otherwise never get it there in
  // the handful of simulated seconds this renderer can manage.
  window.__hold = true;
  const pin = () => {
    if (!window.__hold) return;
    const p = game.player;
    p.velocity.set(0, 0, 1).applyQuaternion(p.quaternion).multiplyScalar(speed);
    for (const w of p.wheels) w.omega = speed / w.radius;
    requestAnimationFrame(pin);
  };
  requestAnimationFrame(pin);
  return `at ${(f * 100).toFixed(0)}% of the lap, ${lat} m off line, held at ${speed} m/s`;
}, { f: AT, lat: LAT, speed: SPEED });
console.log(report);

await page.waitForTimeout(Number(process.env.HOLD || 14000));
const live = await page.evaluate(() => {
  const fx = window.APEX?.game?.effects;
  if (!fx) return 'no effects';
  let n = 0;
  for (let i = 0; i < fx.smoke.count; i++) if (fx.smoke.life[i] > 0) n++;
  return `${n} particle(s) alive of ${fx.smoke.count}, speed ${window.APEX.game.player.speedKph.toFixed(0)} km/h`;
});
console.log('  ' + live);
await page.screenshot({ path: `shots/${NAME}.png` });
console.log(`  wrote shots/${NAME}.png`);

if (logs.length) console.log('console:\n  ' + logs.slice(0, 8).join('\n  '));
await browser.close();
