// A* trail routing over a loaded pack graph (src/map/graph.ts::loadGraph).
// The actual algorithm lives in ./graph-core.mjs, shared with
// scripts/test-route.mjs so the same code path that ships is the code path
// under test — this file is just the typed public entry point.

import { findRoute } from './graph-core.mjs';
import type { RoutingGraph, LatLon, RouteResult } from './graph-core.d.mts';

export type { LatLon, RouteResult, RouteSuccess, RouteError, RouteStep, GeoJSONLineString } from './graph-core.d.mts';

/**
 * Routes from `from` to `to` over a loaded graph pack via A* (distance =
 * edge length in meters; heuristic = haversine great-circle distance, which
 * is admissible since no path can be shorter than a straight line).
 *
 * Errors: `{ error: 'off_network', nearest_m }` when either point is more
 * than 300m from any graph vertex; `{ error: 'no_path' }` when the two
 * points snap into disconnected components of the trail network.
 *
 * `ascentM` is always `null` — graph.bin carries no elevation data in v1.
 */
export function route(graph: RoutingGraph, from: LatLon, to: LatLon): RouteResult {
  return findRoute(graph, from, to);
}
