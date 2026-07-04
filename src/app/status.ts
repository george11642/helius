// Header status chips: (a) offline-readiness badge — INVERTED semantics vs.
// a normal web app, because for this product "offline" is the *good* state;
// (b) model tier chip (click to toggle E2B/E4B); (c) live tok/s mini-meter;
// (d) TTS mute toggle.

import type { EngineStatus, ModelTier } from '../lib/contract';
import { warmPack, checkOfflineReady } from '../map/warm';
import { warmCache as warmKokoroCache } from '../speech/tts';

export interface StatusOptions {
  /** Calls agent.setTier(tier) and resolves once it settles. */
  onSetTier(tier: ModelTier): Promise<void>;
  onMuteChange(muted: boolean): void;
  /** Map-only boots: the LOAD AI chip calls this to start the model load. */
  onLoadModel?(): void;
}

export interface StatusHandle {
  el: HTMLElement;
  handleEngineStatus(status: EngineStatus): void;
  setStats(stats: { decodeTps: number; prefillMs: number } | null): void;
  /** Offline-readiness is pack-specific (each pack has its own map assets) —
   *  call on every 'pack-changed' event so the badge/warm-button re-query
   *  checkOfflineReady for the newly active pack, rather than keeping the
   *  previous pack's cached result. */
  setPack(packId: string): void;
}

// The contract's EngineStatus 'ready' variant only types {tier, loadMs}, but the
// engine may duck-type extra fields onto it to signal a runtime degrade (e.g.
// E4B falling back to text-only). Read defensively rather than trusting the
// narrow type — this isn't part of the frozen contract shape.
function readTextOnlyDegrade(status: EngineStatus & Record<string, unknown>): boolean {
  if (status.state !== 'ready') return false;
  return Boolean(status['textOnly'] || status['degraded'] === 'text-only' || status['audioDegraded']);
}

