// scenes.mjs — deterministic Playwright DRIVER for the Helius demo video.
// It only DRIVES a real Chrome window (system Chrome via channel:'chrome', so
// WebGPU/Gemma actually run); a separate ffmpeg (capture.sh) records the screen.
// Never uses Playwright's own recorder (bitrate is hardcoded ~1Mbit/s).
//
//   node scenes.mjs                # dry run: real turn, screenshot每scene → takes/dry
//   DEMO_URL=… TAKE_LABEL=take1 node scenes.mjs
//
// Emits numbered SCENE:{...} + relays the app's TRACE:/PROBE: console lines, and
// writes scenes-timing.json (t0 + per-scene offsets) for assemble.sh cut points.
// A fake camera device fed sign.y4m drives the read_sign beat glare-free.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_URL = process.env.DEMO_URL || 'http://localhost:4174/?prewarm=1';
const LABEL = process.env.TAKE_LABEL || 'dry';
const OUTDIR = join(HERE, 'takes', LABEL);
const SIGN = join(HERE, 'sign.y4m');
const HERO = "I'm off the trail and I'm not sure where I am. Get me back to the trailhead before sunset.";
const READY_MS = 240000; // R2 cold path is ~96s; allow generous headroom
mkdirSync(OUTDIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(join(HERE, '.chrome-profile'), {
  channel: 'chrome',
  headless: false,
  viewport: { width: 960, height: 540 },
  deviceScaleFactor: 2,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--window-position=0,0', '--window-size=960,540', '--force-device-scale-factor=2',
    '--disable-infobars', '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${SIGN}`,
    '--enable-unsafe-webgpu', '--enable-features=Vulkan',
  ],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const traceLines = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('TRACE:') || t.startsWith('PROBE:') || t.startsWith('[helius]')) {
    console.log(t.slice(0, 300));
    if (t.startsWith('TRACE:')) traceLines.push(t);
  }
});

const scenes = [];
let t0 = 0;
const softWait = async (fn, ms, what) => {
  try {
    await fn();
    return true;
  } catch {
    console.log(`  (soft-timeout waiting for ${what})`);
    return false;
  }
};
async function scene(n, label, body) {
  await page.waitForTimeout(1500); // cut-point pause between scenes
  const start = Date.now();
  console.log(`SCENE:${JSON.stringify({ n, label, phase: 'start', off: start - t0 })}`);
  try {
    await body();
  } catch (err) {
    console.log(`  !! scene ${n} (${label}) body error: ${String(err).slice(0, 160)}`);
  }
  const end = Date.now();
  await page.screenshot({ path: join(OUTDIR, `S${String(n).padStart(2, '0')}-${label}.png`) }).catch(() => {});
  scenes.push({ n, label, startMs: start - t0, endMs: end - t0 });
  console.log(`SCENE:${JSON.stringify({ n, label, phase: 'end', off: end - t0, ms: end - start })}`);
}
const turnSettled = () => page.waitForSelector('textarea.chat-input:not([disabled])', { timeout: 120000 });

