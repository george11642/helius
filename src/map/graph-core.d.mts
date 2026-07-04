// Hand-written type declarations for ./graph-core.mjs (plain JS + JSDoc).
// Authoritative source of truth for the shapes below — kept in sync by hand
// rather than inferred, so route.ts gets real types without needing TS to
// parse the .mjs body.

import type { Graph } from 'ngraph.graph';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface TagEntry {
  highway?: string;
  name?: string;
  sac_scale?: string;
  surface?: string;
}

export interface GraphEdge {
  nodeA: number;
  nodeB: number;
  lengthM: number;
  tagIdx: number;
  /** Full coordinate sequence from nodeA to nodeB, as [lat, lon] pairs, decimal degrees. */
  polyline: [number, number][];
}

export interface RawGraph {
  nodeCount: number;
  edgeCount: number;
  nodeLat: Float64Array;
  nodeLon: Float64Array;
  edges: GraphEdge[];
  tags: TagEntry[];
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

export interface RoutingGraph {
  raw: RawGraph;
  graph: Graph<{ lat: number; lon: number }, number>;
  /** nodeIdx -> indices into raw.edges touching that node */
  adjacency: Map<number, number[]>;
  /** `${cellRow}:${cellCol}` (0.005 deg cells) -> nodeIdx[] */
  spatialIndex: Map<string, number[]>;
}

export interface RouteStep {
  instruction: string;
  distanceM: number;
}

export interface GeoJSONLineString {
  type: 'LineString';
  /** [lon, lat] pairs, per GeoJSON coordinate order. */
  coordinates: [number, number][];
}

export interface RouteSuccess {
  distanceM: number;
  /** Always null in v1 — graph.bin has no elevation data. */
  ascentM: null;
  geojson: GeoJSONLineString;
  steps: RouteStep[];
  etaMin: number;
}

export type RouteError = { error: 'off_network'; nearest_m: number } | { error: 'no_path' };

export type RouteResult = RouteSuccess | RouteError;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number;
export function parseGraph(buffer: ArrayBuffer): RawGraph;
export function buildRoutingGraph(raw: RawGraph): RoutingGraph;
export function nearestNode(rg: RoutingGraph, lat: number, lon: number): { nodeIdx: number; distM: number } | null;
export function findRoute(rg: RoutingGraph, from: LatLon, to: LatLon): RouteResult;
