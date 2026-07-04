// Header chip for the online planning feature: "PLAN BRIEF" while a planning
// key is configured (or ?brief=mock), "BRIEF ✓" once a brief is cached for
// the active pack, hidden entirely when the feature isn't available and
// nothing is cached — the offline product must look complete without it.
// Self-contained on purpose: it appends itself to the header row and injects
// its own few style rules so main.ts only needs a one-line mount and no other
// module (shell.ts, style.css — owned by other workstreams) changes.

import { briefConfigured, getCachedBrief, isBriefMockMode, isOnline, prepareBrief } from './index';
import { getPack } from '../tools/tools';

const STYLE = `
.brief-chip { cursor: pointer; }
.brief-chip[data-state='busy'] { opacity: 0.6; cursor: wait; }
.brief-chip[data-state='cached'] { border-color: #3fa34d; color: #7fd18a; }
.brief-chip[data-state='error'] { border-color: #b3423a; color: #e08a84; }
`;

export function mountBrief(): void {
  const host = document.querySelector<HTMLElement>('.header-row') ?? document.body;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'chip brief-chip';
  btn.type = 'button';
  btn.hidden = true;
  host.appendChild(btn);

  const mock = isBriefMockMode();
  let available = mock; // becomes true if the endpoint reports a configured key
  let busy = false;

  function render(): void {
    if (busy) return; // click handler owns the label while a request is in flight
    const cached = getCachedBrief(getPack());
    if (cached) {
      btn.hidden = false;
      btn.dataset.state = 'cached';
      btn.textContent = 'BRIEF ✓';
      btn.title = `Mission briefing cached for ${cached.destination} (prepared online — works offline). Click to refresh.`;
      return;
    }
    if (!available) {
      btn.hidden = true; // no key, no cache — feature invisible
      return;
    }
    btn.hidden = false;
    btn.dataset.state = 'ready';
    btn.textContent = 'PLAN BRIEF';
    btn.title = 'Prepare an online mission briefing for this region — cached on-device for offline use.';
  }

  btn.addEventListener('click', () => {
    if (busy) return;
    if (!isOnline() && !mock) {
      btn.dataset.state = 'error';
      btn.textContent = 'OFFLINE — NO PLANNING';
      window.setTimeout(render, 2500);
      return;
    }
    busy = true;
    btn.dataset.state = 'busy';
    btn.textContent = 'PLANNING…';
    prepareBrief(getPack(), { mock })
      .then((brief) => {
        console.log('BRIEF:' + JSON.stringify({ packId: brief.packId, model: brief.model, destination: brief.destination }));
      })
      .catch((err) => {
        console.warn('[helius] prepareBrief failed', err);
        btn.dataset.state = 'error';
        btn.textContent = 'BRIEF FAILED';
        if (String(err).includes('not_configured')) available = false;
        window.setTimeout(() => {
          busy = false;
          render();
        }, 2500);
        return null;
      })
      .then((brief) => {
        if (brief !== null) {
          busy = false;
          render();
        }
      });
  });

  render(); // show cached state immediately (works offline)
  void briefConfigured().then((configured) => {
    if (configured) available = true;
    render();
  });
  // Cheap poll keeps the label in sync with pack switches without needing a
  // hook into main.ts's dispatch (that seam belongs to another workstream).
  window.setInterval(render, 3000);
}
