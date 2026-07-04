// Airplane-mode proof: runs while macOS Wi-Fi is OFF (driven by wifi-proof.sh).
// Uses the same persistent take-profile as scenes.mjs (model already cached
// there for the :4174 origin). Asserts the FULL offline story:
//   1. navigator.onLine is false (we are genuinely offline)
//   2. a COLD page load works (app shell from SW precache, weights from
//      Cache API — the R2 URLs must never hit the network)
//   3. a real agent turn completes with a tool chip (sun_clock)
// Writes a JSON verdict to stdout. Non-zero exit on any failed assert.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = 'http://localhost:4174/';
const verdict = { onLineFalse: false, coldLoadReadyMs: null, turnCompleted: false, chip: null, answer: null, errors: [] };

const ctx = await chromium.launchPersistentContext(join(HERE, '.chrome-profile'), {
  channel: 'chrome',
  headless: false,
  viewport: null,
  args: ['--window-position=0,0', '--window-size=960,540', '--force-device-scale-factor=2', '--no-first-run'],
});
const page = await ctx.newPage();
const traceLines = [];
page.on('console', (m) => { const t = m.text(); if (t.startsWith('TRACE:')) traceLines.push(t.slice(6)); });

try {
  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30000 });
  verdict.onLineFalse = await page.evaluate(() => !navigator.onLine);

  // wait for engine ready (footer text) — generous: cached load is ~5-15s
  await page.waitForFunction(() => /ready/.test(document.body.innerText), null, { timeout: 180000 });
  verdict.coldLoadReadyMs = Date.now() - t0;

  // run a real turn
  await page.waitForSelector('textarea.chat-input:not([disabled])', { timeout: 60000 });
  await page.fill('textarea.chat-input', 'How much daylight do I have left?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => [...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && /sun_clock\(\)/.test(e.textContent)),
    null, { timeout: 120000 },
  );
  verdict.chip = 'sun_clock';
  // wait for the assistant bubble (turn done ⇒ input re-enabled)
  await page.waitForFunction(() => {
    const el = document.querySelector('textarea.chat-input');
    return !!el && !el.disabled && (document.body.innerText.includes('sunset') || /minutes/.test(document.body.innerText));
  }, null, { timeout: 180000 });
  verdict.turnCompleted = true;
  verdict.answer = (await page.evaluate(() => document.body.innerText.split('\n').filter(l => /minute|sunset|light/i.test(l)).slice(-2).join(' | '))).slice(0, 200);
  await page.screenshot({ path: join(HERE, 'takes', 'wifi-proof.png'), fullPage: false });
} catch (e) {
  verdict.errors.push(String(e).slice(0, 300));
}
await ctx.close();
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.turnCompleted && verdict.onLineFalse ? 0 : 1);
