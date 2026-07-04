// Cold-judge END-STATE check: fresh profile → prod → onboarding → load → demo
// GPS → hero turn → assert chips + completed answer + map actually painted.
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(new URL('../video/node_modules/playwright/index.mjs', import.meta.url).href);
const HERE = dirname(fileURLToPath(import.meta.url));
const fails = [];
const check = (n, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) fails.push(n); };

const profile = mkdtempSync(join(tmpdir(), 'helius-judge2-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true, viewport: { width: 1280, height: 800 },
  args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--use-angle=metal'],
});
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('https://helius-9d0.pages.dev', { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(3000);
check('onboarding hero first', await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((e) => /choose|region|pack/i.test(e.textContent || '') && e.offsetHeight > 0);
  return !!el && !document.querySelector('textarea.chat-input:not([disabled])');
}));
// start the load (find the primary start/load button)
await page.waitForFunction(() => !document.querySelector('.onb-load-btn')?.disabled, { timeout: 30000 });
  const startBtn = await page.$('.onb-load-btn');
check('start button present', !!startBtn);
if (startBtn) await startBtn.click();
  await page.waitForTimeout(1000);
console.log('  loading model cold from R2…');
await page.waitForSelector('textarea.chat-input:not([disabled])', { timeout: 300000 });
console.log('  ready.');
// demo GPS on (judge runbook flow)
await page.click('.devloc-toggle').catch(() => {});
await page.waitForTimeout(500);
const sel = await page.$('.devloc-select');
if (sel) await sel.selectOption({ index: 0 }).catch(() => {});
await page.waitForTimeout(1500);
// hero turn
await page.fill('textarea.chat-input', "I'm off the trail and I'm not sure where I am. Get me back to the trailhead before sunset.");
await page.keyboard.press('Enter');
// wait for a COMPLETED assistant answer (thinking gone, text present)
await page.waitForFunction(() => {
  const msgs = [...document.querySelectorAll('.msg-assistant:not(.msg-thinking)')];
  const last = msgs.at(-1);
  return last && (last.textContent || '').trim().length > 40;
}, { timeout: 180000 });
await page.waitForTimeout(2500);
const chips = await page.$$eval('.trace-chip', (els) => els.map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)));
check(`trace chips >=3 (${chips.length})`, chips.length >= 3);
console.log('  chips:', chips.join(' | '));
const answer = await page.$$eval('.msg-assistant:not(.msg-thinking)', (els) => (els.at(-1)?.textContent || '').trim());
console.log('  answer:', answer.slice(0, 300));
check('answer has km AND mi', /km/.test(answer) && /mi/.test(answer));
// map painted? sample canvas pixels
const mapPainted = await page.evaluate(() => {
  const c = document.querySelector('canvas.maplibregl-canvas, .map-pane canvas, canvas');
  if (!c) return false;
  try {
    const g = document.createElement('canvas'); g.width = 60; g.height = 60;
    const cx = g.getContext('2d');
    cx.drawImage(c, c.width / 2 - 30, c.height / 2 - 30, 60, 60, 0, 0, 60, 60);
    const d = cx.getImageData(0, 0, 60, 60).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return lit > 100;
  } catch { return false; }
});
check('map canvas painted (non-black)', mapPainted);
await page.screenshot({ path: join(HERE, 'judge-final.png'), fullPage: false });
check(`zero page errors (${errors.length})`, errors.length === 0);
if (errors.length) console.log('  errors:', errors.slice(0, 5).join(' || ').slice(0, 500));
await ctx.close();
console.log(fails.length ? `\nFAILURES: ${fails.join(', ')}` : '\nALL GREEN');
process.exit(fails.length ? 1 : 0);
