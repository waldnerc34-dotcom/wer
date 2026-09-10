#!/usr/bin/env node
/**
 * Two people, one room, the real multiplayer code.
 *
 * The public relays cannot be reached from a machine behind a strict egress
 * policy, and "nobody appears in the room" is the one failure that matters, so
 * this runs a relay on localhost and points both browsers at it. Everything
 * downstream of the introduction — the roster, the two data channels, the
 * outbox that holds a greeting until the channel is ready, the clock sync, the
 * car state, the lights — is the shipping code untouched.
 *
 *   node tools/room-probe.mjs
 */
import { chromium } from 'playwright';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';

const PORT = Number(process.env.RELAY_PORT || 8099);
const URL = process.env.URL || 'http://127.0.0.1:5174/netroom.html';
const CODE = 'PROBE';

const relay = createWsRelayServer({ port: PORT });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

const logs = [];
const open = async (name) => {
  const page = await browser.newPage({ viewport: { width: 420, height: 320 } });
  page.on('pageerror', (e) => logs.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`${name}: ${m.text().slice(0, 160)}`); });
  await page.goto(`${URL}?name=${name}&code=${CODE}&relay=ws://127.0.0.1:${PORT}`, {
    waitUntil: 'load',
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return page;
};

let bad = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};

// One throwaway load first. The dev server discovers and pre-bundles the
// networking dependencies the first time a page asks for them, and then
// reloads every open tab — which in the middle of a test wipes both machines'
// state and leaves the probe waiting on a room that no longer exists.
const warm = await browser.newPage();
await warm.goto(`${URL}?name=Warm&code=WARMUP&relay=ws://127.0.0.1:${PORT}`, { waitUntil: 'load', timeout: 60000 });
await warm.waitForTimeout(4000);
await warm.close();

const a = await open('Ada');
const b = await open('Bram');

// They have to find each other through the relay first.
const found = await Promise.all([
  a.waitForFunction(() => window.__state.roster.length >= 2, null, { timeout: 30000 }).then(() => true).catch(() => false),
  b.waitForFunction(() => window.__state.roster.length >= 2, null, { timeout: 30000 }).then(() => true).catch(() => false),
]);
check('both machines see two drivers in the room', found.every(Boolean));

if (found.every(Boolean)) {
  // The greeting is sent the instant a peer joins, before our own channel has
  // finished opening — the outbox is what makes it arrive at all.
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
  check('each knows what the other is driving', rosterA.every((r) => r.carId) && rosterB.every((r) => r.carId));

  // Car state, over the unreliable channel, through the real encoder.
  await new Promise((r) => setTimeout(r, 5000));
  const seen = await Promise.all([a, b].map((p) => p.evaluate(() => window.__state.peerStates)));
  check('car state is flowing both ways', seen.every((n) => n > 20), `${seen.join(' / ')} snapshots`);

  // Asked fresh rather than read off the last roster event: the round trip is
  // measured continuously and the stored snapshot is from the moment they met.
  const pings = await a.evaluate(() =>
    window.__net.roster().filter((r) => !r.self).map((r) => r.ping),
  );
  check('the clocks have been compared', pings.every((p) => p !== null && p < 400), `${pings.join()} ms`);

  // The lights, off whichever machine turned out to be host.
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
    // Each converted the other's stamp onto its own clock; the two should
    // describe the same instant.
    const skew = Math.abs((hostGo.localNow - hostGo.at) - (guestGo.localNow - guestGo.at));
    check('they start together', skew < 250, `${skew.toFixed(0)} ms apart`);
    check('the countdown is the same length on both', hostGo.hold === guestGo.hold, `${hostGo.hold} / ${guestGo.hold}`);
  }

  // Somebody leaving has to be noticed.
  await b.close();
  const noticed = await a
    .waitForFunction(() => window.__state.roster.length === 1, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check('a driver leaving is noticed', noticed);
}

const real = logs.filter((e) => !/Failed to load resource|favicon/i.test(e));
check('nothing threw', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
relay.close?.();
process.exit(bad ? 1 : 0);
