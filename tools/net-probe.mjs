#!/usr/bin/env node
/**
 * Two browser tabs, one real WebRTC connection, and a car driven down it.
 *
 * The relays that introduce peers are not reachable from every network and
 * are not what decides whether a race feels smooth. This connects two pages
 * directly — the handshake is carried here instead of by a relay — over a
 * channel configured exactly as the game's is, and measures what arrives.
 *
 *   node tools/net-probe.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://127.0.0.1:5174/netlab.html';
const SECONDS = Number(process.env.SECONDS || 12);
const HZ = 20;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});

const logs = [];
const open = async (label) => {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => logs.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`${label}: ${m.text().slice(0, 160)}`); });
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return page;
};

const a = await open('A');
const b = await open('B');

// Trickle the candidates across as each side finds them.
await a.exposeFunction('onLocalCandidate', (json) => b.evaluate((c) => window.__candidate(c), json).catch(() => {}));
await b.exposeFunction('onLocalCandidate', (json) => a.evaluate((c) => window.__candidate(c), json).catch(() => {}));

const offer = await a.evaluate(() => window.__offer());
const answer = await b.evaluate((o) => window.__answer(o), offer);
await a.evaluate((ans) => window.__accept(ans), answer);

const opened = await Promise.all([
  a.waitForFunction(() => window.__stats.open, null, { timeout: 30000 }).then(() => true).catch(() => false),
  b.waitForFunction(() => window.__stats.open, null, { timeout: 30000 }).then(() => true).catch(() => false),
]);
console.log(`channel open on both ends: ${opened.every(Boolean)}`);
if (!opened.every(Boolean)) {
  if (logs.length) console.log(logs.join('\n'));
  await browser.close();
  process.exit(1);
}

// Both ends measure the clock difference; A drives and B watches.
await Promise.all([
  a.evaluate(() => { window.__t = setInterval(() => window.__ping(), 300); }),
  b.evaluate(() => { window.__t = setInterval(() => window.__ping(), 300); }),
]);
await new Promise((r) => setTimeout(r, 1500));

await a.evaluate((hz) => {
  window.__s = setInterval(() => window.__sendState(), 1000 / hz);
}, HZ);
await b.evaluate(() => {
  const tick = () => { window.__draw(); window.__raf = requestAnimationFrame(tick); };
  window.__raf = requestAnimationFrame(tick);
});

await new Promise((r) => setTimeout(r, SECONDS * 1000));

const sent = await a.evaluate(() => window.__stats.sent);
const seen = await b.evaluate(() => ({
  ...window.__stats,
  offset: window.__sync.offset,
  rtt: window.__sync.rtt,
  delay: window.__interp.delay,
}));

const loss = sent ? (1 - seen.received / sent) * 100 : 100;
console.log(`  sent ${sent} · received ${seen.received} (${loss.toFixed(1)}% lost)`);
console.log(`  round trip ${seen.rtt.toFixed(1)} ms · clock offset ${seen.offset.toFixed(1)} ms · playout delay ${seen.delay.toFixed(0)} ms`);
console.log(`  drawn ${seen.drawn} frames · ${seen.backwards} backwards · ${seen.jumps} jumps · worst step ${seen.worstStep.toFixed(2)} m`);

let bad = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};
check('the unreliable channel carried the car', seen.received > sent * 0.9, `${seen.received} of ${sent}`);
check('the clocks agree', Number.isFinite(seen.offset) && seen.rtt < 200, `${seen.rtt.toFixed(1)} ms round trip`);
check('the car never went backwards', seen.backwards === 0, `${seen.backwards} frame(s)`);
check('the car never jumped', seen.jumps === 0, `${seen.jumps} frame(s)`);
check('it was drawn every frame', seen.drawn > SECONDS * 40, `${seen.drawn} frames`);

if (logs.length) console.log('console:\n  ' + logs.slice(0, 8).join('\n  '));
await browser.close();
process.exit(bad ? 1 : 0);
