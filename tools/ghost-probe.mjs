#!/usr/bin/env node
/**
 * Starts a session with a ghost and checks it is on the circuit and moving.
 *
 * The replay is covered by tests/ghost.test.mjs; what this adds is everything
 * around it — that the trace is found and loaded by the running game, that a
 * car gets built from it, and that it is driven by the lap clock rather than
 * sitting on the grid.
 *
 *   node tools/ghost-probe.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:4173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });

let bad = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('[data-start]', { timeout: 30000 });
check('the ghost picker is on the start screen', await page.locator('[data-field="ghost"] .choice').count() === 3);

await page.locator('[data-field="quality"] .choice').filter({ hasText: /Performance/i }).first().click();
await page.locator('[data-start]').click();
await page.waitForSelector('#hud:not(.hidden)', { timeout: 300000 });

const found = await page.evaluate(() => {
  const g = window.APEX?.game?.ghost;
  return g ? { label: g.label, lapTime: g.lapTime, samples: g.player.trace.count } : null;
});
check('a ghost was loaded', Boolean(found), found ? `${found.label}, ${found.lapTime.toFixed(3)}s, ${found.samples} samples` : 'none');

if (found) {
  // A ghost is a lap, so it only runs once your lap is running — on the way
  // out to the line there is nothing to compare against and it stays hidden.
  // Under a software renderer the car cannot reach the line in any reasonable
  // time, so the clock is what gets driven here rather than the car.
  const idle = await page.evaluate(() => ({
    started: window.APEX.game.timer.started,
    visible: window.APEX.game.ghost.group.visible,
  }));
  check('it stays off the circuit until the lap starts', !idle.started && !idle.visible);

  const walk = await page.evaluate(async () => {
    const g = window.APEX.game.ghost;
    const seen = [];
    for (const t of [0, 5, 12, 25, 40]) {
      g.update(t, true);
      seen.push({ t, x: g.group.position.x, z: g.group.position.z, visible: g.group.visible });
    }
    return seen;
  });

  check('it appears once the lap is running', walk.every((s) => s.visible));
  let total = 0;
  for (let i = 1; i < walk.length; i++) {
    total += Math.hypot(walk[i].x - walk[i - 1].x, walk[i].z - walk[i - 1].z);
  }
  check('it travels the circuit as the clock runs', total > 500, `${total.toFixed(0)} m over 40 s`);
  check(
    'it is somewhere sensible on the map',
    walk.every((s) => Number.isFinite(s.x) && Math.abs(s.x) < 1e4),
  );
}

const real = errors.filter((e) => !/Failed to load resource|favicon|relay|websocket/i.test(e));
check('nothing threw', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
process.exit(bad ? 1 : 0);
