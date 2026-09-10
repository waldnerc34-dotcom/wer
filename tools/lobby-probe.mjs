#!/usr/bin/env node
/**
 * Walks the multiplayer screens with a mouse, and checks nothing throws.
 *
 * The relays that introduce peers are unreachable from some networks, this
 * sandbox included, so this cannot check that two people actually meet. What
 * it can check is that the flow in front of them works and survives a room
 * that never connects — which is the same thing a player on a locked-down
 * office network will see.
 *
 *   node tools/lobby-probe.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:4173/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });

let bad = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('[data-start]', { timeout: 30000 });

check('the record board is on the start screen', await page.locator('.leaderboard').count() > 0);
check('there is a way to race friends', await page.locator('[data-friends]').count() > 0);

await page.locator('[data-friends]').click();
await page.waitForSelector('#lobby-name', { timeout: 15000 });
check('the room screen asks who you are', await page.locator('#lobby-name').count() > 0);
check('joining is refused without a code', await page.locator('[data-join]').isDisabled());

await page.locator('#lobby-code').fill('ABCDE');
check('a code enables the join button', !(await page.locator('[data-join]').isDisabled()));

await page.locator('#lobby-name').fill('Chris');
await page.locator('[data-host]').click();
await page.waitForSelector('.code-big', { timeout: 20000 });

const code = (await page.locator('.code-big').textContent()).trim();
check('hosting produces a room code', /^[A-Z0-9]{5}$/.test(code), code);
check('you are on the grid', await page.locator('.grid-row.self').count() === 1);
check('your name is on it', (await page.locator('.grid-row.self .who').textContent()).includes('Chris'));
check('you are the host', (await page.locator('.grid-row.self .who em').textContent()) === 'host');
check('the host can pick a circuit', await page.locator('[data-circuits] .choice').count() > 0);
check('the start button is live for the host', !(await page.locator('[data-start]').isDisabled()));
check('you can pick a car in the room', await page.locator('[data-cars] .choice').count() > 0);

await page.locator('[data-leave]').click();
await page.waitForSelector('[data-start]', { timeout: 15000 });
check('leaving puts the start screen back', await page.locator('[data-friends]').count() > 0);

// Relay failures are expected here and are warnings, not faults.
const real = errors.filter((e) => !/websocket|relay|announce|ECONNREFUSED|network|Failed to load resource/i.test(e));
check('nothing threw', real.length === 0, real.slice(0, 3).join(' | '));

if (errors.length) console.log(`  (${errors.length} console message(s), ${errors.length - real.length} of them relay noise)`);
await browser.close();
process.exit(bad ? 1 : 0);
