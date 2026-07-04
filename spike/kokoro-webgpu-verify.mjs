// Verifies src/speech/tts.ts's REAL kokoro-js pipeline (dtype:'q8f16',
// device:'webgpu', falling back to dtype:'q8'/device:'wasm') against the
// deduped @huggingface/transformers 4.2.0, running inside an actual browser
// page served by the real dev server — not a Node-side approximation.
// Instruments window.__ttsTestHook (see tts.ts) to capture load/generate
// timing and the exact synthesized audio, and calls the real speak() export
// via window.__heliusSpeakForTest with an arbitrary phrase (both are
// guarded, test-only additions to tts.ts — inert unless a hook is set).
//
// Usage: node spike/kokoro-webgpu-verify.mjs [devServerUrl]

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/georgeteifel/.local/node/lib/node_modules/playwright/index.js');

const BASE_URL = process.argv[2] ?? 'http://localhost:5174';
const PHRASE = 'Sunset in two hours. You will make it.';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
  });

  await page.addInitScript(() => {
    window.__ttsEvents = [];
    window.__ttsTestHook = (e) => {
      // Float32Array doesn't survive the CDP serialization boundary as typed
      // data by default — stash it on window and only ship length/rate
      // across, then read the real array back via a separate evaluate call.
      window.__lastAudioData = e.data ?? window.__lastAudioData;
      window.__ttsEvents.push({ phase: e.phase, ms: e.ms, sampleRate: e.sampleRate, length: e.data ? e.data.length : undefined });
    };
  });

  await page.goto(`${BASE_URL}/?mock=1`, { waitUntil: 'domcontentloaded' });

  // Fire the real speak() pipeline directly with our test phrase, independent
  // of whatever the mock's own scripted turn says.
  await page.waitForFunction(() => typeof window.__heliusSpeakForTest === 'function', { timeout: 10000 });
  const t0 = Date.now();
  await page.evaluate((phrase) => window.__heliusSpeakForTest(phrase), PHRASE);

  // Wait for either a completed generation or an error, generously — first
  // run pays for weight download (~86MB) with a cold browser profile.
  const outcome = await page.waitForFunction(
    () => {
      const events = window.__ttsEvents || [];
      return events.some((e) => e.phase === 'generate-done' || e.phase === 'load-error' || e.phase === 'generate-error');
    },
    { timeout: 180000 }
  ).then(() => 'settled').catch(() => 'timeout');

  const wallMs = Date.now() - t0;
  const events = await page.evaluate(() => window.__ttsEvents || []);
  console.log('Events:', JSON.stringify(events, null, 2));
  console.log('Outcome:', outcome, `(wall ${wallMs}ms)`);

  const loadStart = events.find((e) => e.phase === 'load-start');
  const loadDone = events.find((e) => e.phase === 'load-done');
  const loadError = events.find((e) => e.phase === 'load-error');
  const genStart = events.find((e) => e.phase === 'generate-start');
  const genDone = events.find((e) => e.phase === 'generate-done');
  const genError = events.find((e) => e.phase === 'generate-error');

  if (loadError) {
    console.log('FAIL: kokoro-js failed to load (both webgpu and wasm fallback) — see console warnings above.');
    process.exitCode = 1;
    await browser.close();
    return;
  }
  if (genError || !genDone) {
    console.log('FAIL: kokoro-js loaded but generate() failed or never completed (outcome=' + outcome + ').');
    process.exitCode = 1;
    await browser.close();
    return;
  }

  const loadMs = loadDone && loadStart ? (loadDone.ms - loadStart.ms).toFixed(0) : 'n/a';
  const generateMs = genDone && genStart ? (genDone.ms - genStart.ms).toFixed(0) : 'n/a';
  console.log(`load: ${loadMs}ms | generate: ${generateMs}ms | sampleRate: ${genDone.sampleRate} | samples: ${genDone.length}`);

  // Pull the actual Float32Array back out (stashed on window by the init
  // script since typed arrays don't cross the evaluate() boundary as-is).
  const { rms, durationS } = await page.evaluate(() => {
    const data = window.__lastAudioData;
    const sr = (window.__ttsEvents.find((e) => e.phase === 'generate-done') || {}).sampleRate;
    const mid = data.slice(Math.floor(data.length * 0.25), Math.floor(data.length * 0.75));
    let sumSq = 0;
    for (let i = 0; i < mid.length; i++) sumSq += mid[i] * mid[i];
    return { rms: Math.sqrt(sumSq / mid.length), durationS: data.length / sr };
  });

  console.log(`RMS (middle 50%): ${rms.toFixed(4)} | duration: ${durationS.toFixed(2)}s`);

  const rmsPass = rms > 0.01;
  const durationPass = durationS >= 1 && durationS <= 8;
  console.log(`${rmsPass ? 'PASS' : 'FAIL'}: RMS > 0.01`);
  console.log(`${durationPass ? 'PASS' : 'FAIL'}: duration in [1, 8]s`);

  if (pageErrors.length) {
    console.log('\nUncaught page errors:');
    pageErrors.forEach((e) => console.log('  ' + e));
  }

  await browser.close();
  process.exitCode = rmsPass && durationPass && pageErrors.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('kokoro-webgpu-verify crashed:', err);
  process.exitCode = 1;
});
