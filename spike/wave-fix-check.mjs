// Verifies tonight's adjudication fixes against a running dev server (5173):
//   A. instant flow (?demo=1) on an 'unsupported' device (phone UA) no longer
//      dead-ends on the buttonless boot card — the gate/hero takes over with a
//      working map-only escape.
//   B. no-WebGPU boot offers NO "Try loading anyway" (structurally impossible
//      override) — map-only is the primary path.
//   C. brief modal HTML-escapes LLM output (no <img onerror> execution).
// Headed system Chrome (real WebGPU verdicts). Exit non-zero on any failure.
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const { chromium, devices } = await import(new URL('../video/node_modules/playwright/index.mjs', import.meta.url).href);

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

// ---- A: instant flow on unsupported device (phone UA => preflight veto) ----
{
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=1`);
  // preflight (real agent) needs a moment; hero should un-hide on the veto
  await page.waitForSelector('.onb-hero:not([hidden])', { timeout: 20000 }).catch(() => null);
  const heroVisible = await page.$eval('.onb-hero', (el) => !el.hidden).catch(() => false);
  check('A: instant+unsupported falls back to gate (hero visible)', heroVisible);
  const verdict = await page.$eval('.onb-verdict', (el) => el.dataset.verdict).catch(() => '');
  check(`A: verdict rendered as unsupported (got "${verdict}")`, verdict === 'unsupported');
  const stuck = await page.$eval('.boot-card', (el) => !el.hidden).catch(() => true);
  check('A: boot card no longer the only surface', !stuck);
  // map-only escape actually dismisses the overlay
  await page.click('.onb-maponly-btn');
  await page.waitForTimeout(700);
  const overlayGone = await page.$eval('.boot-overlay', (el) => el.hidden).catch(() => false);
  check('A: map-only escape dismisses overlay', overlayGone);
  await page.screenshot({ path: new URL('./wavefix-a-instant-unsupported.png', import.meta.url).pathname });
  await browser.close();
}

// ---- B: no WebGPU => no "Try loading anyway" ------------------------------
{
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-features=WebGPU', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => document.querySelector('.onb-verdict')?.dataset.verdict !== 'checking', null, { timeout: 20000 }).catch(() => null);
  const verdict = await page.$eval('.onb-verdict', (el) => el.dataset.verdict).catch(() => '');
  if (verdict !== 'unsupported') {
    console.log(`SKIP  B: could not force no-WebGPU on this box (verdict "${verdict}")`);
  } else {
    const loadBtnHidden = await page.$eval('.onb-load-btn', (el) => el.hidden);
    check('B: no-WebGPU hides the impossible override button', loadBtnHidden);
    const mapPrimary = await page.$eval('.onb-maponly-btn', (el) => el.classList.contains('onb-maponly-primary'));
    check('B: map-only styled as the primary path', mapPrimary);
    await page.screenshot({ path: new URL('./wavefix-b-no-webgpu.png', import.meta.url).pathname });
  }
  await browser.close();
}

// ---- C: brief modal escapes injected markup --------------------------------
{
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage();
  await page.goto(`${BASE}/?brief=mock`); // gate flow — hero (and VIEW BRIEFING) visible
  await page.evaluate(() => {
    const brief = {
      packId: 'sandia',
      destination: 'X<img src=x onerror="window.__pwned=1">',
      generatedAt: new Date().toISOString(),
      model: 'mock',
      locale: 'en',
      summary: 'sum<script>window.__pwned=2</script>mary',
      daylight: { sunset: '2026-07-04T20:25:00Z', turnaroundBy: '2026-07-04T18:55:00Z', note: 'note<img src=x onerror="window.__pwned=3">' },
      route: ['r1<b>bold</b>'],
      bailouts: [{ name: 'b<img src=x onerror="window.__pwned=4">', why: 'w' }],
      water: [], gear: ['g<svg onload="window.__pwned=5">'], terrain: [], signal: [],
      phrases: [{ local: 'l<i>x</i>', english: 'e' }],
    };
    localStorage.setItem('helius-brief-sandia', JSON.stringify(brief));
  });
  await page.reload();
  await page.waitForSelector('.onb-brief-view:not([hidden])', { timeout: 15000 });
  await page.click('.onb-brief-view');
  await page.waitForSelector('.brief-modal', { timeout: 5000 });
  await page.waitForTimeout(500);
  const pwned = await page.evaluate(() => window.__pwned ?? null);
  check('C: injected handlers did not execute', pwned === null);
  const injectedEls = await page.$$eval('.brief-modal img, .brief-modal script, .brief-modal svg, .brief-modal b, .brief-modal i', (els) => els.length);
  check('C: injected tags rendered as text, not elements', injectedEls === 0);
  const text = await page.$eval('.brief-modal', (el) => el.textContent);
  check('C: literal markup visible as text', text.includes('<img src=x'));
  await page.screenshot({ path: new URL('./wavefix-c-brief-escape.png', import.meta.url).pathname });
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} FAILURES` : '\nALL CHECKS PASS');
process.exit(failures.length ? 1 : 0);