try {
  console.log(`==> ${DEMO_URL}`);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the engine to reach ready (boot overlay fades → chat input enabled).
  console.log('==> waiting for engine ready (model load)…');
  await page.waitForSelector('textarea.chat-input:not([disabled])', { timeout: READY_MS });
  console.log('==> engine ready.');

  // Pre-position: warm for the green offline badge (best-effort).
  await softWait(async () => {
    await page.click('.chip-warm-offline', { timeout: 3000 });
    await page.waitForSelector('.chip-offline[data-state="ready"]', { timeout: 45000 });
  }, 45000, 'OFFLINE-READY badge');

  t0 = Date.now();

  await scene(1, 'idle-ready', async () => {
    await page.waitForSelector('.wordmark', { timeout: 5000 });
  });

  await scene(2, 'hero-ask', async () => {
    await page.fill('textarea.chat-input', HERO);
    await page.click('.chat-send-btn');
    await page.waitForSelector('.msg-user', { timeout: 10000 });
  });

  await scene(3, 'trace-chips', async () => {
    // the money shot — wait for the real tool chain to populate (locate→sun→route…)
    await page.waitForFunction(() => document.querySelectorAll('.tool-trace-rail .trace-chip').length >= 3, null, { timeout: 90000 });
    await page.waitForTimeout(600);
  });

  await scene(4, 'route-draw', async () => {
    await softWait(() => page.waitForSelector('.route-toast:not([hidden])', { timeout: 60000 }), 60000, 'route toast');
    await page.waitForTimeout(1800); // let the map flyTo settle
    await softWait(() => turnSettled(), 120000, 'turn to finish');
  });

  await scene('2b', 'mic-pulse', async () => {
    const mic = await page.$('.mic-btn');
    if (mic) {
      const box = await mic.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await softWait(() => page.waitForSelector('.mic-waveform:not([hidden])', { timeout: 4000 }), 4000, 'mic waveform');
        await page.waitForTimeout(900);
        await page.mouse.up();
      }
    }
    await softWait(() => turnSettled(), 60000, 'mic turn settle');
  });

  await scene(5, 'tier-swap', async () => {
    await page.click('.chip-tier');
    await softWait(() => page.waitForSelector('.chip-tier[data-tier="E4B"]', { timeout: 45000 }), 45000, 'swap to E4B');
    await page.waitForTimeout(900);
    await page.click('.chip-tier');
    await softWait(() => page.waitForSelector('.chip-tier[data-tier="E2B"]', { timeout: 45000 }), 45000, 'swap back to E2B');
    await page.waitForTimeout(600);
  });

  await scene(6, 'read-sign', async () => {
    await page.click('.camera-btn');
    await softWait(() => page.waitForSelector('.camera-overlay:not([hidden]) .camera-preview', { timeout: 8000 }), 8000, 'camera overlay');
    await page.waitForTimeout(1200); // let the fake sign video start
    await page.click('.camera-overlay'); // tap-to-capture
    await softWait(() => turnSettled(), 120000, 'read_sign turn');
    await page.waitForTimeout(600);
  });

  await scene(7, 'beacon', async () => {
    // Ask the agent to arm it (it may already have), then fire the strobe.
    if (!(await page.$('.beacon-armed-card:not([hidden])'))) {
      await page.fill('textarea.chat-input', 'Arm the SOS beacon.');
      await page.click('.chat-send-btn');
      await softWait(() => page.waitForSelector('.beacon-armed-card:not([hidden])', { timeout: 90000 }), 90000, 'beacon armed card');
      await softWait(() => turnSettled(), 60000, 'beacon turn settle');
    }
    await softWait(async () => {
      await page.click('.beacon-armed-card');
      await page.waitForSelector('.beacon-strobe-overlay:not([hidden])', { timeout: 5000 });
    }, 5000, 'strobe start');
    await page.waitForTimeout(1500); // let a couple SOS cycles flash
    await page.click('.beacon-strobe-overlay').catch(() => {}); // tap to stop
  });

  await scene(8, 'end-hold', async () => {
    await page.waitForSelector('.wordmark', { timeout: 5000 });
    await page.waitForTimeout(1000);
  });

  const timing = { t0, url: DEMO_URL, label: LABEL, totalMs: Date.now() - t0, traceChips: traceLines.length, scenes };
  writeFileSync(join(HERE, 'scenes-timing.json'), JSON.stringify(timing, null, 2));
  console.log(`\n==> wrote scenes-timing.json (${scenes.length} scenes, ${traceLines.length} TRACE chips, ${timing.totalMs}ms total)`);
  console.log(`==> screenshots → ${OUTDIR}`);
} catch (err) {
  console.error('scenes.mjs FAILED:', err);
  await page.screenshot({ path: join(OUTDIR, 'FAILURE.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await ctx.close();
}
