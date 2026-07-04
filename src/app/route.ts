// 'route' AgentEvent handling: a toast over the map area + an animated
// dashed placeholder line, standing in until a real MapLibre polyline lands.

import type { AgentEvent } from '../lib/contract';
import { formatClock } from './dom';

export interface RouteHandle {
  handleEvent(e: AgentEvent): void;
}

export function mountRoute(container: HTMLElement): RouteHandle {
  container.innerHTML = `
    <div class="route-toast" hidden></div>
    <svg class="route-line-layer" hidden viewBox="0 0 100 100" preserveAspectRatio="none">
      <line x1="12" y1="88" x2="88" y2="16" />
    </svg>
  `;
  const toast = container.querySelector<HTMLElement>('.route-toast')!;
  const lineLayer = container.querySelector<SVGElement>('.route-line-layer')!;

  function handleEvent(e: AgentEvent): void {
    if (e.type !== 'route') return;
    const km = (e.distanceM / 1000).toFixed(1);
    const arrival = formatClock(new Date(Date.now() + e.etaMin * 60000));
    toast.textContent = `ROUTE READY — ${km}km · ${e.etaMin}min · arrives ${arrival}`;
    toast.hidden = false;
    // SVGElement doesn't carry the `.hidden` IDL property in lib.dom.d.ts (only
    // HTMLElement does), but the `hidden` content attribute's UA styling
    // (display:none) applies to any element — toggle it as an attribute instead.
    lineLayer.removeAttribute('hidden');
  }

  return { handleEvent };
}
