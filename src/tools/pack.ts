// Active region pack (the map + routing dataset under /data/packs/<pack>/).
// createHelius sets it at startup; the façade's switchPack() changes it. The
// route_back tool and the map layer both read getPack(), so swapping regions is
// a single call. This module also owns the pack list (manifest metadata) and a
// sensible per-pack starting fix for demo mode.

import type { PackInfo } from '../lib/contract';
import type { GpsFix } from './location';

const PACK_IDS = [
  'sandia',
  'chamonix',
  'fontainebleau',
  'yosemite',
  'zermatt',
  'grand-canyon',
  'fuji',
  'ben-nevis',
  'pecos',
] as const;

let activePack: string = 'sandia';

export function setPack(pack: string): void {
  activePack = pack;
}

export function getPack(): string {
  return activePack;
}

// Demo-mode starting fix per pack (real GPS overrides this in the field).
const DEFAULT_FIX: Record<string, GpsFix> = {
  sandia: { lat: 35.1983, lon: -106.4439, accuracyM: 14, elevationM: 2926 }, // La Luz upper switchbacks
  chamonix: { lat: 45.97, lon: 6.885, accuracyM: 14, elevationM: 2352 }, // near the Lac Blanc trail
  fontainebleau: { lat: 48.4058, lon: 2.6386, accuracyM: 14, elevationM: 130 }, // Gorges de Franchard
  yosemite: { lat: 37.727, lon: -119.541, accuracyM: 14, elevationM: 1500 }, // Mist Trail above Vernal Fall
  zermatt: { lat: 46.005, lon: 7.755, accuracyM: 14, elevationM: 2600 }, // Riffelberg trail
  'grand-canyon': { lat: 36.0761, lon: -112.1279, accuracyM: 14, elevationM: 1160 }, // Bright Angel Trail near Havasupai Gardens
  fuji: { lat: 35.42, lon: 138.755, accuracyM: 14, elevationM: 1400 }, // Yoshida forest trail
  'ben-nevis': { lat: 56.8021, lon: -5.0588, accuracyM: 14, elevationM: 700 }, // Ben Nevis Mountain Path
  pecos: { lat: 35.805, lon: -105.785, accuracyM: 14, elevationM: 3100 }, // Winsor Trail above the Ski Basin
};

export function defaultFixFor(pack: string): GpsFix | undefined {
  return DEFAULT_FIX[pack];
}

// Available packs + their manifest metadata, fetched once and cached.
let packListCache: Promise<PackInfo[]> | null = null;

export function listPacks(): Promise<PackInfo[]> {
  if (!packListCache) {
    packListCache = Promise.all(
      PACK_IDS.map(async (id): Promise<PackInfo> => {
        const res = await fetch(`/data/packs/${id}/manifest.json`);
        if (!res.ok) throw new Error(`manifest ${id}: ${res.status}`);
        const m = (await res.json()) as PackInfo;
        return { id: m.id, name: m.name, bbox: m.bbox, center: m.center, totalBytes: m.totalBytes };
      }),
    ).catch((err) => {
      packListCache = null; // don't cache a failure — allow a later retry
      throw err;
    });
  }
  return packListCache;
}
