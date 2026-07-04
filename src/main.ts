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
import type { AgentEvent } from './lib/contract';
import type { HeliusHandle, CreateHeliusOptions } from './app/mock-agent';

// Matches the convention documented on CreateHeliusOptions.modelBaseUrl in
// src/agent/index.ts ("Base URL of the model mirror, trailing slash").
// The mock agent ignores it entirely.
const MODEL_BASE_URL = 'http://localhost:8737/models/';

const refs = renderShell(document.getElementById('app')!);
const boot = mountBoot();

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
mountDevLoc();

const chat = mountChat(refs.chatMessages, refs.chatInputRow, {
  onSend: (text) => void agent?.sendText(text),
  onAudio: (samples) => void agent?.sendVoice(samples),
});

let activity = 'booting…';
function renderFooter(): void {
  const stats = agent?.getStats() ?? null;
  const statsPart = stats ? `${stats.decodeTps.toFixed(1)} tok/s · prefill ${stats.prefillMs.toFixed(0)}ms` : '--';
  refs.statusText.textContent = `${activity}  ·  ${statsPart}`;
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
    if (e.status.state === 'ready') chat.setEnabled(true);
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
