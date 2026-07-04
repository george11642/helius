// Isomorphic routing core: parses graph.bin (format: ./graph-format.md) and
// runs A* over it. Plain JS + JSDoc (typed via the hand-written companion
// ./graph-core.d.mts) so this exact module — not a reimplementation — is
// importable both from the browser (src/map/graph.ts, via Vite) and from
// plain `node` (scripts/test-route.mjs), keeping the tested code and the
// shipped code identical.
//
// @ts-check

import createGraph from 'ngraph.graph';
import { aStar } from 'ngraph.path';

const HEADER_SIZE = 44;
const NODE_SIZE = 8;
const EDGE_SIZE = 20;
const POLY_SIZE = 8;

// Grid cell size for the nearestNode spatial index, in degrees (~555m lat /
// ~455m lon at Sandia latitudes). Deliberately coarser than the 300m
// off-network threshold: nearestNode searches a >=3x3 cell block (~1.5km
// span) before accepting a result, so any error introduced by the grid's
// coarseness is buried well inside the "obviously on/off network" margin —
// this doesn't need to be an exact nearest-neighbor structure, just correct
// near the 300m decision boundary.
const CELL_DEG = 0.005;
const OFF_NETWORK_M = 300;
const WALK_KMH = 5; // Naismith flat-ground rate; no ascent term (no elevation in v1)

/**
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} meters
 */
export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Decodes a graph.bin ArrayBuffer into plain data (see graph-format.md).
 * @param {ArrayBuffer} buffer
 */
export function parseGraph(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'HLXG') throw new Error(`graph.bin: bad magic "${magic}" (expected HLXG)`);
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`graph.bin: unsupported version ${version}`);

  const nodeCount = view.getUint32(8, true);
  const edgeCount = view.getUint32(12, true);
  const polylinePointCount = view.getUint32(16, true);
  const tagCount = view.getUint32(20, true);
  const tagsBlobBytes = view.getUint32(24, true);
  const bbox = {
    minLat: view.getInt32(28, true) / 1e6,
    minLon: view.getInt32(32, true) / 1e6,
    maxLat: view.getInt32(36, true) / 1e6,
    maxLon: view.getInt32(40, true) / 1e6,
  };

  let off = HEADER_SIZE;
  const nodeLat = new Float64Array(nodeCount);
  const nodeLon = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodeLat[i] = view.getInt32(off, true) / 1e6;
    nodeLon[i] = view.getInt32(off + 4, true) / 1e6;
    off += NODE_SIZE;
  }

  const edgeTableStart = off;
  const polyPoolStart = edgeTableStart + edgeCount * EDGE_SIZE;

  /** @type {import('./graph-core.d.mts').GraphEdge[]} */
  const edges = new Array(edgeCount);
  off = edgeTableStart;
  for (let i = 0; i < edgeCount; i++) {
    const nodeA = view.getUint32(off, true);
    const nodeB = view.getUint32(off + 4, true);
    const lengthM = view.getFloat32(off + 8, true);
    const polylineOffset = view.getUint32(off + 12, true);
    const polylineCount = view.getUint16(off + 16, true);
    const tagIdx = view.getUint16(off + 18, true);
    off += EDGE_SIZE;

    const polyline = new Array(polylineCount);
    let pOff = polyPoolStart + polylineOffset * POLY_SIZE;
    let lat = 0;
    let lon = 0;
    for (let p = 0; p < polylineCount; p++) {
      const a = view.getInt32(pOff, true);
      const b = view.getInt32(pOff + 4, true);
      if (p === 0) {
        lat = a;
        lon = b;
      } else {
        lat += a;
        lon += b;
      }
      polyline[p] = [lat / 1e6, lon / 1e6];
      pOff += POLY_SIZE;
    }

    edges[i] = { nodeA, nodeB, lengthM, tagIdx, polyline };
  }

  const tagsBlobStart = polyPoolStart + polylinePointCount * POLY_SIZE;
  const tagsBytes = new Uint8Array(buffer, tagsBlobStart, tagsBlobBytes);
  const tags = JSON.parse(new TextDecoder().decode(tagsBytes));
  if (tags.length !== tagCount) {
    throw new Error(`graph.bin: tag count mismatch (header says ${tagCount}, blob has ${tags.length})`);
  }

  return { nodeCount, edgeCount, nodeLat, nodeLon, edges, tags, bbox };
}

