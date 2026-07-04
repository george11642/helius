// route_back: real A* routing over the offline pack graph (src/map). Replaces
// the H0 stub. Lazy-loads and caches the graph + POIs per pack (first call
// pays the fetch+parse; later calls are instant). The bulky route geometry is
// NOT returned to the model — it's stashed as a pending route the agent loop
// picks up and emits as a 'route' AgentEvent for the map to draw. The model
// only gets compact numbers (distance, ETA, waypoint count).

import type { ToolResult } from '../lib/contract';
import { loadGraph } from '../map/graph';
import { route } from '../map/route';
import type { GeoJSONLineString, RoutingGraph } from '../map/graph';
import { getFix } from './location';
import { getPack } from './pack';
import { PACK_COVERAGE, coverageForBbox, distanceToNearestM } from './coverage';
import { fmtDistance, fmtDurationMin } from './format';

export interface PendingRoute {
  geojson: GeoJSONLineString;
  distanceM: number;
  etaMin: number;
  /** Resolved destination name, e.g. "La Luz Trailhead" — authoritative for the UI. */
  dest: string;
  /** Pre-formatted human line the UI can show verbatim (deterministic numbers). */
  display: string;
}

interface Poi {
  name: string;
  lat: number;
  lon: number;
  role?: string;
}
interface PoisFile {
  trailheads?: Poi[];
}

// Destination enum resolution. Primary: match the trailhead's `role`
// (`trailhead` / `crest` / `tram_station`) — set by the pack pipeline. Fallback
// (packs without roles): the slot order below. Both keep resolution data-driven,
// so a new pack's destinations route with no code change.
const DEST_SLOT: Record<string, number> = { trailhead: 0, crest: 1, tram_station: 2 };

const graphCache = new Map<string, Promise<RoutingGraph>>();
const poisCache = new Map<string, Promise<PoisFile>>();

function getGraph(pack: string): Promise<RoutingGraph> {
  let p = graphCache.get(pack);
  if (!p) {
    p = loadGraph(pack).catch((err) => {
      graphCache.delete(pack); // don't cache a failure — allow a later retry
      throw err;
    });
    graphCache.set(pack, p);
  }
  return p;
}

