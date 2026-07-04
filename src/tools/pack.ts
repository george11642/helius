// Active region pack (the map + routing dataset under /data/packs/<pack>/).
// createHelius sets it once at startup; the route_back tool and the map layer
// both read it, so swapping regions is a single call with no other coupling.

let activePack = 'sandia';

export function setPack(pack: string): void {
  activePack = pack;
}

export function getPack(): string {
  return activePack;
}
