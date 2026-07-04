// scenes.mjs — deterministic Playwright DRIVER for the Helius demo video.
// Drives a real Chrome window (system Chrome via channel:'chrome', so WebGPU/Gemma
// actually run); a separate ffmpeg (capture.sh) records the screen — never
// Playwright's own recorder (bitrate hard-capped ~1Mbit/s).
//
//   node scenes.mjs                # dry run: real turns, screenshot per scene → takes/dry
//   DEMO_URL=… TAKE_LABEL=take1 node scenes.mjs
//
// Pre-position WARMS both tiers (so the swap is instant) BEFORE t0, then runs the
// scene sequence. Critical waits are HARD (bounded): a timeout marks the scene
// failed in scenes-timing.json and makes the process exit non-zero. Any scene is
// also flagged if it exceeds 30s. Emits SCENE:{…} + relays TRACE:/PROBE: lines.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_URL = process.env.DEMO_URL || 'http://localhost:4174/?prewarm=1';
const LABEL = process.env.TAKE_LABEL || 'dry';
const OUTDIR = join(HERE, 'takes', LABEL);
const SIGN = join(HERE, 'sign.y4m');
const HERO = "I'm off the trail and I'm not sure where I am. Get me back to the trailhead before sunset.";
const READY_MS = 240000;
const SCENE_CAP_MS = 30000;
mkdirSync(OUTDIR, { recursive: true });

const PROFILE = join(HERE, '.chrome-profile');

// Belt+suspenders against Chrome's "Restore pages? / Chrome didn't shut down
// correctly" crash bubble — it ate a prior take by covering the app and eating
// clicks. Mark the previous session clean in the persistent profile BEFORE
// Playwright launches it (paired with --disable-session-crashed-bubble below).
function clearCrashRestore() {
  const prefsPath = join(PROFILE, 'Default', 'Preferences');
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    writeFileSync(prefsPath, JSON.stringify(prefs));
    console.log('==> cleared crash-restore state in profile Preferences');
  } catch (e) {
    console.log(`  (no crash-restore state to clear — ${String(e.message || e).slice(0, 60)})`);
  }
}
clearCrashRestore();

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 960, height: 540 },
  deviceScaleFactor: 2,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--window-position=0,0', '--window-size=960,540', '--force-device-scale-factor=2',
    '--disable-infobars', '--disable-session-crashed-bubble', '--test-type',
    '--no-first-run', '--no-default-browser-check',
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
const failures = [];
let t0 = 0;
let sceneFailed = false;

// best-effort wait: a timeout is fine (returns false)
const softWait = async (fn, what) => {
  try { await fn(); return true; } catch { console.log(`  (soft: ${what} did not appear)`); return false; }
};
// critical wait: a timeout FAILS the scene (recorded + non-zero exit) and aborts the body
const hardWait = async (fn, what) => {
  try { await fn(); } catch { sceneFailed = true; console.log(`  !! HARD-FAIL: ${what}`); throw new Error(`hardWait:${what}`); }
};
const settled = (ms = 25000) => page.waitForSelector('textarea.chat-input:not([disabled])', { timeout: ms });

async function scene(n, label, body) {
  await page.waitForTimeout(1200); // cut-point pause between scenes
  sceneFailed = false;
  const start = Date.now();
  console.log(`SCENE:${JSON.stringify({ n, label, phase: 'start', off: start - t0 })}`);
  try {
    await body();
  } catch (err) {
    if (!String(err).startsWith('Error: hardWait:')) console.log(`  scene ${n} body error: ${String(err).slice(0, 140)}`);
  }
  const end = Date.now();
  if (end - start > SCENE_CAP_MS) { sceneFailed = true; console.log(`  !! scene ${n} exceeded 30s cap (${end - start}ms)`); }
  await page.screenshot({ path: join(OUTDIR, `S${String(n).padStart(2, '0')}-${label}.png`) }).catch(() => {});
  scenes.push({ n, label, startMs: start - t0, endMs: end - t0, ms: end - start, failed: sceneFailed });
  if (sceneFailed) failures.push(`S${n}:${label}`);
  console.log(`SCENE:${JSON.stringify({ n, label, phase: 'end', off: end - t0, ms: end - start, failed: sceneFailed })}`);
}

