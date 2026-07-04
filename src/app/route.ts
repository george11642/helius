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

export function mountRoute(container: HTMLElement): RouteHandle {
  container.innerHTML = `<div class="route-toast" hidden></div>`;
  const toast = container.querySelector<HTMLElement>('.route-toast')!;

  function handleEvent(e: AgentEvent): void {
    if (e.type !== 'route') return;
    const km = (e.distanceM / 1000).toFixed(1);
    const arrival = formatClock(new Date(Date.now() + e.etaMin * 60000));
    toast.textContent = `ROUTE READY — ${km}km · ${e.etaMin}min · arrives ${arrival}`;
    toast.hidden = false;
  }

  function clear(): void {
    toast.hidden = true;
  }

  return { handleEvent, clear };
}
