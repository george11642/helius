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
}

export interface StatusHandle {
  el: HTMLElement;
  handleEngineStatus(status: EngineStatus): void;
  setStats(stats: { decodeTps: number; prefillMs: number } | null): void;
  /** Offline-readiness is pack-specific (each pack has its own map assets to
   *  warm) — call on every 'pack-changed' event so the badge/warm-button
   *  correctly reset to "not yet warmed" for the newly active pack. */
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
    <button type="button" class="chip chip-tier" data-tier="E2B">GEMMA 4 &middot; &mdash;</button>
    <span class="chip chip-tps">-- tok/s</span>
    <button type="button" class="chip chip-mute" data-muted="false" aria-pressed="false">&#128266;</button>
  `;

  const offlineChip = container.querySelector<HTMLElement>('.chip-offline')!;
  const warmChip = container.querySelector<HTMLButtonElement>('.chip-warm-offline')!;
  const tierChip = container.querySelector<HTMLButtonElement>('.chip-tier')!;
  const tpsChip = container.querySelector<HTMLElement>('.chip-tps')!;
  const muteChip = container.querySelector<HTMLButtonElement>('.chip-mute')!;

  let currentTier: ModelTier = 'E2B';
  let currentPack = 'sandia';
  let modelReady = false;
  let switching = false;
  let muted = false;
  // SW registered + model downloaded does NOT mean truly offline-ready: map
  // packs are read via pmtiles Range requests (only ever cache partial 206
  // responses — see src/map/warm.ts) and kokoro's ~86MB loads lazily from HF
  // CDN on first use, neither of which happens just from booting the model.
  // The badge only goes green once checkOfflineReady() confirms it for real.
  let offlineWarmed = false;
  let warming = false;

  function refreshOfflineBadge(): void {
    warmChip.hidden = !modelReady || offlineWarmed;
    if (offlineWarmed) {
      offlineChip.dataset.state = 'ready';
      offlineChip.textContent = '⬢ OFFLINE-READY';
    } else {
      offlineChip.dataset.state = 'pending';
      offlineChip.textContent = navigator.onLine ? '⬡ online (downloading ok)' : '⬡ offline (waiting for network)';
    }
  }

  warmChip.addEventListener('click', () => {
    if (warming || offlineWarmed) return;
    warming = true;
    warmChip.textContent = 'downloading…';
    warmChip.disabled = true;
    Promise.all([warmPack(currentPack), warmKokoroCache()])
      .then(async ([packResults, kokoroOk]) => {
        const packOk = packResults.every((r) => r.ok);
        if (!packOk || !kokoroOk) {
          console.warn('[helius] offline warm-up incomplete', { packResults, kokoroOk });
          warmChip.textContent = 'Download for offline (retry)';
          return;
        }
        // Final truth check — not just "did our own warm calls report
        // success", but does Cache Storage + the SW controller actually back
        // it up right now.
        const result = await checkOfflineReady(currentPack);
        offlineWarmed = result.ok;
        if (!result.ok) {
          console.warn('[helius] checkOfflineReady still not ok after warm-up', result.missing);
          warmChip.textContent = 'Download for offline (retry)';
        }
      })
      .catch((err) => {
        console.warn('[helius] offline warm-up failed', err);
        warmChip.textContent = 'Download for offline (retry)';
      })
      .finally(() => {
        warming = false;
        warmChip.disabled = false;
        refreshOfflineBadge();
      });
  });

  function renderTierChip(tier: ModelTier, degraded: boolean): void {
    tierChip.dataset.tier = tier;
    tierChip.innerHTML = degraded
      ? `GEMMA 4 &middot; ${tier} <span class="tier-degrade">&middot; text</span>`
      : `GEMMA 4 &middot; ${tier}`;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', refreshOfflineBadge);
  }
  window.addEventListener('online', refreshOfflineBadge);
  window.addEventListener('offline', refreshOfflineBadge);

  function handleEngineStatus(status: EngineStatus): void {
    if (status.state === 'ready') {
      modelReady = true;
      currentTier = status.tier;
      switching = false;
      tierChip.dataset.switching = 'false';
      renderTierChip(status.tier, readTextOnlyDegrade(status));
    }
    refreshOfflineBadge();
  }

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
    offlineWarmed = false; // the new pack's assets haven't been warmed yet
    refreshOfflineBadge();
  }

  refreshOfflineBadge();

  return { el: container, handleEngineStatus, setStats, setPack };
}