function getPois(pack: string): Promise<PoisFile> {
  let p = poisCache.get(pack);
  if (!p) {
    p = fetch(`/data/packs/${pack}/pois.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`pois.json ${r.status}`);
        return r.json() as Promise<PoisFile>;
      })
      .catch((err) => {
        poisCache.delete(pack);
        throw err;
      });
    poisCache.set(pack, p);
  }
  return p;
}

// Stamped with the pack it was computed for. A route_back that started before a
// switchPack can resolve and write pendingRoute AFTER clearPackCache ran — the
// stamp lets takePendingRoute drop that stale geometry instead of ghosting
// old-pack coordinates onto the new map.
let pendingRoute: (PendingRoute & { pack: string }) | null = null;

/** The agent loop calls this right after a successful route_back to emit 'route'. */
export function takePendingRoute(): PendingRoute | null {
  const r = pendingRoute;
  pendingRoute = null;
  if (!r || r.pack !== getPack()) return null; // stale: computed for a pack we've since left
  return { geojson: r.geojson, distanceM: r.distanceM, etaMin: r.etaMin, dest: r.dest, display: r.display };
}

/** Drop cached graph + POIs (and any pending route) so the next route_back
 *  lazy-loads whatever pack is now active. Called by the façade on switchPack. */
export function clearPackCache(): void {
  graphCache.clear();
  poisCache.clear();
  pendingRoute = null;
}

const asString = (v: unknown, fb: string): string => (typeof v === 'string' && v.trim() ? v : fb);

/** Honest structured failure for a fix with no usable trail data around it. */
function offCoverageResult(pack: string, distanceM: number): ToolResult {
  const packName = PACK_COVERAGE[pack]?.name ?? pack;
  const km = +(distanceM / 1000).toFixed(1);
  const display = `You are ~${km} km outside the ${packName} coverage area — I have no trail data at your position. Switch region packs, or use demo GPS to explore this pack.`;
  return {
    data: { error: 'out_of_coverage', pack, coverage_km_away: km, display },
    summary: `route_back: ~${km} km outside "${pack}" coverage — no trail data here`,
  };
}

export async function runRouteBack(args: Record<string, unknown>): Promise<ToolResult> {
  const pack = getPack();
  const destKey = asString(args.destination, 'trailhead');

  const from = getFix();
  if (!from) {
    const display =
      'I have no position fix — GPS is unavailable or permission was denied, and demo GPS is off. Enable location access or turn on demo GPS, then ask again.';
    return {
      data: { error: 'no_fix', display },
      summary: 'route_back: no position fix — cannot route',
    };
  }

  let graph: RoutingGraph;
  let pois: PoisFile;
  try {
    [graph, pois] = await Promise.all([getGraph(pack), getPois(pack)]);
  } catch (err) {
    return {
      data: { error: 'pack_unavailable', message: String(err).slice(0, 160) },
      summary: `route_back: "${pack}" route data unavailable`,
    };
  }

  // Coverage truth, layer 1: outside the routing graph's own bounding box means
  // the position is flatly outside the mapped region — say so, never fabricate.
  const b = graph.raw.bbox;
  const graphCov = coverageForBbox(from.lat, from.lon, [b.minLon, b.minLat, b.maxLon, b.maxLat]);
  if (!graphCov.inBbox) return offCoverageResult(pack, graphCov.distanceToBboxM);

  const trailheads = pois.trailheads ?? [];
  const slot = DEST_SLOT[destKey] ?? 0;
  const dest = trailheads.find((t) => t.role === destKey) ?? trailheads[slot] ?? trailheads[0];
  if (!dest) {
    return {
      data: { error: 'unknown_destination', destination: destKey },
      summary: `route_back: no destinations in pack "${pack}"`,
    };
  }

  const result = route(graph, { lat: from.lat, lon: from.lon }, { lat: dest.lat, lon: dest.lon });

  if ('error' in result) {
    if (result.error === 'off_network') {
      // Coverage truth, layer 2: inside the bbox but off the trail network.
      // nearest_m is Infinity when the spatial index found nothing within
      // ~3 km — fall back to the distance to the nearest known trailhead so
      // the honest message still carries a real number.
      if (!Number.isFinite(result.nearest_m)) {
        const d = distanceToNearestM(from.lat, from.lon, trailheads);
        return offCoverageResult(pack, d ?? graphCov.distanceToBboxM);
      }
      const m = Math.round(result.nearest_m);
      const display = `You are ${fmtDistance(m)} from the nearest mapped trail in the ${PACK_COVERAGE[pack]?.name ?? pack} pack — too far off-network to route to ${dest.name}. Head toward the trail network, or use demo GPS.`;
      return {
        data: { error: 'off_network', nearest_m: m, dest: dest.name, display },
        summary: `route_back: off-network (~${m} m from nearest trail) — can't route to ${dest.name}`,
      };
    }
    return {
      data: { error: 'no_path', dest: dest.name, display: `The trail network here doesn't connect your position to ${dest.name} — no honest route exists in this pack's data.` },
      summary: `route_back: no trail path to ${dest.name}`,
    };
  }

  // Success: stash geometry (stamped with the pack it's for) for the loop to
  // emit; return compact numbers plus the pre-formatted display line — the
  // model quotes `display` verbatim instead of converting units itself.
  const display = `Route to ${dest.name}: ${fmtDistance(result.distanceM)}, about ${fmtDurationMin(result.etaMin)}.`;
  pendingRoute = { geojson: result.geojson, distanceM: result.distanceM, etaMin: result.etaMin, dest: dest.name, display, pack };
  const km = result.distanceM / 1000;
  const mi = km * 0.621371;
  return {
    data: {
      status: 'ok', // clear success signal as the first key, so the model reads the turn as done
      dest: dest.name,
      distance_m: Math.round(result.distanceM),
      distance_mi: +mi.toFixed(2),
      eta_min: Math.round(result.etaMin),
      ascent_m: result.ascentM, // null in graph v1 (no elevation); pace_eta can still reason on distance
      waypoints: result.geojson.coordinates.length,
      display,
    },
    summary: `route to ${dest.name}: ${km.toFixed(2)} km / ${mi.toFixed(2)} mi, ~${Math.round(result.etaMin)} min, ${result.geojson.coordinates.length} pts`,
  };
}
