// The tool-trace rail: a horizontal chip chain showing the agent's live
// tool-call chain (locate() -> sun_clock() -> route_back() -> ...). This is
// the hero element for the demo video — it's what makes "agentic" visible
// instead of inferred. Every event is also mirrored to console.log('TRACE:…')
// so it doubles as a hook for video/verification tooling.

import type { AgentEvent } from '../lib/contract';

export interface TraceHandle {
  el: HTMLElement;
  handleEvent(e: AgentEvent): void;
}

const DIM_AFTER_MS = 8000;

export function mountTrace(container: HTMLElement): TraceHandle {
  container.innerHTML = `<div class="trace-rail-inner"></div>`;
  const inner = container.querySelector<HTMLElement>('.trace-rail-inner')!;

  const chipsByStep = new Map<number, HTMLElement>();
  let dimTimer: number | undefined;
  let chipCountThisTurn = 0;

  function clearDimTimer(): void {
    if (dimTimer !== undefined) {
      window.clearTimeout(dimTimer);
      dimTimer = undefined;
    }
  }

  function startFreshRail(): void {
    clearDimTimer();
    inner.innerHTML = '';
    chipsByStep.clear();
    chipCountThisTurn = 0;
    container.classList.remove('is-dimmed');
    container.hidden = true;
  }

  function appendChip(name: string, step: number): HTMLElement {
    if (inner.children.length > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'trace-arrow';
      arrow.textContent = '→';
      inner.appendChild(arrow);
      // Light the arrow a beat after insertion so multiple fast-arriving
      // chips read as a left-to-right cascade rather than popping in at once.
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => arrow.classList.add('is-lit')));
    }
    const chip = document.createElement('div');
    chip.className = 'trace-chip';
    chip.dataset.state = 'running';
    chip.dataset.step = String(step);
    chip.innerHTML = `
      <span class="trace-chip-name">${name}()</span>
      <span class="trace-chip-summary"></span>
      <span class="trace-chip-ms"></span>
    `;
    inner.appendChild(chip);
    chipsByStep.set(step, chip);
    container.hidden = false;
    container.classList.remove('is-dimmed');
    inner.scrollLeft = inner.scrollWidth;
    return chip;
  }

  function handleEvent(e: AgentEvent): void {
    if (e.type === 'agent-turn-start') {
      startFreshRail();
      return;
    }
    if (e.type === 'agent-turn-done') {
      if (chipCountThisTurn > 0) {
        clearDimTimer();
        dimTimer = window.setTimeout(() => container.classList.add('is-dimmed'), DIM_AFTER_MS);
      }
      return;
    }
    if (e.type === 'tool-start') {
      console.log('TRACE:' + JSON.stringify(e));
      chipCountThisTurn += 1;
      appendChip(e.call.name, e.step);
      return;
    }
    if (e.type === 'tool-done') {
      console.log('TRACE:' + JSON.stringify(e));
      const chip = chipsByStep.get(e.step);
      if (!chip) return;
      chip.dataset.state = 'done';
      chip.querySelector('.trace-chip-summary')!.textContent = e.summary;
      chip.querySelector('.trace-chip-ms')!.textContent = `${e.ms}ms`;
      return;
    }
    if (e.type === 'tool-error') {
      console.log('TRACE:' + JSON.stringify(e));
      const chip = chipsByStep.get(e.step);
      if (!chip) return;
      chip.dataset.state = 'error';
      chip.querySelector('.trace-chip-summary')!.textContent = e.message;
      return;
    }
  }

  return { el: container, handleEvent };
}
