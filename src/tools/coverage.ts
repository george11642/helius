// Coverage truth: is a fix actually inside the active pack's mapped region,
// and if not, how far outside? locate() uses the cheap static bbox check
// (no graph load); route_back layers the loaded graph's own node bbox and
// nearest-trailhead distance on top for the definitive answer. Pure functions,
// Node-testable (tests/coverage.test.ts) — keep this module import-free.

export interface PackCoverage {
  id: string;
  name: string;
  /** [west, south, east, north] — mirrors public/data/packs/<id>/manifest.json. */
  bbox: [number, number, number, number];
}

// Kept in sync with the pack manifests by hand (they change only when a pack
// is re-cut). Static so locate() can answer coverage without a fetch and so
// Node tests need no network.
export const PACK_COVERAGE: Record<string, PackCoverage> = {
  sandia: { id: 'sandia', name: 'Sandia Mountains — Albuquerque', bbox: [-107.15, 34.65, -106.15, 35.55] },
  chamonix: { id: 'chamonix', name: 'Chamonix — Mont Blanc', bbox: [6.75, 45.8, 7.05, 46.05] },
  fontainebleau: { id: 'fontainebleau', name: 'Forêt de Fontainebleau', bbox: [2.53, 48.36, 2.72, 48.47] },
};

// Same great-circle math as src/map/graph-core.mjs::haversineM — duplicated
// (8 lines) so this module stays dependency-free for Node tests; graph-core
// pulls in ngraph at import time.
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface BboxCoverage {
  inBbox: boolean;
  /** 0 when inside; else great-circle meters to the nearest bbox edge point. */
  distanceToBboxM: number;
}

/** Point-in-bbox plus distance-to-bbox (haversine to the clamped point). */
export function coverageForBbox(lat: number, lon: number, bbox: [number, number, number, number]): BboxCoverage {
  const [west, south, east, north] = bbox;
  const inBbox = lat >= south && lat <= north && lon >= west && lon <= east;
  if (inBbox) return { inBbox: true, distanceToBboxM: 0 };
  const clampedLat = Math.min(Math.max(lat, south), north);
  const clampedLon = Math.min(Math.max(lon, west), east);
  return { inBbox: false, distanceToBboxM: haversineM(lat, lon, clampedLat, clampedLon) };
}

/** Coverage of a fix relative to a pack's manifest bbox; null for unknown packs. */
export function coverageForPack(lat: number, lon: number, packId: string): (BboxCoverage & { pack: PackCoverage }) | null {
  const pack = PACK_COVERAGE[packId];
  if (!pack) return null;
  return { ...coverageForBbox(lat, lon, pack.bbox), pack };
}

/** Great-circle meters to the closest of `points`; null when the list is empty. */
export function distanceToNearestM(lat: number, lon: number, points: { lat: number; lon: number }[]): number | null {
  let best: number | null = null;
  for (const p of points) {
    const d = haversineM(lat, lon, p.lat, p.lon);
    if (best === null || d < best) best = d;
  }
  return best;
}
