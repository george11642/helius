// Full-screen model-boot overlay: shown until the engine reaches
// EngineStatus 'ready', then fades out. This is the very first thing a judge
// sees, so it has to read as "serious instrument booting up", not a spinner.

import type { EngineStatus } from '../lib/contract';

export interface BootHandle {
  el: HTMLElement;
  handleStatus(status: EngineStatus): void;
}

function formatMb(mbDone?: number, mbTotal?: number): string {
  if (mbDone === undefined || mbTotal === undefined) return '';
  return `${mbDone.toFixed(0)} / ${mbTotal.toFixed(0)} MB`;
}

export function mountBoot(): BootHandle {
  const el = document.createElement('div');
  el.className = 'boot-overlay';
  el.dataset.state = 'idle';
  el.innerHTML = `
    <div class="boot-card">
      <div class="boot-sun">&#9728;</div>
      <div class="boot-title">HELIUS</div>
      <div class="boot-state-label">starting&hellip;</div>
      <div class="boot-progress"><div class="boot-progress-fill"></div></div>
      <div class="boot-progress-meta"></div>
      <div class="boot-spinner" hidden></div>
      <div class="boot-footnote">3.4 GB &mdash; downloads once, then works offline forever</div>
      <div class="boot-error" hidden>
        <div class="boot-error-message"></div>
        <button type="button" class="boot-retry-btn">Retry</button>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  const stateLabel = el.querySelector<HTMLElement>('.boot-state-label')!;
  const progress = el.querySelector<HTMLElement>('.boot-progress')!;
  const progressFill = el.querySelector<HTMLElement>('.boot-progress-fill')!;
  const progressMeta = el.querySelector<HTMLElement>('.boot-progress-meta')!;
  const spinner = el.querySelector<HTMLElement>('.boot-spinner')!;
  const footnote = el.querySelector<HTMLElement>('.boot-footnote')!;
  const errorBox = el.querySelector<HTMLElement>('.boot-error')!;
  const errorMessage = el.querySelector<HTMLElement>('.boot-error-message')!;
  const retryBtn = el.querySelector<HTMLButtonElement>('.boot-retry-btn')!;
  retryBtn.addEventListener('click', () => location.reload());

  function handleStatus(status: EngineStatus): void {
    el.dataset.state = status.state;
    errorBox.hidden = status.state !== 'error';

    if (status.state === 'idle') {
      stateLabel.textContent = 'starting…';
      progress.hidden = false;
      spinner.hidden = true;
    } else if (status.state === 'downloading') {
      progress.hidden = false;
      spinner.hidden = true;
      stateLabel.textContent = status.file ? `downloading ${status.file}…` : 'downloading model…';
      progressFill.style.width = `${Math.max(0, Math.min(100, status.pct))}%`;
      progressMeta.textContent = `${status.pct.toFixed(0)}%  ${formatMb(status.mbDone, status.mbTotal)}`.trim();
    } else if (status.state === 'compiling') {
      progress.hidden = true;
      spinner.hidden = false;
      stateLabel.textContent = 'compiling WebGPU shaders…';
      progressMeta.textContent = '';
    } else if (status.state === 'ready') {
      stateLabel.textContent = `ready — ${status.tier} in ${(status.loadMs / 1000).toFixed(1)}s`;
      footnote.hidden = true;
      el.classList.add('is-fading');
      window.setTimeout(() => {
        el.hidden = true;
      }, 400);
    } else if (status.state === 'error') {
      progress.hidden = true;
      spinner.hidden = true;
      el.classList.remove('is-fading');
      el.hidden = false;
      errorMessage.textContent = status.message;
    }
  }

  return { el, handleStatus };
}
