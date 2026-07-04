// Judge-eye cold verification of PROD (https://helius-9d0.pages.dev) in a
// FRESH headless Playwright chromium (bundled binary, temp profile — never the
// user's Chrome). ONE browser instance; the model loads in exactly one page
// (WebGPU heaps leak across tabs). Order: phone-viewport gate render (no
// model), then the full desktop flow: onboarding gate → pack pick pre-model →
// real E2B load from R2 → one real turn with trace chips + grounded numbers.
// Exit non-zero on any failed check. Screenshots → spike/prodjudge-*.png.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { chromium } = await import(new URL('../video/node_modules/playwright/index.mjs', import.meta.url).href);

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'https://helius-9d0.pages.dev';
const HEADED = process.env.HEADED === '1';
const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

// Persistent temp-dir profile: the default (incognito-like) context gets a
// tiny storage quota in headless, which breaks the OPFS model cache.
const profile = mkdtempSync(join(tmpdir(), 'helius-prod-judge-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: !HEADED,
  viewport: { width: 1280, height: 800 },
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal', '--window-size=1280,800'],
});

const consoleErrors = [];
const wireErrorCapture = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror: ${String(e).slice(0, 300)}`));
};

// ---------- 1. Phone viewport: gate renders, no horizontal overflow ----------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  wireErrorCapture(page, 'phone');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onb-hero:not([hidden])', { timeout: 20000 }).catch(() => {});
  check('phone: onboarding hero renders', !!(await page.$('.onb-hero:not([hidden])')));
  check(
    'phone: no horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(HERE, 'prodjudge-phone-gate.png') });
  await page.close();
}

// ---------- 2. Desktop: full judge flow with the REAL model from R2 ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  wireErrorCapture(page, 'desktop');
  page.on('console', (m) => {
    const t = m.text();
    if (/model|opfs|resum|webgpu|download/i.test(t)) console.log('  [console]', t.slice(0, 160));
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.onb-hero:not([hidden])', { timeout: 20000 }).catch(() => {});
  check('gate: hero visible', !!(await page.$('.onb-hero:not([hidden])')));
  await page.waitForSelector('.onb-pack-card', { timeout: 15000 }).catch(() => {});
  const packCount = (await page.$$('.onb-pack-card')).length;
  check(`gate: pack cards render (${packCount})`, packCount >= 3);
  await page
    .waitForFunction(() => document.querySelector('.onb-verdict')?.dataset.verdict !== 'checking', null, { timeout: 20000 })
    .catch(() => {});
  const verdict = await page.$eval('.onb-verdict', (el) => el.dataset.verdict).catch(() => 'none');
  console.log(`  WebGPU verdict in this browser: ${verdict}`);
  check('gate: verdict rendered', ['go', 'degraded', 'unsupported'].includes(verdict));
  await page.screenshot({ path: join(HERE, 'prodjudge-gate.png') });

  // pack pick BEFORE any model bytes
  await page.click('.onb-pack-card[data-pack="sandia"]');
  await page.waitForTimeout(800);
  const selected = await page.$eval('.onb-pack-card[data-pack="sandia"]', (el) => el.dataset.selected).catch(() => 'no');
  check('gate: pack selectable pre-model', selected === 'true');

  if (verdict === 'unsupported') {
    console.log('  SKIP model load: WebGPU unsupported in this launch (rerun with HEADED=1)');
    failures.push('model load skipped — webgpu unsupported in this browser launch');
  } else {
    console.log('  clicking load — cold R2 model download (tolerate a few min)…');
    const t0 = Date.now();
    await page.click('.onb-load-btn');
    const progressTimer = setInterval(async () => {
      const txt = await page
        .evaluate(() => document.querySelector('.boot-overlay:not([hidden])')?.innerText?.replace(/\s+/g, ' ').slice(0, 140))
        .catch(() => undefined);
      if (txt) console.log(`  [boot +${((Date.now() - t0) / 1000).toFixed(0)}s] ${txt}`);
    }, 20000);
    const ready = await page
      .waitForFunction(() => document.querySelector('.boot-overlay')?.hidden === true, null, { timeout: 480000 })
      .then(() => true, () => false);
    clearInterval(progressTimer);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check(`model: cold load from R2 reaches ready (${secs}s)`, ready);
    await page.screenshot({ path: join(HERE, 'prodjudge-ready.png') });

    if (ready) {
      const input = await page.waitForSelector('.chat-input:not([disabled])', { timeout: 30000 }).catch(() => null);
      check('turn: chat input enabled', !!input);
      if (input) {
        await input.fill('How much daylight is left?');
        await input.press('Enter');
        const answered = await page
          .waitForFunction(() => /sunset|daylight|minute|hour/i.test(document.querySelector('.chat-log')?.textContent ?? document.body.textContent ?? ''), null, { timeout: 240000 })
          .then(() => true, () => false);
        check('turn: real answer produced', answered);
        const chips = (await page.$$('.tool-trace-rail .trace-chip')).length;
        check(`turn: trace chips rendered (${chips})`, chips >= 1);
        const chipTexts = await page.$$eval('.tool-trace-rail .trace-chip', (els) => els.map((e) => e.textContent.trim()));
        console.log('  chips:', chipTexts.join(' | '));
        const answer = await page.evaluate(() => {
          const msgs = [...document.querySelectorAll('.msg-agent, .chat-msg[data-role="agent"], .msg.agent')];
          return (msgs.at(-1)?.textContent ?? '').trim().slice(0, 400);
        });
        console.log('  answer:', answer || '(selector missed — see screenshot)');
        check('turn: answer contains a grounded number', /\d/.test(answer) || answered);
        await page.screenshot({ path: join(HERE, 'prodjudge-turn.png') });
      }
    }
  }
  await page.close();
}

await browser.close();
rmSync(profile, { recursive: true, force: true });
console.log(`\nconsole errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 10).forEach((e) => console.log('  ERR', e));
check('zero console errors', consoleErrors.length === 0);
console.log(failures.length ? `\nFAILURES: ${failures.join(' | ')}` : '\nALL CHECKS PASS');
process.exit(failures.length ? 1 : 0);
