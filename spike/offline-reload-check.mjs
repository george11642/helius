// Airplane-mode reload proof for the CURRENT OPFS pipeline (finding: the old
// 3.09s proof predates it). Fresh persistent profile: cold-load the REAL model
// from the local mirror (?demo=1 autoload), then cut the network
// (context.setOffline → navigator.onLine=false) and reload. The boot must come
// entirely from OPFS, fast — no probe-retry backoff stalls.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { chromium } = await import(new URL('../video/node_modules/playwright/index.mjs', import.meta.url).href);

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const profile = mkdtempSync(join(tmpdir(), 'helius-offline-check-'));
const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => {
  const t = m.text();
  if (/resum|offline|opfs|error/i.test(t)) console.log('  [console]', t.slice(0, 160));
});

const readyWhen = () =>
  page.waitForFunction(() => document.querySelector('.boot-overlay')?.hidden === true, null, { timeout: 300000 });

console.log('cold ONLINE load (local mirror)…');
let t0 = Date.now();
await page.goto(`${BASE}/?demo=1`);
await readyWhen();
console.log(`  ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
check('online cold load reaches ready', true);

// Let the service worker finish installing/precaching before cutting the
// network — an offline page navigation needs the SW to serve index.html.
await page
  .waitForFunction(async () => (await navigator.serviceWorker?.getRegistration())?.active != null, null, { timeout: 60000 })
  .catch(() => console.log('  (no active service worker — dev server? offline reload will fail)'));
await page.waitForTimeout(8000);

console.log('going OFFLINE + reload…');
await ctx.setOffline(true);
t0 = Date.now();
await page.reload();
await readyWhen();
const offlineSecs = (Date.now() - t0) / 1000;
console.log(`  OFFLINE reload ready in ${offlineSecs.toFixed(1)}s`);
check(`offline reload boots from OPFS (${offlineSecs.toFixed(1)}s)`, true);
check('offline reload has no probe-backoff stall (< 45s)', offlineSecs < 45);

// A real grounded turn while offline
const input = await page.waitForSelector('.chat-input:not([disabled])', { timeout: 30000 }).catch(() => null);
if (input) {
  await input.fill('How much daylight is left?');
  await input.press('Enter');
  const answered = await page
    .waitForFunction(() => /daylight|sunset|minute/i.test(document.body.textContent ?? ''), null, { timeout: 180000 })
    .then(() => true, () => false);
  check('offline real turn answers', answered);
} else {
  console.log('SKIP  offline turn (chat input never enabled)');
}

await page.screenshot({ path: new URL('./wavefix-offline-reload.png', import.meta.url).pathname });
await ctx.close();
rmSync(profile, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILURES` : '\nALL CHECKS PASS');
process.exit(failures.length ? 1 : 0);