export function mountStatus(container: HTMLElement, opts: StatusOptions): StatusHandle {
  container.innerHTML = `
    <button type="button" class="chip chip-offline" data-state="pending">&#9671; online (downloading ok)</button>
    <button type="button" class="chip chip-warm-offline" hidden>Download for offline</button>
    <button type="button" class="chip chip-load-model" hidden>&#9650; LOAD AI</button>
    <button type="button" class="chip chip-tier" data-tier="E2B">GEMMA 4 &middot; &mdash;</button>
    <span class="chip chip-tps">-- tok/s</span>
    <button type="button" class="chip chip-mute" data-muted="false" aria-pressed="false">&#128266;</button>
  `;

  const offlineChip = container.querySelector<HTMLElement>('.chip-offline')!;
  const loadChip = container.querySelector<HTMLButtonElement>('.chip-load-model')!;
  const warmChip = container.querySelector<HTMLButtonElement>('.chip-warm-offline')!;
  const tierChip = container.querySelector<HTMLButtonElement>('.chip-tier')!;
  const tpsChip = container.querySelector<HTMLElement>('.chip-tps')!;
  const muteChip = container.querySelector<HTMLButtonElement>('.chip-mute')!;

  let currentTier: ModelTier = 'E2B';
  let currentPack = 'sandia';
  let modelReady = false;
  let switching = false;
  let muted = false;
  // Never a session flag we set ourselves — checkOfflineReady() is queried
  // fresh on every trigger below and IS the truth; `offlineOk` is just the
  // last query's result, cached only for rendering between triggers. SW
  // registered + model downloaded does NOT mean truly offline-ready: map
  // packs are read via pmtiles Range requests (only ever cache partial 206
  // responses — see src/map/warm.ts) and kokoro's ~86MB loads lazily from HF
  // CDN on first use, neither of which happens just from booting the model —
  // and a pack switched back to doesn't need re-warming if it already was.
  let offlineOk = false;
  let refreshInFlight = false;
  let warming = false;

  function render(): void {
    warmChip.hidden = !modelReady || offlineOk;
    if (offlineOk) {
      offlineChip.dataset.state = 'ready';
      offlineChip.textContent = '⬢ OFFLINE-READY';
    } else {
      offlineChip.dataset.state = 'pending';
      offlineChip.textContent = navigator.onLine ? '⬡ online (downloading ok)' : '⬡ offline (waiting for network)';
    }
  }

  // checkOfflineReady is a fast, Cache-Storage-only read (its own docs: well
  // under ~200ms) — dropping an overlapping call rather than queueing it is
  // an acceptable simplification at that speed.
  async function refreshOfflineReady(): Promise<void> {
    if (!modelReady) {
      render();
      return;
    }
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const result = await checkOfflineReady(currentPack);
      offlineOk = result.ok;
      if (!result.ok) console.debug('[helius] offline not ready yet', result.missing);
    } catch (err) {
      console.warn('[helius] checkOfflineReady failed', err);
      offlineOk = false;
    } finally {
      refreshInFlight = false;
      render();
    }
  }

  warmChip.addEventListener('click', () => {
    if (warming || offlineOk) return;
    warming = true;
    warmChip.textContent = 'downloading…';
    warmChip.disabled = true;
    Promise.all([warmPack(currentPack), warmKokoroCache()])
      .then(([packResults, kokoroOk]) => {
        const packOk = packResults.every((r) => r.ok);
        if (!packOk || !kokoroOk) console.warn('[helius] offline warm-up incomplete', { packResults, kokoroOk });
        return refreshOfflineReady();
      })
      .catch((err) => console.warn('[helius] offline warm-up failed', err))
      .finally(() => {
        warming = false;
        warmChip.disabled = false;
        warmChip.textContent = offlineOk ? 'Download for offline' : 'Download for offline (retry)';
        render();
      });
  });

  function renderTierChip(tier: ModelTier, degraded: boolean): void {
    tierChip.dataset.tier = tier;
    tierChip.innerHTML = degraded
      ? `GEMMA 4 &middot; ${tier} <span class="tier-degrade">&middot; text</span>`
      : `GEMMA 4 &middot; ${tier}`;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => void refreshOfflineReady());
  }
  window.addEventListener('online', () => void refreshOfflineReady());
  window.addEventListener('offline', () => void refreshOfflineReady());

  function handleEngineStatus(status: EngineStatus): void {
    if (status.state === 'ready') {
      modelReady = true;
      currentTier = status.tier;
      switching = false;
      tierChip.dataset.switching = 'false';
      loadChip.hidden = true;
      renderTierChip(status.tier, readTextOnlyDegrade(status));
      void refreshOfflineReady();
    } else if (status.state === 'idle') {
      // Map-only boot: the model never started loading — offer the explicit
      // start affordance in the header (mirrors the onboarding button).
      loadChip.hidden = false;
      loadChip.disabled = false;
      loadChip.innerHTML = '&#9650; LOAD AI';
      render();
    } else if (status.state === 'downloading' && !modelReady) {
      // Load started from map-only mode: keep the chip as a live progress
      // readout (the onboarding overlay is gone by then).
      loadChip.hidden = false;
      loadChip.disabled = true;
      loadChip.textContent = status.stage === 'read' ? `AI · reading ${status.pct.toFixed(0)}%` : `AI · ${status.pct.toFixed(0)}%`;
    } else if (status.state === 'compiling' && !modelReady) {
      loadChip.hidden = false;
      loadChip.disabled = true;
      loadChip.textContent = 'AI · compiling…';
    } else {
      render();
    }
  }

  loadChip.addEventListener('click', () => {
    if (loadChip.disabled) return;
    loadChip.disabled = true;
    loadChip.textContent = 'AI · starting…';
    opts.onLoadModel?.();
  });

  function setStats(stats: { decodeTps: number; prefillMs: number } | null): void {
    tpsChip.textContent = stats ? `${stats.decodeTps.toFixed(1)} tok/s` : '-- tok/s';
  }

  tierChip.addEventListener('click', () => {
    if (switching || !modelReady) return;
    const next: ModelTier = currentTier === 'E2B' ? 'E4B' : 'E2B';
    switching = true;
    tierChip.dataset.switching = 'true';
    tierChip.innerHTML = `GEMMA 4 &middot; switching&hellip;`;
    opts
      .onSetTier(next)
      .then(() => {
        // Optimistic update in case the engine doesn't re-emit an engine-status
        // event after a tier swap; a later 'ready' event (if it comes) still wins.
        currentTier = next;
        switching = false;
        tierChip.dataset.switching = 'false';
        renderTierChip(next, false);
      })
      .catch((err) => {
        console.error('[helius] setTier failed', err);
        switching = false;
        tierChip.dataset.switching = 'false';
        renderTierChip(currentTier, false);
      });
  });

  muteChip.addEventListener('click', () => {
    muted = !muted;
    muteChip.dataset.muted = String(muted);
    muteChip.setAttribute('aria-pressed', String(muted));
    muteChip.textContent = muted ? '🔇' : '🔊';
    opts.onMuteChange(muted);
  });

  function setPack(packId: string): void {
    currentPack = packId;
    // Don't assume "not warmed" — a pack switched back to may already be
    // cached from before. Let checkOfflineReady decide, not a blind reset.
    void refreshOfflineReady();
  }

  render();

  return { el: container, handleEngineStatus, setStats, setPack };
}
