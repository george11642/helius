import './style.css';
import { renderShell } from './app/shell';
import { mountBoot } from './app/boot';
import { mountChat } from './app/chat';
import { mountTrace } from './app/trace';
import { mountStatus } from './app/status';
import { mountBeacon } from './app/beacon';
import { mountDevLoc } from './app/devloc';
import { mountRoute } from './app/route';
import { speak, setMuted } from './speech/tts';
import { HeliusMap } from './map/render';
import type { RouteLineString } from './map/render';
import type { AgentEvent } from './lib/contract';
import type { HeliusHandle, CreateHeliusOptions } from './app/mock-agent';

// Matches the convention documented on CreateHeliusOptions.modelBaseUrl in
// src/agent/index.ts ("Base URL of the model mirror, trailing slash").
// The mock agent ignores it entirely.
const MODEL_BASE_URL = 'http://localhost:8737/models/';

// Matches src/tools/location.ts's own default fix — the map's starting view
// before any devloc preset or real GPS fix arrives.
const DEFAULT_FIX = { lat: 35.1983, lon: -106.4439, accuracyM: 14 };

const refs = renderShell(document.getElementById('app')!);
const boot = mountBoot();

const map = new HeliusMap();
let mapInitStarted = false;

function isRouteLineString(g: unknown): g is RouteLineString {
  if (!g || typeof g !== 'object') return false;
  const obj = g as Record<string, unknown>;
  return obj.type === 'LineString' && Array.isArray(obj.coordinates);
}

// Deferred until the engine reaches 'ready' — MapLibre's style/source init
// competes for the GPU/main thread with model load (docs/src/map/README.md:
// cold init seen at 40-90s under contention, single-digit ms in isolation).
// Fire-and-forget: this runs independently of the rest of dispatch().
async function initMapOnce(): Promise<void> {
  if (mapInitStarted) return;
  mapInitStarted = true;
  refs.mapRoot.innerHTML = ''; // drop the "OFFLINE MAP" placeholder text/grid before the real canvas mounts
  try {
    await map.init(refs.mapRoot, 'sandia');
    map.setFix(DEFAULT_FIX.lat, DEFAULT_FIX.lon, DEFAULT_FIX.accuracyM);
  } catch (err) {
    console.warn('[helius] map init failed', err);
  }
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
});
const trace = mountTrace(refs.toolTraceRail);
const route = mountRoute(refs.routeToastLayer);
const beacon = mountBeacon();
mountDevLoc({
  onFixChange: (lat, lon, accuracyM) => map.setFix(lat, lon, accuracyM),
});

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
      // Not just the first ready — a later tier swap re-emits this too, and
      // showing its loadMs live is itself part of the "elasticity" pitch
      // (proves a warm tier swap is actually fast, not just claimed).
      lastLoadMs = e.status.loadMs;
      renderFooter();
      void initMapOnce();
    }
  }
  if (e.type === 'agent-turn-start') setActivity('thinking…');
  if (e.type === 'tool-start') setActivity(`running ${e.call.name}()`);
  if (e.type === 'assistant-token') setActivity('responding…');
  if (e.type === 'speak') {
    setActivity('speaking…');
    speak(e.text);
  }
  if (e.type === 'assistant-done') status.setStats(e.stats);
  if (e.type === 'agent-turn-done') setActivity('ready');
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

  chat.handleEvent(e);
  trace.handleEvent(e);
  route.handleEvent(e);
  beacon.handleEvent(e);
}

async function startAgent(): Promise<HeliusHandle> {
  const params = new URLSearchParams(location.search);
  const forceMock = params.get('mock') === '1';

  if (!forceMock) {
    try {
      // Soft dependency: src/agent/index.ts is owned by a parallel workstream
      // and may not exist yet. A non-literal specifier keeps this out of
      // TypeScript's static module resolution and Vite's build-time chunk
      // graph, so neither typecheck nor build hard-fails while it's still
      // landing — the try/catch below covers both "module doesn't exist" and
      // "createHelius() itself threw/rejected" the same way.
      const agentPath = './agent/index.ts';
      const real = (await import(/* @vite-ignore */ agentPath)) as {
        createHelius?: (opts: CreateHeliusOptions) => Promise<HeliusHandle>;
      };
      if (typeof real.createHelius === 'function') {
        return await real.createHelius({ modelBaseUrl: MODEL_BASE_URL, onEvent: dispatch });
      }
      console.warn('[helius] ./agent/index.ts has no createHelius export; using mock agent');
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
});

// Registers the service worker vite-plugin-pwa generates (registerType:
// 'autoUpdate', injectRegister: null — see vite.config.ts for why this is a
// manual, not virtual-module, registration). Production only: there's no
// dist/sw.js in dev, and a dev-mode SW would just cache-fight the dev server.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js');
}
