// UI self-check for the ?mock=1 scripted demo sequence (see
// src/app/mock-agent.ts). Opens the dev server, waits for the deterministic
// mock event sequence to play out, and asserts the key visual beats actually
// rendered. Uses the machine's global Playwright install (this project has
// no local Playwright dependency) via createRequire + an absolute path,
// since NODE_PATH isn't honored by ESM `import` resolution.
//
// Usage: node spike/ui-selfcheck.mjs [devServerUrl]
// Defaults to http://localhost:5174 (see `pnpm dev` output for the actual port).

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/georgeteifel/.local/node/lib/node_modules/playwright/index.js');

const BASE_URL = process.argv[2] ?? 'http://localhost:5174';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = path.join(__dirname, 'ui-selfcheck.png');

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

async function waitFor(page, fn, { timeout = 15000, interval = 150 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await page.evaluate(fn);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}

// Mandatory check (per team-lead, after the pnpm override deduping
// @huggingface/transformers to a single 4.2.0 copy): kokoro-js 1.2.1 was
// written against the transformers.js 3.x API. Verify it still loads and
// produces real (non-silent) audio under 4.2.0 — independent of the browser/
// WebGPU pipeline, via kokoro-js's Node-native device:'cpu' path, so this
// isolates the JS-API compatibility question from browser/GPU availability.
async function checkKokoroAudio() {
  try {
    const { KokoroTTS } = await import('kokoro-js');
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'cpu',
    });
    const audio = await tts.generate('Testing one two three.', { voice: 'af_heart' });
    const data = audio.data;
    const mid = data.slice(Math.floor(data.length * 0.25), Math.floor(data.length * 0.75));
    let sumSq = 0;
    for (let i = 0; i < mid.length; i++) sumSq += mid[i] * mid[i];
    const rms = Math.sqrt(sumSq / mid.length);
    record('kokoro-js produces non-silent audio under transformers.js 4.2.0', rms > 0.01, `rms=${rms.toFixed(4)}, samples=${data.length}, sr=${audio.sampling_rate}`);
  } catch (err) {
    record('kokoro-js produces non-silent audio under transformers.js 4.2.0', false, `threw: ${err && err.message ? err.message : err}`);
  }
}

async function main() {
  await checkKokoroAudio();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(`${BASE_URL}/?mock=1`, { waitUntil: 'domcontentloaded' });

  // 1. Boot overlay appears.
  const bootAppeared = await waitFor(page, () => document.querySelector('.boot-overlay') !== null, { timeout: 5000 });
  record('boot overlay appeared', Boolean(bootAppeared));

  // 2. Boot overlay clears (hidden) once the mock reaches 'ready' + fade-out.
  const bootCleared = await waitFor(page, () => {
    const el = document.querySelector('.boot-overlay');
    return el !== null && el.hidden === true;
  });
  record('boot overlay cleared after ready', Boolean(bootCleared));

  // 3. >= 3 tool-trace chips from the scripted locate/sun_clock/route_back chain.
  const chipCount = await waitFor(page, () => document.querySelectorAll('.trace-chip').length >= 3, { timeout: 15000 });
  const finalChipCount = await page.evaluate(() => document.querySelectorAll('.trace-chip').length);
  record('>=3 trace chips present', Boolean(chipCount), `count=${finalChipCount}`);

  // 4. Chat has both a user and an assistant bubble.
  const hasUserMsg = await waitFor(page, () => document.querySelector('.msg-user') !== null, { timeout: 15000 });
  record('chat has a user bubble', Boolean(hasUserMsg));
  const hasAssistantMsg = await waitFor(page, () => {
    const el = document.querySelector('.msg-assistant .msg-bubble');
    return el !== null && el.textContent.trim().length > 0;
  }, { timeout: 15000 });
  record('chat has an assistant bubble', Boolean(hasAssistantMsg));

  // 5. Offline-readiness chip exists (presence only — its color/state depends
  // on real service-worker controller timing, which a first dev-server load
  // legitimately may not reach; see main.ts/status.ts for the honest logic).
  const offlineChipExists = await page.evaluate(() => document.querySelector('.chip-offline') !== null);
  record('OFFLINE-READY chip exists', Boolean(offlineChipExists));

  // Bonus: route toast + beacon armed card, since the mock's script exercises
  // them too (not required by the task, but free extra coverage).
  const routeToastShown = await waitFor(page, () => {
    const el = document.querySelector('.route-toast');
    return el !== null && !el.hidden && el.textContent.includes('ROUTE READY');
  }, { timeout: 8000 });
  record('route toast rendered', Boolean(routeToastShown));

  const beaconArmed = await waitFor(page, () => {
    const el = document.querySelector('.beacon-armed-card');
    return el !== null && !el.hidden;
  }, { timeout: 10000 });
  record('beacon armed card rendered', Boolean(beaconArmed));

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  console.log(`Screenshot: ${SCREENSHOT_PATH}`);

  if (consoleErrors.length) {
    console.log('\nconsole.error messages captured:');
    consoleErrors.forEach((e) => console.log('  ' + e));
  }
  if (pageErrors.length) {
    console.log('\nuncaught page errors captured:');
    pageErrors.forEach((e) => console.log('  ' + e));
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  const hardFailure = failed.length > 0 || pageErrors.length > 0;
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed.`);
  if (hardFailure) process.exitCode = 1;
}

main().catch((err) => {
  console.error('selfcheck crashed:', err);
  process.exitCode = 1;
});
