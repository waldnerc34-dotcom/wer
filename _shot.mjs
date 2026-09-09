import { chromium } from 'playwright';
const P = process.argv[2] || '/tmp';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(240000);
const logs = [];
page.on('console', m => { if (m.type()==='error') logs.push(`[error] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => logs.push(`[fail] ${r.url().slice(-70)}`));

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${P}/01-menu.png` });
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
  return { scenery: g.scenery.instanceCount, byKind: c };
});
console.log('scenery:', JSON.stringify(st));
console.log('--- issues ---'); console.log([...new Set(logs)].slice(0,15).join('\n') || '(none)');
await browser.close();
