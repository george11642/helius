// Position/coverage chip over the map: renders the LAST authoritative locate
// result (the tool's own summary string — never model prose) so coverage
// honesty ("in coverage" vs "X km off coverage" vs "no position fix") is
// always visible, not buried in a chat bubble. Also flips to a warning when
// route_back reports it cannot honestly produce a route.

import type { AgentEvent } from '../lib/contract';

export interface PosChipHandle {
  handleEvent(e: AgentEvent): void;
}

const WARN_RE = /off coverage|out_of_coverage|off_network|no position fix|no fix/i;

export function mountPosChip(container: HTMLElement): PosChipHandle {
  const chip = document.createElement('div');
  chip.className = 'pos-chip';
  chip.hidden = true;
  container.appendChild(chip);

  function set(text: string, warn: boolean): void {
    chip.textContent = text;
    chip.dataset.state = warn ? 'warn' : 'ok';
    chip.hidden = false;
  }

  function handleEvent(e: AgentEvent): void {
    if (e.type === 'pack-changed') {
      // The last locate summary describes the OLD pack's fix/coverage — a
      // stale claim after a region switch. Hide until the next locate().
      chip.hidden = true;
    } else if (e.type === 'tool-done' && e.name === 'locate') {
      set(e.summary, WARN_RE.test(e.summary));
    } else if (e.type === 'tool-done' && e.name === 'route_back' && WARN_RE.test(e.summary)) {
      set(e.summary, true);
    } else if (e.type === 'tool-error' && (e.name === 'locate' || e.name === 'route_back')) {
      set(`${e.name}: ${e.message}`, true);
    }
  }

  return { handleEvent };
}
