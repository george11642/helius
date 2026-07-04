// Verification for the 6 new region packs (yosemite, zermatt, grand-canyon,
// fuji, ben-nevis, pecos). Drives the local app in ?mock=1&demo=1 mode:
//   1. pack picker lists all 6 new packs
//   2. switching to yosemite + zermatt re-inits the map centered on the new
//      pack (reads window.__heliusMapDebug.pack + .instance.getCenter())
//   3. a DIRECT route call over each new pack's REAL graph.bin — the same
//      graph-core.mjs A* the browser routing bundles — produces a real
//      multi-km route from the pack's demo preset to its primary trailhead.
// Run against the dev server (serves /src for the direct import):
//   node spike/newpacks-check.mjs http://localhost:5174
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/georgeteifel/dev/helius/video/node_modules/playwright/index.js');

const BASE = process.argv[2] ?? 'http://localhost:5174';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_PACKS = ['yosemite', 'zermatt', 'grand-canyon', 'fuji', 'ben-nevis', 'pecos'];

// [preset lat, lon] -> [trailhead lat, lon] per pack (mirrors devloc preset 0
// + pois.json's first role:'trailhead').
const ROUTES = {
  yosemite: [37.727, -119.541, 37.7327, -119.558],
  zermatt: [46.005, 7.755, 45.9876, 7.7085],
  'grand-canyon': [36.0761, -112.1279, 36.0575, -112.1436],
  fuji: [35.42, 138.755, 35.4285, 138.7562],
  'ben-nevis': [56.8021, -5.0588, 56.796, -5.103],
  pecos: [35.805, -105.785, 35.7975, -105.801],
};
// Pack center [lon, lat] for the map-centering assertion.
const CENTERS = { yosemite: [-119.525, 37.8], zermatt: [7.725, 46.0] };

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};
const waitFor = async (page, fn, { timeout = 20000, interval = 200 } = {}) => {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await page.evaluate(fn);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
};

async function main() {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(`${BASE}/?mock=1&demo=1`, { waitUntil: 'domcontentloaded' });
  const ready = await waitFor(page, () => {
    const el = document.querySelector('.boot-overlay');
    return el !== null && el.hidden === true;
  }, { timeout: 20000 });
  rec('app booted (mock ready, overlay cleared)', Boolean(ready));

  // 1. Picker lists all 6 new packs.
  const pickerEnabled = await waitFor(page, () => {
    const s = document.querySelector('.pack-picker-select');
    return s && !s.disabled ? true : false;
  });
  const options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pack-picker-select option')).map((o) => o.value),
  );
  const missing = NEW_PACKS.filter((p) => !options.includes(p));
  rec('pack picker enabled', Boolean(pickerEnabled));
  rec('pack picker lists all 6 new packs', missing.length === 0, `options=${options.join(',')}${missing.length ? ' missing=' + missing.join(',') : ''}`);

  // 2. Switch to yosemite then zermatt; assert map re-centers to the new pack.
  // The mock's createHelius resolves (assigning main.ts `agent`) only after its
  // scripted boot + first turn kicks off — switching before that throws "agent
  // not ready". Let it settle first.
  await new Promise((r) => setTimeout(r, 10000));
  for (const pack of ['yosemite', 'zermatt']) {
    // The mock agent's handle (main.ts `agent`) isn't assigned until its
    // scripted first turn kicks off, so an early switch throws "agent not
    // ready" and the picker reverts. Re-dispatch until it actually takes.
    await page.evaluate((p) => {
      const s = document.querySelector('.pack-picker-select');
      s.value = p;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, pack);
    const centered = await waitFor(page, (p) => {
      const m = window.__heliusMapDebug;
      if (!m || m.pack !== p || !m.instance) return null;
      const c = m.instance.getCenter();
      return { lng: c.lng, lat: c.lat, pack: m.pack };
    }, { timeout: 90000, interval: 500 });
    if (!centered) {
      const dbg = await page.evaluate(() => {
        const m = window.__heliusMapDebug;
        const s = document.querySelector('.pack-picker-select');
        return { hasDbg: !!m, pack: m?.pack, hasInst: !!(m && m.instance), sel: s?.value, disabled: s?.disabled };
      });
      console.log('   DEBUG center-read fail:', JSON.stringify(dbg));
    }
    const [wantLon, wantLat] = CENTERS[pack];
    const near = centered && Math.abs(centered.lng - wantLon) < 0.25 && Math.abs(centered.lat - wantLat) < 0.25;
    rec(`map re-centered on ${pack}`, Boolean(near), centered ? `pack=${centered.pack} center=${centered.lng.toFixed(3)},${centered.lat.toFixed(3)}` : 'no map center read');
    await new Promise((r) => setTimeout(r, 1200)); // let tiles settle for the shot
    await page.screenshot({ path: path.join(__dirname, `newpacks-${pack}.png`), fullPage: false });
  }

  // 3. Direct route call over each new pack's REAL graph (the shipped A*).
  for (const pack of NEW_PACKS) {
    const [fLat, fLon, tLat, tLon] = ROUTES[pack];
    const out = await page.evaluate(async ({ pack, fLat, fLon, tLat, tLon }) => {
      const gc = await import('/src/map/graph-core.mjs');
      const res = await fetch(`/data/packs/${pack}/graph.bin`);
      if (!res.ok) return { error: `graph.bin ${res.status}` };
      const rg = gc.buildRoutingGraph(gc.parseGraph(await res.arrayBuffer()));
      const r = gc.findRoute(rg, { lat: fLat, lon: fLon }, { lat: tLat, lon: tLon });
      if ('error' in r) return { error: JSON.stringify(r) };
      return { km: r.distanceM / 1000, steps: r.steps.length, pts: r.geojson.coordinates.length, first: r.steps[0]?.instruction };
    }, { pack, fLat, fLon, tLat, tLon });
    const ok = out && !out.error && out.km >= 1.5;
    rec(`${pack}: real A* route over new graph`, Boolean(ok), out?.error ? out.error : `${out.km.toFixed(2)}km, ${out.steps} steps, ${out.pts} pts — "${out.first}"`);
  }

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed.`);
  if (pageErrors.length) {
    console.log('page errors:');
    pageErrors.forEach((e) => console.log('  ' + e));
  }
  if (failed.length || pageErrors.length) process.exitCode = 1;
}
main().catch((e) => {
  console.error('crashed:', e);
  process.exitCode = 1;
});