/**
 * @param {string} highway
 */
function genericLabelFor(highway) {
  switch (highway) {
    case 'footway':
    case 'path':
      return 'the trail';
    case 'track':
      return 'the track';
    case 'steps':
      return 'the steps';
    case 'bridleway':
      return 'the bridleway';
    case 'cycleway':
      return 'the cycleway';
    case 'service':
      return 'the service road';
    case 'residential':
    case 'unclassified':
    case 'tertiary':
    case 'secondary':
    case 'primary':
      return 'the road';
    default:
      return 'the path';
  }
}

/**
 * @param {number} meters
 */
function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Builds the routable structure (ngraph instance, spatial index, edge
 * adjacency) from parsed graph.bin data.
 * @param {import('./graph-core.d.mts').RawGraph} raw
 */
export function buildRoutingGraph(raw) {
  const graph = createGraph({ multigraph: true });
  for (let i = 0; i < raw.nodeCount; i++) {
    graph.addNode(i, { lat: raw.nodeLat[i], lon: raw.nodeLon[i] });
  }

  /** @type {Map<number, number[]>} nodeIdx -> edgeIdx[] touching it */
  const adjacency = new Map();
  function addAdj(nodeIdx, edgeIdx) {
    let list = adjacency.get(nodeIdx);
    if (!list) {
      list = [];
      adjacency.set(nodeIdx, list);
    }
    list.push(edgeIdx);
  }

  /** @type {Map<string, number[]>} */
  const spatialIndex = new Map();
  function cellKey(lat, lon) {
    return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
  }

  raw.edges.forEach((e, edgeIdx) => {
    graph.addLink(e.nodeA, e.nodeB, edgeIdx);
    addAdj(e.nodeA, edgeIdx);
    addAdj(e.nodeB, edgeIdx);
  });

  for (let i = 0; i < raw.nodeCount; i++) {
    const key = cellKey(raw.nodeLat[i], raw.nodeLon[i]);
    let list = spatialIndex.get(key);
    if (!list) {
      list = [];
      spatialIndex.set(key, list);
    }
    list.push(i);
  }

  return { raw, graph, adjacency, spatialIndex };
}

/**
 * @param {import('./graph-core.d.mts').RoutingGraph} rg
 * @param {number} lat @param {number} lon
 * @returns {{ nodeIdx: number; distM: number } | null}
 */
export function nearestNode(rg, lat, lon) {
  const { raw, spatialIndex } = rg;
  if (raw.nodeCount === 0) return null;

  const cx = Math.floor(lat / CELL_DEG);
  const cy = Math.floor(lon / CELL_DEG);

  for (let ring = 1; ring <= 6; ring++) {
    const candidates = new Set();
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const list = spatialIndex.get(`${cx + dx}:${cy + dy}`);
        if (list) for (const n of list) candidates.add(n);
      }
    }
    if (candidates.size === 0) continue;

    let best = -1;
    let bestD = Infinity;
    for (const nodeIdx of candidates) {
      const d = haversineM(lat, lon, raw.nodeLat[nodeIdx], raw.nodeLon[nodeIdx]);
      if (d < bestD) {
        bestD = d;
        best = nodeIdx;
      }
    }
    return { nodeIdx: best, distM: bestD };
  }
  return null;
}

/**
 * Finds the edge connecting two adjacent path nodes, and whether traversal
 * runs with or against the edge's stored nodeA->nodeB direction.
 * @param {import('./graph-core.d.mts').RoutingGraph} rg
 * @param {number} fromIdx @param {number} toIdx
 */
