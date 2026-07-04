// 'route' AgentEvent handling: a toast over the map area. Used to also draw
// an animated dashed placeholder line standing in for a real polyline — now
// that src/map/render.ts's HeliusMap draws the real thing (wired in
// main.ts), that placeholder was retired; this is toast-only.

import type { AgentEvent } from '../lib/contract';
import { formatClock } from './dom';

export interface RouteHandle {
  handleEvent(e: AgentEvent): void;
  /** Hides the toast — called on a pack switch, since a route drawn for the
   *  old region no longer means anything for the new one. */
  clear(): void;
}

// e.g. 127.66249996948243 -> "~2h 8m"; 62.4 -> "62min". Rounds once and
// reuses that same integer for the arrival-time math below, so the two
// numbers in the toast never disagree over a fraction of a minute.
function formatEta(rawMinutes: number): { text: string; minutes: number } {
  const minutes = Math.round(rawMinutes);
  if (minutes >= 90) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return { text: `~${hours}h ${mins}m`, minutes };
  }
  return { text: `${minutes}min`, minutes };
}

export function mountRoute(container: HTMLElement): RouteHandle {
  container.innerHTML = `<div class="route-toast" hidden></div>`;
  const toast = container.querySelector<HTMLElement>('.route-toast')!;

  function handleEvent(e: AgentEvent): void {
    if (e.type !== 'route') return;
    const km = (e.distanceM / 1000).toFixed(1);
    const eta = formatEta(e.etaMin);
    const arrival = formatClock(new Date(Date.now() + eta.minutes * 60000));
    toast.textContent = `ROUTE READY — ${km}km · ${eta.text} · arrives ${arrival}`;
    toast.hidden = false;
  }

  function clear(): void {
    toast.hidden = true;
  }

  return { handleEvent, clear };
}
