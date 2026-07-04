// Onboarding gate + boot progress overlay. Two modes, one element:
//
//   instant:true  — today's judge/video path (?demo=1 / ?devloc / ?fix /
//                   ?mock=1): no gate, just the compact boot card with staged
//                   progress; the model autoloads exactly as before.
//   instant:false — first-run onboarding: brand hero → region-pack cards
//                   (usable BEFORE any model bytes move) → honest capability
//                   verdict from the pre-flight → an explicit "Load the AI"
//                   button. Returning users whose weights are already fully
//                   resident in OPFS skip straight into the load (seconds).
//
// Everything renders from typed engine-status events (contract.ts) — no
// polling, no guessed numbers. Error states carry actionable next steps.

import type { EngineStatus, PackInfo, DeviceCaps, CapabilityVerdict } from '../lib/contract';
import { checkOfflineReady } from '../map/warm';
import { briefConfigured, getCachedBrief, isBriefMockMode, isOnline, prepareBrief } from '../brief/index';
import type { MissionBrief } from '../brief/index';

export interface OnboardingOptions {
  /** True for the deterministic demo/judge path — skip the gate entirely. */
  instant: boolean;
  /** User pressed "Load the AI" (or a fully-cached returning user auto-continued). */
  onStartLoad(): void;
  /** User chose map-only mode (unsupported device, or explicit choice). */
  onMapOnly(): void;
  /** User picked a region pack card (fires only when it differs from current). */
  onPackChosen(packId: string): void;
}

export interface OnboardingHandle {
  el: HTMLElement;
  handleStatus(status: EngineStatus): void;
  setPacks(packs: PackInfo[], currentId: string): void;
}

// Static display metadata for the pack cards (mirrors the pack manifests —
// the honest sizes/regions; PackInfo carries id/name/totalBytes).
const PACK_META: Record<string, { region: string; terrain: string }> = {
  sandia: { region: 'New Mexico, USA', terrain: 'granite crest · 3,255 m' },
  chamonix: { region: 'Haute-Savoie, France', terrain: 'alpine valley · 4,809 m' },
  fontainebleau: { region: 'Île-de-France, France', terrain: 'forest & boulders · 130 m' },
  yosemite: { region: 'California, USA', terrain: 'granite domes · 2,694 m' },
  zermatt: { region: 'Valais, Switzerland', terrain: 'alpine peaks · 4,478 m' },
  'grand-canyon': { region: 'Arizona, USA', terrain: 'canyon corridor · 2,210 m' },
  fuji: { region: 'Yamanashi, Japan', terrain: 'volcanic cone · 3,776 m' },
  'ben-nevis': { region: 'Highlands, Scotland', terrain: 'munro & glen · 1,345 m' },
  pecos: { region: 'New Mexico, USA', terrain: 'alpine wilderness · 3,844 m' },
};

// Auto-continue threshold vs. caps.modelResidentMB — which the pre-flight now
// scopes to the E2B tier's own OPFS directory (src/llm/preflight.ts), so other
// tiers' files can't trip this. ~3244 MB measured asset sum; the ~1.4% slack
// absorbs minor config drift. Must stay in sync with FULLY_RESIDENT_BYTES there.
const MODEL_FULL_MB = 3200; // measured E2B q4f16 footprint; >= this ⇒ fully resident

function fmtGb(mb: number): string {
  return `${(mb / 1000).toFixed(1)} GB`;
}

function fmtPackSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function mountOnboarding(opts: OnboardingOptions): OnboardingHandle {
  const el = document.createElement('div');
  el.className = 'boot-overlay';
  el.dataset.mode = opts.instant ? 'instant' : 'gate';
  el.dataset.phase = opts.instant ? 'progress' : 'hero';
  el.innerHTML = `
    <div class="onb-scroll">
      <div class="onb-hero" ${opts.instant ? 'hidden' : ''}>
        <div class="boot-sun">&#9728;</div>
        <div class="boot-title">HELIUS</div>
        <p class="onb-pitch">An offline navigation &amp; signaling agent — Gemma runs entirely on this device. No cloud, no account, no signal required.</p>

        <div class="onb-section-label">REGION PACK</div>
        <div class="onb-packs"><div class="onb-packs-loading">loading region packs&hellip;</div></div>
        <div class="onb-brief-row" hidden>
          <button type="button" class="onb-brief-btn">PREPARE MISSION BRIEFING</button>
          <button type="button" class="onb-brief-view" hidden>VIEW BRIEFING</button>
        </div>

        <div class="onb-section-label">THIS DEVICE</div>
        <div class="onb-verdict" data-verdict="checking">
          <div class="onb-verdict-line">checking device capability&hellip;</div>
          <ul class="onb-verdict-reasons" hidden></ul>
        </div>

        <div class="onb-actions">
          <button type="button" class="onb-load-btn" disabled>LOAD THE AI &mdash; ~3.4 GB &middot; Wi&#8209;Fi recommended</button>
          <button type="button" class="onb-maponly-btn">Continue in map-only mode</button>
        </div>
        <div class="onb-footnote">Downloads once, resumes if interrupted, then works offline forever.</div>
      </div>

      <div class="boot-card" ${opts.instant ? '' : 'hidden'}>
        <div class="boot-sun">&#9728;</div>
        <div class="boot-title">HELIUS</div>
        <div class="boot-state-label">starting&hellip;</div>
        <div class="boot-progress"><div class="boot-progress-fill"></div></div>
        <div class="boot-progress-meta"></div>
        <div class="boot-substage"></div>
        <div class="boot-spinner" hidden></div>
        <div class="boot-footnote">Downloads once &mdash; resumable, then works offline forever</div>
        <div class="boot-error" hidden>
          <div class="boot-error-message"></div>
          <div class="boot-error-steps">
            If this repeats: check your connection and retry &mdash; the download resumes where it stopped.
            Still stuck? Clear this site's data and reload, or continue in map-only mode.
          </div>
          <div class="boot-error-actions">
            <button type="button" class="boot-retry-btn">Retry</button>
            <button type="button" class="boot-maponly-btn">Map-only mode</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  const hero = el.querySelector<HTMLElement>('.onb-hero')!;
  const packsEl = el.querySelector<HTMLElement>('.onb-packs')!;
  const briefRow = el.querySelector<HTMLElement>('.onb-brief-row')!;
  const briefBtn = el.querySelector<HTMLButtonElement>('.onb-brief-btn')!;
  const briefView = el.querySelector<HTMLButtonElement>('.onb-brief-view')!;
  const verdictBox = el.querySelector<HTMLElement>('.onb-verdict')!;
  const verdictLine = el.querySelector<HTMLElement>('.onb-verdict-line')!;
  const verdictReasons = el.querySelector<HTMLUListElement>('.onb-verdict-reasons')!;
  const loadBtn = el.querySelector<HTMLButtonElement>('.onb-load-btn')!;
  const mapOnlyBtn = el.querySelector<HTMLButtonElement>('.onb-maponly-btn')!;

  const card = el.querySelector<HTMLElement>('.boot-card')!;
  const stateLabel = el.querySelector<HTMLElement>('.boot-state-label')!;
  const progress = el.querySelector<HTMLElement>('.boot-progress')!;
  const progressFill = el.querySelector<HTMLElement>('.boot-progress-fill')!;
  const progressMeta = el.querySelector<HTMLElement>('.boot-progress-meta')!;
  const substage = el.querySelector<HTMLElement>('.boot-substage')!;
  const spinner = el.querySelector<HTMLElement>('.boot-spinner')!;
  const footnote = el.querySelector<HTMLElement>('.boot-footnote')!;
  const errorBox = el.querySelector<HTMLElement>('.boot-error')!;
  const errorMessage = el.querySelector<HTMLElement>('.boot-error-message')!;

  el.querySelector<HTMLButtonElement>('.boot-retry-btn')!.addEventListener('click', () => location.reload());
  el.querySelector<HTMLButtonElement>('.boot-maponly-btn')!.addEventListener('click', () => dismissToMapOnly());
  mapOnlyBtn.addEventListener('click', () => dismissToMapOnly());

  let currentPackId = 'sandia';
  let started = opts.instant; // instant mode: the load already runs (autoload)
  let dismissed = false;

  function dismiss(): void {
    if (dismissed) return;
    dismissed = true;
    el.classList.add('is-fading');
    window.setTimeout(() => {
      el.hidden = true;
    }, 400);
  }

  function dismissToMapOnly(): void {
    opts.onMapOnly();
    dismiss();
  }

  function showProgressPhase(): void {
    el.dataset.phase = 'progress';
    hero.hidden = true;
    card.hidden = false;
  }

  function startLoad(): void {
    if (started) return;
    started = true;
    showProgressPhase();
    opts.onStartLoad();
  }

  loadBtn.addEventListener('click', startLoad);

  // ---- region pack cards ----------------------------------------------------

  function renderBriefRow(): void {
    const cached = getCachedBrief(currentPackId);
    briefView.hidden = !cached;
    briefView.textContent = cached ? `VIEW BRIEFING · ${cached.destination}` : 'VIEW BRIEFING';
  }

  function setPacks(packs: PackInfo[], currentId: string): void {
    currentPackId = currentId;
    packsEl.innerHTML = packs
      .map((p) => {
        const meta = PACK_META[p.id];
        const brief = getCachedBrief(p.id);
        return `
          <button type="button" class="onb-pack-card" data-pack="${p.id}" data-selected="${p.id === currentId}">
            <span class="onb-pack-name">${p.name.toUpperCase()}</span>
            <span class="onb-pack-region">${meta?.region ?? ''}</span>
            <span class="onb-pack-terrain">${meta?.terrain ?? ''}</span>
            <span class="onb-pack-size">${fmtPackSize(p.totalBytes)} map pack</span>
            <span class="onb-pack-badges">
              <span class="onb-pack-badge onb-pack-offline" hidden>&#x2B22; OFFLINE</span>
              ${brief ? '<span class="onb-pack-badge onb-pack-brief">BRIEF &#10003;</span>' : ''}
            </span>
          </button>`;
      })
      .join('');

    // Honest downloaded/offline badge per pack — Cache-Storage query, best-effort.
    for (const cardEl of packsEl.querySelectorAll<HTMLElement>('.onb-pack-card')) {
      const id = cardEl.dataset.pack!;
      void checkOfflineReady(id)
        .then((r) => {
          if (r.ok) cardEl.querySelector<HTMLElement>('.onb-pack-offline')!.hidden = false;
        })
        .catch(() => {});
    }

    packsEl.querySelectorAll<HTMLButtonElement>('.onb-pack-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.pack!;
        if (id === currentPackId) return;
        currentPackId = id;
        packsEl
          .querySelectorAll<HTMLElement>('.onb-pack-card')
          .forEach((c) => (c.dataset.selected = String(c.dataset.pack === id)));
        renderBriefRow();
        opts.onPackChosen(id);
      });
    });

    renderBriefRow();
  }

  // ---- mission briefing (optional online feature; hidden when unconfigured) --

  const briefMock = isBriefMockMode();
  void briefConfigured()
    .then((configured) => {
      if (configured || briefMock) briefRow.hidden = false;
      renderBriefRow();
    })
    .catch(() => {});
  // A cached brief is viewable offline even when the endpoint is unreachable.
  if (getCachedBrief(currentPackId)) briefRow.hidden = false;

  briefBtn.addEventListener('click', () => {
    if (!isOnline() && !briefMock) {
      briefBtn.textContent = 'OFFLINE — PLANNING NEEDS A CONNECTION';
      window.setTimeout(() => (briefBtn.textContent = 'PREPARE MISSION BRIEFING'), 2500);
      return;
    }
    briefBtn.disabled = true;
    briefBtn.textContent = 'PREPARING…';
    prepareBrief(currentPackId, { mock: briefMock })
      .then(() => {
        briefBtn.textContent = 'BRIEFING READY ✓';
        renderBriefRow();
      })
      .catch((err) => {
        console.warn('[helius] prepareBrief failed', err);
        briefBtn.textContent = 'BRIEFING FAILED — RETRY';
      })
      .finally(() => {
        briefBtn.disabled = false;
        window.setTimeout(() => (briefBtn.textContent = 'PREPARE MISSION BRIEFING'), 4000);
      });
  });

  briefView.addEventListener('click', () => {
    const cached = getCachedBrief(currentPackId);
    if (cached) showBriefModal(cached);
  });

  // ---- capability verdict -----------------------------------------------------

  function renderVerdict(v: CapabilityVerdict, caps: DeviceCaps): void {
    verdictBox.dataset.verdict = v;
    verdictReasons.innerHTML = caps.reasons.map((r) => `<li>${r}</li>`).join('');
    verdictReasons.hidden = caps.reasons.length === 0;

    const resident = caps.modelResidentMB;
    if (v === 'unsupported') {
      verdictLine.textContent = '✕ This device cannot run the on-device model';
      if (caps.webgpu) {
        loadBtn.disabled = false;
        loadBtn.classList.add('onb-load-btn-secondary');
        loadBtn.innerHTML = 'Try loading anyway';
      } else {
        // No WebGPU adapter: the worker-side backstop hard-refuses too, so an
        // override is structurally impossible — don't offer a button that can
        // only ever flip the screen to an error card.
        loadBtn.hidden = true;
      }
      mapOnlyBtn.classList.add('onb-maponly-primary');
      return;
    }

    loadBtn.disabled = false;
    if (resident >= MODEL_FULL_MB) {
      // Fully cached returning user: skip straight in.
      verdictLine.textContent = '✓ Model already on this device — starting';
      startLoad();
      return;
    }
    verdictLine.textContent =
      v === 'go' ? '✓ This device can run Gemma on-device' : '⚠ Marginal GPU limits — the load may fail at compile';
    if (resident > 50) {
      loadBtn.innerHTML = `RESUME DOWNLOAD &mdash; ${fmtGb(resident)} of 3.4 GB already on device`;
    } else if (v === 'degraded') {
      loadBtn.innerHTML = 'LOAD THE AI ANYWAY &mdash; ~3.4 GB &middot; Wi&#8209;Fi recommended';
    }
  }

  // ---- engine status ----------------------------------------------------------

  function handleStatus(status: EngineStatus): void {
    el.dataset.state = status.state;
    errorBox.hidden = status.state !== 'error';

    if (status.state === 'preflight') {
      renderVerdict(status.verdict, status.caps);
      if (opts.instant && status.verdict === 'unsupported' && !dismissed) {
        // Instant flow assumes an autoload will drive the boot card — but an
        // 'unsupported' verdict VETOES the autoload (agent emits 'idle' next),
        // and the buttonless card would sit at "starting…" forever. Fall back
        // to the gate: the hero carries the verdict, the override button (when
        // it can work) and the map-only escape.
        el.dataset.mode = 'gate';
        el.dataset.phase = 'hero';
        hero.hidden = false;
        card.hidden = true;
        started = false; // the autoload never started — let the button fire
      }
      return;
    }
    if (status.state === 'idle') {
      // Map-only boot settled (autoload off / vetoed) — the gate stays up
      // waiting for the user's explicit choice. Nothing to render.
      return;
    }

    // Any active load state means bytes are moving — make sure the progress
    // card is what's visible (covers mock mode and autoload paths where the
    // load starts without the button).
    if (status.state === 'downloading' || status.state === 'compiling') {
      started = true;
      if (el.dataset.phase !== 'progress') showProgressPhase();
    }

    if (status.state === 'downloading') {
      progress.hidden = false;
      spinner.hidden = true;
      if (status.stage === 'read') {
        stateLabel.textContent = 'loading model from device…';
        substage.textContent = 'weights already downloaded — reading local bytes';
      } else {
        stateLabel.textContent = status.file ? `downloading ${status.file}…` : 'downloading model…';
        const files =
          status.filesTotal !== undefined && status.filesDone !== undefined
            ? ` · file ${Math.min(status.filesDone + 1, status.filesTotal)}/${status.filesTotal}`
            : '';
        substage.textContent = `resumable — safe to close and come back${files}`;
      }
      progressFill.style.width = `${Math.max(0, Math.min(100, status.pct))}%`;
      const mb =
        status.mbDone !== undefined && status.mbTotal !== undefined
          ? `  ${status.mbDone.toFixed(0)} / ${status.mbTotal.toFixed(0)} MB`
          : '';
      progressMeta.textContent = `${status.pct.toFixed(0)}%${mb}`;
    } else if (status.state === 'compiling') {
      progress.hidden = true;
      spinner.hidden = false;
      stateLabel.textContent = 'compiling WebGPU shaders…';
      progressMeta.textContent = '';
      substage.textContent = '';
    } else if (status.state === 'ready') {
      stateLabel.textContent = `ready — ${status.tier} in ${(status.loadMs / 1000).toFixed(1)}s`;
      footnote.hidden = true;
      dismiss();
    } else if (status.state === 'error') {
      showProgressPhase();
      progress.hidden = true;
      spinner.hidden = true;
      el.classList.remove('is-fading');
      el.hidden = false;
      dismissed = false;
      errorMessage.textContent = status.message;
    }
  }

  return { el, handleStatus, setPacks };
}

// ---- brief viewer modal (works fully offline — reads the localStorage cache) --

/** HTML-escape a brief string. Every string in a MissionBrief is Nemotron
 *  (LLM) output relayed by /api/brief — length-capped in normalizeBrief but
 *  otherwise untrusted, so it must never reach innerHTML unescaped. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** ISO timestamps render as local clock time; non-ISO strings pass through. */
function fmtBriefTime(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Items must already be escaped (or composed from escaped parts) by the caller. */
function section(title: string, items: string[]): string {
  if (!items.length) return '';
  return `<div class="brief-section"><div class="brief-section-title">${title}</div><ul>${items
    .map((i) => `<li>${i}</li>`)
    .join('')}</ul></div>`;
}

export function showBriefModal(brief: MissionBrief): void {
  document.querySelector('.brief-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'brief-modal';
  modal.innerHTML = `
    <div class="brief-modal-card">
      <button type="button" class="brief-modal-close" aria-label="Close">&times;</button>
      <div class="brief-modal-title">MISSION BRIEFING — ${esc(brief.destination)}</div>
      <div class="brief-modal-meta">prepared ${new Date(brief.generatedAt).toLocaleString()} · cached on-device, readable offline</div>
      <p class="brief-summary">${esc(brief.summary)}</p>
      <div class="brief-section"><div class="brief-section-title">DAYLIGHT</div>
        <ul><li>Sunset ${esc(fmtBriefTime(brief.daylight.sunset))} — turn around by <strong>${esc(fmtBriefTime(brief.daylight.turnaroundBy))}</strong></li><li>${esc(brief.daylight.note)}</li></ul>
      </div>
      ${section('ROUTE PLAN', brief.route.map(esc))}
      ${section('BAIL-OUTS (ranked)', brief.bailouts.map((b) => esc(`${b.name} — ${b.why ?? ''}`)))}
      ${section('WATER', brief.water.map(esc))}
      ${section('GEAR', brief.gear.map(esc))}
      ${section('TERRAIN CAUTIONS', brief.terrain.map(esc))}
      ${section('SIGNAL COVERAGE', brief.signal.map(esc))}
      ${section('LOCAL PHRASES', brief.phrases.map((p) => `<em>${esc(p.local)}</em> — ${esc(p.english)}`))}
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) close();
  });
  modal.querySelector<HTMLButtonElement>('.brief-modal-close')!.addEventListener('click', close);
}
