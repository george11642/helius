// Verifies the onboarding gate + mobile layout + demo instant flow against a
// running dev server (localhost:5173). Headed system Chrome so WebGPU preflight
// returns a real verdict. Screenshots → spike/onb-*.png. Exit non-zero on any
// failed check.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// playwright lives in video/node_modules (the video kit's install)
const { chromium } = await import(new URL('../video/node_modules/playwright/index.mjs', import.meta.url).href);

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--enable-unsafe-webgpu', '--use-fake-ui-for-media-stream', '--window-size=1280,800'],
});

// ---------- 1. Desktop, no params: onboarding gate ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // deny geolocation so devloc shows the honest no-GPS path
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onb-hero:not([hidden])', { timeout: 10000 }).catch(() => {});
  check('gate: hero visible', !!(await page.$('.onb-hero:not([hidden])')));
  check('gate: boot progress card hidden', !(await page.$('.boot-card:not([hidden])')));
  await page.waitForSelector('.onb-pack-card', { timeout: 10000 }).catch(() => {});
  const packCount = (await page.$$('.onb-pack-card')).length;
  check(`gate: pack cards render (${packCount})`, packCount >= 3);
  await page
    .waitForFunction(() => document.querySelector('.onb-verdict')?.dataset.verdict !== 'checking', null, { timeout: 15000 })
    .catch(() => {});
  const verdict = await page.$eval('.onb-verdict', (el) => el.dataset.verdict).catch(() => 'none');
  console.log(`  verdict on this machine: ${verdict}`);
  check('gate: verdict rendered', ['go', 'degraded', 'unsupported'].includes(verdict));
  const loadLabel = await page.$eval('.onb-load-btn', (el) => el.textContent.trim());
  console.log(`  load button: "${loadLabel}"`);
  await page.screenshot({ path: join(HERE, 'onb-desktop-gate.png') });

  // pack pick before any model bytes: select chamonix
  await page.click('.onb-pack-card[data-pack="chamonix"]');
  await page.waitForTimeout(1500);
  const selected = await page.$eval('.onb-pack-card[data-pack="chamonix"]', (el) => el.dataset.selected);
  check('gate: pack selectable pre-model', selected === 'true');

  // map-only path
  await page.click('.onb-maponly-btn');
  await page.waitForSelector('.boot-overlay', { state: 'hidden', timeout: 5000 }).catch(() => {});
  check('map-only: overlay dismissed', !(await page.$('.boot-overlay:not([hidden])')));
  await page.waitForSelector('.chip-load-model:not([hidden])', { timeout: 8000 }).catch(() => {});
  check('map-only: LOAD AI chip visible', !!(await page.$('.chip-load-model:not([hidden])')));
  const chatDisabled = await page.$eval('textarea.chat-input', (el) => el.disabled);
  check('map-only: chat stays disabled', chatDisabled === true);
  // map canvas initialized for the chosen pack
  await page.waitForSelector('#map-root canvas', { timeout: 20000 }).catch(() => {});
  check('map-only: map canvas mounted', !!(await page.$('#map-root canvas')));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(HERE, 'onb-desktop-maponly.png') });
  await page.close();
}

// ---------- 2. Phone viewport, mock demo: instant flow + bottom sheet ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${BASE}/?mock=1&demo=1`, { waitUntil: 'domcontentloaded' });
  check('demo: gate skipped (no hero)', !(await page.$('.onb-hero:not([hidden])')));
  await page.waitForSelector('textarea.chat-input:not([disabled])', { timeout: 20000 });
  check('demo: chat enabled after mock ready', true);
  // mock fires a scripted turn on boot: trace chips + route toast
  await page
    .waitForFunction(() => document.querySelectorAll('.tool-trace-rail .trace-chip').length >= 3, null, { timeout: 15000 })
    .catch(() => {});
  const chips = (await page.$$('.tool-trace-rail .trace-chip')).length;
  check(`demo: trace chips (${chips})`, chips >= 3);
  await page.waitForSelector('.route-toast:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('demo: route toast', !!(await page.$('.route-toast:not([hidden])')));
  const toastText = await page.$eval('.route-toast', (el) => el.textContent).catch(() => '');
  console.log(`  route toast: "${toastText}"`);
  await page.waitForSelector('.pos-chip:not([hidden])', { timeout: 5000 }).catch(() => {});
  const posText = await page.$eval('.pos-chip', (el) => el.textContent).catch(() => '(none)');
  console.log(`  pos chip: "${posText}"`);
  check('demo: position chip rendered', !!(await page.$('.pos-chip:not([hidden])')));
  // demo GPS chip flagged
  const demoFlag = await page.$eval('.devloc-panel', (el) => el.dataset.demo);
  check('demo: devloc panel flagged demo', demoFlag === 'true');
  // bottom sheet geometry: chat-col below map-col
  const mapBox = await (await page.$('.map-col')).boundingBox();
  const chatBox = await (await page.$('.chat-col')).boundingBox();
  check('mobile: map above chat sheet', mapBox.y < chatBox.y && mapBox.height > 200);
  await page.screenshot({ path: join(HERE, 'onb-phone-demo.png') });
  // open the demo GPS panel for a styled screenshot
  await page.click('.devloc-toggle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(HERE, 'onb-phone-devloc.png') });
  await page.close();
}

// ---------- 3. Phone viewport, gate (unsupported/mobile verdict honesty) ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onb-hero:not([hidden])', { timeout: 10000 }).catch(() => {});
  await page
    .waitForFunction(() => document.querySelector('.onb-verdict')?.dataset.verdict !== 'checking', null, { timeout: 15000 })
    .catch(() => {});
  const verdict = await page.$eval('.onb-verdict', (el) => el.dataset.verdict).catch(() => 'none');
  console.log(`  phone-viewport verdict: ${verdict} (desktop UA — real phones hit 'unsupported' via UA/deviceMemory)`);
  check('gate(phone): renders without horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: join(HERE, 'onb-phone-gate.png') });
  await page.close();
}

// ---------- 4. Brief mock mode: onboarding briefing row + viewer ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${BASE}/?brief=mock`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onb-brief-row:not([hidden])', { timeout: 10000 }).catch(() => {});
  check('brief: prepare row visible in mock mode', !!(await page.$('.onb-brief-row:not([hidden])')));
  await page.click('.onb-brief-btn').catch(() => {});
  await page.waitForSelector('.onb-brief-view:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('brief: view button appears after prepare', !!(await page.$('.onb-brief-view:not([hidden])')));
  await page.click('.onb-brief-view').catch(() => {});
  await page.waitForSelector('.brief-modal-card', { timeout: 5000 }).catch(() => {});
  check('brief: modal opens', !!(await page.$('.brief-modal-card')));
  await page.screenshot({ path: join(HERE, 'onb-brief-modal.png') });
  await page.close();
}

await browser.close();
console.log(failures.length ? `\nFAILURES: ${failures.join(' | ')}` : '\nALL CHECKS PASS');
process.exit(failures.length ? 1 : 0);
