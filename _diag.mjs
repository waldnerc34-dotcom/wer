import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(800);
await page.locator('[data-start]').click();
await page.waitForSelector('#hud:not(.hidden)', { timeout: 240000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const rig = window.APEX.game.playerRig;
  const out = { wheels: [], modelNodes: [], groupChildren: [] };
  rig.wheels.forEach((w, i) => {
    if (!w) { out.wheels.push({ i, missing: true }); return; }
    let meshes = 0, tri = 0, names = [];
    w.hub.traverse(o => { if (o.isMesh) { meshes++; names.push(o.name||'?'); tri += (o.geometry?.index?.count||0)/3; } });
    const box = new (window.THREE_BOX3 || Object)();
    out.wheels.push({ i, hub: w.hub.position.toArray().map(v=>+v.toFixed(3)),
      base: w.base.toArray().map(v=>+v.toFixed(3)), meshes, tri: Math.round(tri),
      names: names.slice(0,4), visible: w.hub.visible, scale: w.mesh.scale.toArray().map(v=>+v.toFixed(3)) });
  });
  rig.modelRoot.traverse(o => { if (o.isMesh) out.modelNodes.push(o.name||'?'); });
  rig.group.children.forEach(c => out.groupChildren.push(`${c.type}:${c.name||'?'}`));
  out.modelPos = rig.modelRoot.position.toArray().map(v=>+v.toFixed(3));
  out.modelScale = rig.modelRoot.scale.toArray().map(v=>+v.toFixed(3));
  return out;
});
for (const w of info.wheels) console.log('WHEEL', JSON.stringify(w));
console.log('modelPos', JSON.stringify(info.modelPos), 'scale', JSON.stringify(info.modelScale));
console.log('remaining meshes:', info.modelNodes.length);
await browser.close();