try {
  console.log(`==> ${DEMO_URL}`);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('==> waiting for engine ready (model load)…');
  await page.waitForSelector('textarea.chat-input:not([disabled])', { timeout: READY_MS });
  console.log('==> engine ready.');

  // ---- pre-position (NOT recorded / before t0) ----
  // 1. offline warm for the green badge
  await softWait(async () => {
    await page.click('.chip-warm-offline', { timeout: 3000 });
    await page.waitForSelector('.chip-offline[data-state="ready"]', { timeout: 45000 });
  }, 'OFFLINE-READY badge');
  // 2. force-load E4B via a tier round-trip (setTier loads it directly — NO warm-up
  //    turn, which would pollute the conversation and make the hero turn shortcut to
  //    a single chip). Fresh conversation → full locate→sun_clock→route_back chain,
  //    and E4B resident → the S5 swap is instant.
  await softWait(async () => {
    await page.click('.chip-tier');
    await page.waitForSelector('.chip-tier[data-tier="E4B"]', { timeout: 60000 });
    await page.click('.chip-tier');
    await page.waitForSelector('.chip-tier[data-tier="E2B"]', { timeout: 60000 });
  }, 'warm both tiers');
  console.log('==> warmed (both tiers resident, conversation fresh). Rolling scenes.');

  t0 = Date.now();

  await scene(1, 'idle-ready', async () => {
    await hardWait(() => page.waitForSelector('.wordmark', { timeout: 5000 }), 'wordmark');
  });

  await scene(2, 'hero-ask', async () => {
    await page.fill('textarea.chat-input', HERO);
    await page.click('.chat-send-btn');
    await hardWait(() => page.waitForSelector('.msg-user', { timeout: 10000 }), 'user bubble');
  });

  await scene(3, 'trace-chips', async () => {
    // the money shot — the real chain populates (locate→sun_clock→route_back…)
    await hardWait(() => page.waitForFunction(() => document.querySelectorAll('.tool-trace-rail .trace-chip').length >= 3, null, { timeout: 25000 }), '≥3 trace chips');
    await page.waitForTimeout(600);
  });

  await scene(4, 'route-draw', async () => {
    await hardWait(() => page.waitForSelector('.route-toast:not([hidden])', { timeout: 25000 }), 'route-ready toast');
    await page.waitForTimeout(1500); // flyTo settle
    await hardWait(() => settled(20000), 'turn finished');
  });

  await scene('2b', 'mic-pulse', async () => {
    const box = await (await page.$('.mic-btn'))?.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await softWait(() => page.waitForSelector('.mic-waveform:not([hidden])', { timeout: 4000 }), 'mic waveform');
      await page.waitForTimeout(900);
      await page.mouse.up();
    }
    await softWait(() => settled(25000), 'mic turn settle');
  });

  await scene(5, 'tier-swap', async () => {
    // both tiers are warm (pre-position) → these are instant hot-swaps
    await page.click('.chip-tier');
    await hardWait(() => page.waitForSelector('.chip-tier[data-tier="E4B"]', { timeout: 12000 }), 'swap to E4B');
    await page.waitForTimeout(900);
    await page.click('.chip-tier');
    await hardWait(() => page.waitForSelector('.chip-tier[data-tier="E2B"]', { timeout: 12000 }), 'swap back to E2B');
    await page.waitForTimeout(600);
  });

  await scene(6, 'read-sign', async () => {
    await page.click('.camera-btn');
    await hardWait(() => page.waitForSelector('.camera-overlay:not([hidden]) .camera-preview', { timeout: 8000 }), 'camera overlay');
    await page.waitForTimeout(1200); // let the fake sign video start
    await page.click('.camera-overlay'); // tap-to-capture
    await hardWait(() => settled(25000), 'read_sign turn');
    await page.waitForTimeout(500);
  });

  await scene(7, 'beacon', async () => {
    // Ask to ARM (not fire) so the tap-to-fire card appears (src/app/beacon.ts:
    // 'arm' → .beacon-armed-card shown; clicking it → .beacon-strobe-overlay).
    if (!(await page.$('.beacon-armed-card:not([hidden])'))) {
      await page.fill('textarea.chat-input', "Arm the morse beacon — don't fire it yet.");
      await page.click('.chat-send-btn');
      await hardWait(() => page.waitForSelector('.beacon-armed-card:not([hidden])', { timeout: 20000 }), 'armed card');
      await softWait(() => settled(15000), 'arm turn settle');
    }
    await page.click('.beacon-armed-card'); // tap to fire
    await hardWait(() => page.waitForSelector('.beacon-strobe-overlay:not([hidden])', { timeout: 5000 }), 'strobe overlay');
    await page.waitForTimeout(3000); // a few SOS cycles
    await page.click('.beacon-strobe-overlay').catch(() => {}); // tap to stop
  });

  await scene(8, 'end-hold', async () => {
    await hardWait(() => page.waitForSelector('.wordmark', { timeout: 5000 }), 'wordmark');
    await page.waitForTimeout(1000);
  });

  const ok = failures.length === 0;
  const timing = { t0, url: DEMO_URL, label: LABEL, ok, failures, totalMs: Date.now() - t0, traceChips: traceLines.length, scenes };
  writeFileSync(join(HERE, 'scenes-timing.json'), JSON.stringify(timing, null, 2));
  console.log(`\n==> scenes-timing.json: ${scenes.length} scenes, ${traceLines.length} TRACE chips, ${((Date.now() - t0) / 1000).toFixed(1)}s total, ${ok ? 'ALL PASS ✓' : 'FAILURES: ' + failures.join(', ')}`);
  console.log(`==> screenshots → ${OUTDIR}`);
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.error('scenes.mjs FAILED:', err);
  await page.screenshot({ path: join(OUTDIR, 'FAILURE.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await ctx.close();
}
