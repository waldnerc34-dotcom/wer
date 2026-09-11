#!/usr/bin/env node
/**
 * Two people racing with no matchmaking network in existence.
 *
 * This is the failure the direct handshake exists for, reproduced honestly:
 * both browsers are given no transports at all, so there is nothing for them
 * to be introduced over and no relay anywhere in the test. The only thing
 * that passes between them is the block of text a player would send in a
 * message, carried here by the probe because that is exactly what a person
 * does with it.
 *
 * Everything after that is the shipping code: the same two data channels, the
 * same roster, the same clock comparison, the same lights.
 *
 *   node tools/direct-probe.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:5174/netroom.html';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Two tabs of one browser talk over plain loopback addresses rather than
    // the .local names Chrome normally hides them behind.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});

const logs = [];
const open = async (name) => {
  const page = await browser.newPage({ viewport: { width: 420, height: 320 } });
  page.on('pageerror', (e) => logs.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(`${name}: ${m.text().slice(0, 160)}`);
  });
  await page.goto(`${URL}?solo=1&name=${name}&code=DIRECT`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return page;
};

let bad = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};

// The dev server pre-bundles dependencies on first sight and reloads every
// open tab when it does, which mid-test would wipe both machines.
const warm = await browser.newPage();
await warm.goto(`${URL}?solo=1&name=Warm&code=WARMUP`, { waitUntil: 'load', timeout: 60000 });
await warm.waitForTimeout(4000);
await warm.close();

const a = await open('Ada');
const b = await open('Bram');

const alone = await Promise.all([a, b].map((p) => p.evaluate(() => window.__net.roster().length)));
check('neither can see anybody to begin with', alone.every((n) => n === 1), `${alone.join(' / ')} in room`);

// 1. Ada makes an invite. 2. Bram pastes it and gets a reply. 3. Ada pastes
//    the reply. That is the whole of it.
const invite = await a.evaluate(async () => {
  window.__link = await window.__net.invite();
  return window.__link.code;
});
check('an invite was made with no relay involved', typeof invite === 'string' && invite.startsWith('APEX1-'), `${invite?.length} characters`);

const reply = await b.evaluate((code) => window.__net.acceptInvite(code), invite);
check('the other side produced a reply', typeof reply === 'string' && reply.startsWith('APEX1-'), `${reply?.length} characters`);

await a.evaluate((text) => window.__link.accept(text), reply);

const met = await Promise.all([
  a.waitForFunction(() => window.__state.roster.length >= 2, null, { timeout: 30000 }).then(() => true).catch(() => false),
  b.waitForFunction(() => window.__state.roster.length >= 2, null, { timeout: 30000 }).then(() => true).catch(() => false),
]);
check('both machines now see two drivers', met.every(Boolean));

if (met.every(Boolean)) {
  const named = await Promise.all([
    a.waitForFunction(() => window.__state.roster.some((r) => r.name === 'Bram'), null, { timeout: 15000 }).then(() => true).catch(() => false),
    b.waitForFunction(() => window.__state.roster.some((r) => r.name === 'Ada'), null, { timeout: 15000 }).then(() => true).catch(() => false),
  ]);
  check('each knows the other by name', named.every(Boolean));

  const rosterA = await a.evaluate(() => window.__state.roster);
  const rosterB = await b.evaluate(() => window.__state.roster);
  check(
    'both agree on the grid order',
    rosterA.map((r) => r.name).join() === rosterB.map((r) => r.name).join(),
    `${rosterA.map((r) => r.name).join()} / ${rosterB.map((r) => r.name).join()}`,
  );
  check(
    'exactly one of them is host',
    rosterA.filter((r) => r.host).length === 1 &&
      rosterA.find((r) => r.host)?.name === rosterB.find((r) => r.host)?.name,
    `${rosterA.find((r) => r.host)?.name}`,
  );

  await new Promise((r) => setTimeout(r, 5000));
  const seen = await Promise.all([a, b].map((p) => p.evaluate(() => window.__state.peerStates)));
  check('car state is flowing both ways', seen.every((n) => n > 20), `${seen.join(' / ')} snapshots`);

  const pings = await a.evaluate(() => window.__net.roster().filter((r) => !r.self).map((r) => r.ping));
  check('the clocks have been compared', pings.every((p) => p !== null && p < 400), `${pings.join()} ms`);

  const hostPage = (await a.evaluate(() => window.__net.isHost)) ? a : b;
  const guestPage = hostPage === a ? b : a;
  await hostPage.evaluate(() => window.__net.start(0.6));
  const dropped = await Promise.all([
    hostPage.waitForFunction(() => window.__state.go, null, { timeout: 10000 }).then(() => true).catch(() => false),
    guestPage.waitForFunction(() => window.__state.go, null, { timeout: 10000 }).then(() => true).catch(() => false),
  ]);
  check('the lights go out on both machines', dropped.every(Boolean));
  if (dropped.every(Boolean)) {
    const [hostGo, guestGo] = await Promise.all([
      hostPage.evaluate(() => window.__state.go),
      guestPage.evaluate(() => window.__state.go),
    ]);
    const skew = Math.abs(hostGo.localNow - hostGo.at - (guestGo.localNow - guestGo.at));
    check('they start together', skew < 250, `${skew.toFixed(0)} ms apart`);
  }

  await b.close();
  const noticed = await a
    .waitForFunction(() => window.__state.roster.length === 1, null, { timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  check('a driver leaving is noticed', noticed);
}

const real = logs.filter((e) => !/Failed to load resource|favicon/i.test(e));
check('nothing threw', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
process.exit(bad ? 1 : 0);
