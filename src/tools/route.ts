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

export interface PendingRoute {
  geojson: GeoJSONLineString;
  distanceM: number;
  etaMin: number;
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

let pendingRoute: PendingRoute | null = null;

/** The agent loop calls this right after a successful route_back to emit 'route'. */
export function takePendingRoute(): PendingRoute | null {
  const r = pendingRoute;
  pendingRoute = null;
  return r;
}

const asString = (v: unknown, fb: string): string => (typeof v === 'string' && v.trim() ? v : fb);

export async function runRouteBack(args: Record<string, unknown>): Promise<ToolResult> {
  const pack = getPack();
  const destKey = asString(args.destination, 'trailhead');

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

  const trailheads = pois.trailheads ?? [];
  const slot = DEST_SLOT[destKey] ?? 0;
  const dest = trailheads.find((t) => t.role === destKey) ?? trailheads[slot] ?? trailheads[0];
  if (!dest) {
    return {
      data: { error: 'unknown_destination', destination: destKey },
      summary: `route_back: no destinations in pack "${pack}"`,
    };
  }

  const from = getFix();
  const result = route(graph, { lat: from.lat, lon: from.lon }, { lat: dest.lat, lon: dest.lon });

  if ('error' in result) {
    if (result.error === 'off_network') {
      const m = Math.round(result.nearest_m);
      return {
        data: { error: 'off_network', nearest_m: m, dest: dest.name },
        summary: `route_back: off-network (~${m} m from nearest trail) — can't route to ${dest.name}`,
      };
    }
    return {
      data: { error: 'no_path', dest: dest.name },
      summary: `route_back: no trail path to ${dest.name}`,
    };
  }

  // Success: stash geometry for the loop to emit; return compact numbers only.
  pendingRoute = { geojson: result.geojson, distanceM: result.distanceM, etaMin: result.etaMin };
  const km = result.distanceM / 1000;
  const mi = km * 0.621371;
  return {
    data: {
      status: 'ready',
      dest: dest.name,
      distance_m: Math.round(result.distanceM),
      distance_mi: +mi.toFixed(2),
      eta_min: Math.round(result.etaMin),
      ascent_m: result.ascentM, // null in graph v1 (no elevation); pace_eta can still reason on distance
      waypoints: result.geojson.coordinates.length,
    },
    summary: `route to ${dest.name}: ${km.toFixed(2)} km / ${mi.toFixed(2)} mi, ~${Math.round(result.etaMin)} min, ${result.geojson.coordinates.length} pts`,
  };
}
