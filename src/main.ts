import './style.css';
import { renderShell } from './app/shell';
import { mountOnboarding } from './app/onboarding';
import { mountPosChip } from './app/poschip';
import { mountChat } from './app/chat';
import { mountTrace } from './app/trace';
import { mountStatus } from './app/status';
import { mountBeacon } from './app/beacon';
import { mountDevLoc } from './app/devloc';
import { mountRoute } from './app/route';
import { mountPackPicker } from './app/packpicker';
import { mountBrief } from './brief/ui';
import { speak, setMuted } from './speech/tts';
import { HeliusMap } from './map/render';
import type { RouteLineString } from './map/render';
import type { AgentEvent } from './lib/contract';
import type { HeliusHandle } from './app/mock-agent';

// Matches the convention documented on CreateHeliusOptions.modelBaseUrl in
// src/agent/index.ts ("Base URL of the model mirror, trailing slash"). Dev
// talks to the local model-mirror server; production points at the live R2
// bucket (CORS + Range support verified). VITE_MODEL_BASE_URL overrides both
// for one-off testing. The mock agent ignores this value entirely.
const MODEL_BASE_URL =
  import.meta.env.VITE_MODEL_BASE_URL ??
  (import.meta.env.DEV ? 'http://localhost:8737/models/' : 'https://pub-186c78c24ee54dda820fe564c0ac4608.r2.dev/');

// Matches src/tools/location.ts's own default fix — the map's starting view
// before any devloc preset or real GPS fix arrives.
const DEFAULT_FIX = { lat: 35.1983, lon: -106.4439, accuracyM: 14 };

const refs = renderShell(document.getElementById('app')!);

// The deterministic demo/judge/video paths (?demo=1, ?devloc, ?fix, ?mock=1)
// keep today's instant flow: autoload on, no onboarding gate — just the boot
// progress card. Everyone else gets the first-run gate: pick a region pack,
// see the honest capability verdict, and explicitly start the ~3.4GB load
// (returning users with the weights already resident skip straight in — the
// gate auto-continues off the preflight's modelResidentMB).
const bootParams = new URLSearchParams(location.search);
const instantFlow =
  bootParams.has('demo') || bootParams.has('devloc') || bootParams.has('fix') || bootParams.get('mock') === '1';

// Set true when the user (or the fully-cached fast path) explicitly starts the
// load before the agent façade has resolved; consumed once it does.
let pendingLoad = false;
let pendingPack: string | null = null;
let chosenPack = 'sandia'; // tracks the canonical current pack (pack-changed is the source of truth)

const boot = mountOnboarding({
  instant: instantFlow,
  onStartLoad: () => {
    if (agent) void agent.loadModel();
    else pendingLoad = true;
  },
  onMapOnly: () => {
    setActivity('map-only mode');
    void initMapOnce();
  },
  onPackChosen: (packId) => {
    chosenPack = packId;
    if (agent) {
      agent.switchPack(packId).catch((err) => console.warn('[helius] switchPack failed', err));
    } else {
      pendingPack = packId;
    }
  },
});

// Reassigned on every pack switch (see initMapForPack) — HeliusMap has no
// destroy()/setPack() of its own (checked render.ts), so a pack switch tears
// down the old MapLibre instance via its exposed `.instance` escape hatch
// and constructs a fresh HeliusMap for the new pack, rather than reaching
// into render.ts's private internals.
let map = new HeliusMap();
let mapInitStarted = false;

// Guards against two overlapping initMapForPack calls (e.g. a rapid
// double-switch): only the call whose generation is still current when its
// own await resolves is allowed to publish itself as the live `map` and call
// setFix — an older, superseded call tears down whatever it built instead of
// racing to apply its (now-stale) fix to whichever instance won.
let mapGeneration = 0;

function isRouteLineString(g: unknown): g is RouteLineString {
  if (!g || typeof g !== 'object') return false;
  const obj = g as Record<string, unknown>;
  return obj.type === 'LineString' && Array.isArray(obj.coordinates);
}

