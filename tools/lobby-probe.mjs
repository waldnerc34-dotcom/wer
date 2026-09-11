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

/* ------------------------------------------------ connecting by hand ---- */

// The relays really are unreachable from this machine, which makes it the
// right place to walk the flow that exists for exactly that: two windows, one
// invite sent between them by hand, and nothing else in the world involved.

await page.locator('[data-friends]').click();
await page.waitForSelector('#lobby-name', { timeout: 15000 });
await page.locator('#lobby-name').fill('Ada');
await page.locator('[data-host]').click();
await page.waitForSelector('.code-big', { timeout: 20000 });

check('the room offers a way to connect without the relays', await page.locator('[data-direct]').count() > 0);
await page.locator('[data-direct] summary').click();
await page.locator('[data-invite]').click();
await page.waitForSelector('.direct-box textarea[readonly]', { timeout: 30000 });

const invite = await page.locator('.direct-box textarea[readonly]').inputValue();
check('an invite is offered as a link', invite.startsWith(URL.replace(/\/$/, '') + '/#i=APEX1-'), `${invite.length} characters`);

// The second player follows that link, exactly as sent.
const guest = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const guestErrors = [];
guest.on('pageerror', (e) => guestErrors.push('pageerror: ' + e.message));
guest.on('console', (m) => { if (m.type() === 'error') guestErrors.push(m.text().slice(0, 180)); });
await guest.goto(invite, { waitUntil: 'load', timeout: 60000 });

await guest.waitForSelector('.invited', { timeout: 30000 });
check('the invite link lands on a screen that explains itself', await guest.locator('.invited').count() > 0);
check('the invite carries the room it belongs to', (await guest.locator('#lobby-code').inputValue()) === code2(await page.locator('.code-big').textContent()));

await guest.locator('#lobby-name').fill('Bram');
await guest.locator('[data-join]').click();

// Following the link opens the handshake and fills in the first step, so the
// only thing waiting for the guest is the reply to send back.
await guest.waitForSelector('.direct-box textarea[readonly]', { timeout: 60000 });
const reply = await guest.locator('.direct-box textarea[readonly]').inputValue();
check('the guest gets a reply to send back', reply.startsWith('APEX1-'), `${reply.length} characters`);

const replyBox = page.locator('.direct-step .direct-box').nth(1).locator('textarea');
await replyBox.fill(reply);
await page.locator('.direct-step .direct-box').nth(1).locator('button').click();

const together = await Promise.all([
  page.waitForFunction(() => document.querySelectorAll('.grid-row').length >= 2, null, { timeout: 45000 }).then(() => true).catch(() => false),
  guest.waitForFunction(() => document.querySelectorAll('.grid-row').length >= 2, null, { timeout: 45000 }).then(() => true).catch(() => false),
]);
check('both rooms show two drivers, with no relay reachable at all', together.every(Boolean));

if (together.every(Boolean)) {
  const names = await page.locator('.grid-row .who').allTextContents();
  check('the host sees the guest by name', names.some((n) => n.includes('Bram')), names.join(' / '));
  const theirs = await guest.locator('.grid-row .who').allTextContents();
  check('and the guest sees the host', theirs.some((n) => n.includes('Ada')), theirs.join(' / '));
}

errors.push(...guestErrors);
await guest.close();

function code2(text) {
  return text.trim();
}

// Relay failures are expected here and are warnings, not faults.
const real = errors.filter((e) => !/websocket|relay|announce|ECONNREFUSED|network|Failed to load resource/i.test(e));
check('nothing threw', real.length === 0, real.slice(0, 3).join(' | '));

if (errors.length) console.log(`  (${errors.length} console message(s), ${errors.length - real.length} of them relay noise)`);
await browser.close();
process.exit(bad ? 1 : 0);