function findConnectingEdge(rg, fromIdx, toIdx) {
  const candidates = rg.adjacency.get(fromIdx) ?? [];
  for (const edgeIdx of candidates) {
    const e = rg.raw.edges[edgeIdx];
    if (e.nodeA === fromIdx && e.nodeB === toIdx) return { edgeIdx, forward: true };
    if (e.nodeB === fromIdx && e.nodeA === toIdx) return { edgeIdx, forward: false };
  }
  return null;
}

/**
 * @param {import('./graph-core.d.mts').RoutingGraph} rg
 * @param {import('./graph-core.d.mts').LatLon} from
 * @param {import('./graph-core.d.mts').LatLon} to
 * @returns {import('./graph-core.d.mts').RouteResult}
 */
export function findRoute(rg, from, to) {
  const fromSnap = nearestNode(rg, from.lat, from.lon);
  if (!fromSnap) return { error: 'off_network', nearest_m: Infinity };
  if (fromSnap.distM > OFF_NETWORK_M) return { error: 'off_network', nearest_m: fromSnap.distM };

  const toSnap = nearestNode(rg, to.lat, to.lon);
  if (!toSnap) return { error: 'off_network', nearest_m: Infinity };
  if (toSnap.distM > OFF_NETWORK_M) return { error: 'off_network', nearest_m: toSnap.distM };

  if (fromSnap.nodeIdx === toSnap.nodeIdx) {
    const [lat, lon] = [rg.raw.nodeLat[fromSnap.nodeIdx], rg.raw.nodeLon[fromSnap.nodeIdx]];
    return {
      distanceM: 0,
      ascentM: null,
      geojson: { type: 'LineString', coordinates: [[lon, lat], [lon, lat]] },
      steps: [],
      etaMin: 0,
    };
  }

  const pathFinder = aStar(rg.graph, {
    distance: (_f, _t, link) => rg.raw.edges[/** @type {number} */ (link.data)].lengthM,
    heuristic: (fromNode, toNode) => haversineM(fromNode.data.lat, fromNode.data.lon, toNode.data.lat, toNode.data.lon),
  });
  const found = pathFinder.find(fromSnap.nodeIdx, toSnap.nodeIdx);
  if (found.length === 0) return { error: 'no_path' };

  const nodePath = found.map((n) => /** @type {number} */ (n.id)).reverse();

  /** @type {[number, number][]} */
  const coords = [];
  let distanceM = 0;
  /** @type {{ label: string; distanceM: number }[]} */
  const legs = [];

  for (let i = 0; i < nodePath.length - 1; i++) {
    const a = nodePath[i];
    const b = nodePath[i + 1];
    const hit = findConnectingEdge(rg, a, b);
    if (!hit) throw new Error(`graph inconsistency: no edge between path nodes ${a} and ${b}`);
    const edge = rg.raw.edges[hit.edgeIdx];
    const pts = hit.forward ? edge.polyline : [...edge.polyline].reverse();

    if (coords.length === 0) coords.push(pts[0]);
    for (let p = 1; p < pts.length; p++) coords.push(pts[p]);

    distanceM += edge.lengthM;
    const tags = rg.raw.tags[edge.tagIdx] ?? {};
    const label = tags.name ?? genericLabelFor(tags.highway);
    const lastLeg = legs[legs.length - 1];
    if (lastLeg && lastLeg.label === label) {
      lastLeg.distanceM += edge.lengthM;
    } else {
      legs.push({ label, distanceM: edge.lengthM });
    }
  }

  const steps = legs.map((leg, i) => ({
    instruction: `${i === 0 ? 'Follow' : 'Turn onto'} ${leg.label} ${formatDistance(leg.distanceM)}`,
    distanceM: leg.distanceM,
  }));

  return {
    distanceM,
    ascentM: null,
    geojson: { type: 'LineString', coordinates: coords.map(([lat, lon]) => [lon, lat]) },
    steps,
    etaMin: (distanceM / 1000 / WALK_KMH) * 60,
  };
}