async function initMapForPack(packId: string, fix: { lat: number; lon: number }): Promise<void> {
  mapInitStarted = true; // a pack switch counts too — don't let initMapOnce's sandia-default clobber it later
  const myGeneration = ++mapGeneration;
  packPicker.setEnabled(false); // block further switches until this one settles — the practical fix for the race

  map.instance?.remove(); // release the old WebGL context/listeners before replacing it
  refs.mapRoot.innerHTML = ''; // drop the "OFFLINE MAP" placeholder text/grid (or the old canvas) before the new one mounts
  const nextMap = new HeliusMap();
  map = nextMap;

  try {
    await nextMap.init(refs.mapRoot, packId);
    if (myGeneration !== mapGeneration) {
      // A newer switch started while this one was still initializing —
      // we lost the race. Tear down rather than apply a stale fix or leave
      // two canvases fighting over #map-root.
      nextMap.instance?.remove();
      return;
    }
    nextMap.setFix(fix.lat, fix.lon, DEFAULT_FIX.accuracyM);
  } catch (err) {
    console.warn('[helius] map init failed', err);
  } finally {
    if (myGeneration === mapGeneration) packPicker.setEnabled(true);
  }
}

// Deferred until the engine reaches 'ready' — MapLibre's style/source init
// competes for the GPU/main thread with model load (docs/src/map/README.md:
// cold init seen at 40-90s under contention, single-digit ms in isolation).
// Fire-and-forget: this runs independently of the rest of dispatch().
async function initMapOnce(): Promise<void> {
  if (mapInitStarted) return;
  mapInitStarted = true;
  await initMapForPack(chosenPack, DEFAULT_FIX);
}

// Assigned once the (mock or real) agent factory resolves; mounted modules
// below are wired with callbacks that close over this binding rather than
// needing the handle to exist yet, since createHelius() is async.
let agent: HeliusHandle | null = null;

const status = mountStatus(refs.headerChips, {
  onSetTier: (tier) => {
    if (!agent) return Promise.reject(new Error('agent not ready'));
    return agent.setTier(tier);
  },
  onMuteChange: (muted) => setMuted(muted),
  onLoadModel: () => {
    if (agent) void agent.loadModel();
    else pendingLoad = true;
  },
});
const trace = mountTrace(refs.toolTraceRail);
const posChip = mountPosChip(refs.mapOverlaySlot);
const route = mountRoute(refs.routeToastLayer);
const beacon = mountBeacon();
const devloc = mountDevLoc({
  onFixChange: (lat, lon, accuracyM) => map.setFix(lat, lon, accuracyM),
});
const packPicker = mountPackPicker(refs.headerPackSlot, {
  onSwitchPack: (packId) => {
    if (!agent) return Promise.reject(new Error('agent not ready'));
    return agent.switchPack(packId);
  },
});

mountBrief(); // optional online mission planning (self-hides when unavailable)

const chat = mountChat(refs.chatMessages, refs.chatInputRow, {
  onSend: (text) => void agent?.sendText(text),
  onAudio: (samples) => void agent?.sendVoice(samples),
  onReadSign: (image) => void agent?.readSign(image),
});

let activity = 'booting…';
let lastLoadMs: number | null = null;
function renderFooter(): void {
  const stats = agent?.getStats() ?? null;
  const statsPart = stats ? `${stats.decodeTps.toFixed(1)} tok/s · prefill ${stats.prefillMs.toFixed(0)}ms` : '--';
  const loadPart = lastLoadMs !== null ? ` · last load ${lastLoadMs}ms` : '';
  refs.statusText.textContent = `${activity}  ·  ${statsPart}${loadPart}`;
}
function setActivity(text: string): void {
  activity = text;
  renderFooter();
}
window.setInterval(renderFooter, 2000);
renderFooter();

