// Browser-side graph.bin loader. Byte layout: ./graph-format.md. Parsing +
// spatial-index construction live in ./graph-core.mjs (shared with Node via
// scripts/test-route.mjs) — this file just fetches the pack's binary and
// hands it to that shared core, then re-exports the types.

import { parseGraph, buildRoutingGraph } from './graph-core.mjs';
import type { RoutingGraph } from './graph-core.d.mts';
import { PACK_BASE_URL } from './pack-base';

export type {
  RoutingGraph,
  RawGraph,
  LatLon,
  GraphEdge,
  TagEntry,
  RouteResult,
  RouteSuccess,
  RouteError,
  RouteStep,
  GeoJSONLineString,
} from './graph-core.d.mts';
export { nearestNode, haversineM } from './graph-core.mjs';

/** Fetches and parses `<PACK_BASE_URL>/<pack>/graph.bin` into a routable graph. */
export async function loadGraph(pack: string): Promise<RoutingGraph> {
  const res = await fetch(`${PACK_BASE_URL}/${pack}/graph.bin`);
  if (!res.ok) {
    throw new Error(`loadGraph: failed to fetch graph.bin for pack "${pack}" (${res.status} ${res.statusText})`);
  }
  const buffer = await res.arrayBuffer();
  return buildRoutingGraph(parseGraph(buffer));
}