function dispatch(e: AgentEvent): void {
  if (e.type === 'engine-status') {
    boot.handleStatus(e.status);
    status.handleEngineStatus(e.status);
    setActivity(e.status.state);
    // createHelius() resolves as soon as the façade object exists, not once the
    // engine is actually ready (the real agent kicks off model load in the
    // background and streams progress through this same event) — gate input
    // on the 'ready' status itself, not on the createHelius() promise.
    if (e.status.state === 'ready') {
      chat.setEnabled(true);
      packPicker.setEnabled(true);
      // Not just the first ready — a later tier swap re-emits this too, and
      // showing its loadMs live is itself part of the "elasticity" pitch
      // (proves a warm tier swap is actually fast, not just claimed).
      lastLoadMs = e.status.loadMs;
      renderFooter();
      void initMapOnce();
    }
  }
  if (e.type === 'agent-turn-start') {
    setActivity('thinking…');
    // Locked for the whole turn, not just while a request is in flight — a
    // second concurrent send would corrupt shared conversation history (the
    // agent loop serializes on its side too; this is the UI-side half).
    chat.setEnabled(false);
  }
  if (e.type === 'tool-start') setActivity(`running ${e.call.name}()`);
  if (e.type === 'assistant-token') setActivity('responding…');
  if (e.type === 'speak') {
    setActivity('speaking…');
    speak(e.text);
  }
  if (e.type === 'assistant-done') status.setStats(e.stats);
  if (e.type === 'agent-turn-done') {
    setActivity('ready');
    chat.setEnabled(true);
  }
  if (e.type === 'route' && isRouteLineString(e.geojson)) {
    // route_back may still be a stub with no/placeholder geojson until the
    // real-graph integration lands — in that case just skip drawing and keep
    // the toast (route.handleEvent below always renders regardless).
    map.drawRoute(e.geojson, { animateMs: 1500 });
    map.flyToRoute();
  }
  if (e.type === 'beacon') {
    if (e.action === 'start') map.setBeaconMode(true);
    else if (e.action === 'stop') map.setBeaconMode(false);
  }
  if (e.type === 'pack-changed') {
    chosenPack = e.pack.id;
    route.clear(); // a route drawn for the old region means nothing in the new one
    devloc.setPack(e.pack.id, e.fix);
    status.setPack(e.pack.id);
    packPicker.setCurrentPack(e.pack.id); // resync display to the event, the actual source of truth
    void initMapForPack(e.pack.id, e.fix);
  }

  chat.handleEvent(e);
  trace.handleEvent(e);
  route.handleEvent(e);
  beacon.handleEvent(e);
  posChip.handleEvent(e);
}

async function startAgent(): Promise<HeliusHandle> {
  const params = new URLSearchParams(location.search);
  const forceMock = params.get('mock') === '1';
  // deviceMemory caps out at 8 in the API even on higher-RAM machines, so
  // this is opt-in (URL param or a sticky localStorage flag) rather than
  // auto-detected — auto-prewarming both tiers could OOM a real 8GB judge
  // machine. Passed through as a plain (non-literal) options object so it
  // type-checks whether or not CreateHeliusOptions has picked up `prewarm`
  // yet (structural assignability tolerates the extra field either way).
  const prewarm = params.has('prewarm') || localStorage.getItem('helius-prewarm') === '1';

  if (!forceMock) {
    try {
      // src/agent/index.ts now definitively exists — a STATIC, literal-specifier
      // import so Rollup's dependency graph actually discovers and bundles it
      // into the production build. (Previously used a non-literal specifier +
      // @vite-ignore as a soft dependency while this module was still landing;
      // that only ever worked in dev, where Vite serves any source file
      // on-the-fly — in a production build the file is invisible to the
      // bundler and never gets emitted, so the import 404s and silently falls
      // back to the mock agent. Verified this was actually happening before
      // fixing it.) The try/catch below still covers genuine runtime failures
      // (createHelius() throwing — e.g. WebGPU unsupported).
      const real = await import('./agent/index');
      // autoload only on the instant demo paths — the onboarding gate owns
      // the explicit start otherwise (loadModel via onStartLoad/pendingLoad).
      const opts = { modelBaseUrl: MODEL_BASE_URL, onEvent: dispatch, prewarm, autoload: instantFlow };
      return await real.createHelius(opts);
    } catch (err) {
      console.warn('[helius] real agent unavailable, falling back to mock agent', err);
    }
  }

  const mock = await import('./app/mock-agent');
  return mock.createHelius({ modelBaseUrl: MODEL_BASE_URL, onEvent: dispatch });
}

void startAgent().then((handle) => {
  agent = handle;
  renderFooter();
  // Consume anything the onboarding gate queued before the façade resolved.
  if (pendingPack) {
    handle.switchPack(pendingPack).catch((err) => console.warn('[helius] switchPack failed', err));
    pendingPack = null;
  }
  if (pendingLoad) {
    pendingLoad = false;
    void handle.loadModel();
  }
  handle
    .listPacks()
    .then((packs) => {
      packPicker.setPacks(packs, chosenPack);
      boot.setPacks(packs, chosenPack);
    })
    .catch((err) => console.warn('[helius] listPacks failed', err));
});

// Registers the service worker vite-plugin-pwa generates (registerType:
// 'autoUpdate', injectRegister: null — see vite.config.ts for why this is a
// manual, not virtual-module, registration). Production only: there's no
// dist/sw.js in dev, and a dev-mode SW would just cache-fight the dev server.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js');
}

