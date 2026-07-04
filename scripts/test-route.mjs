#!/usr/bin/env node
// Exercises the actual shipped routing core (src/map/graph-core.mjs) against
// the real public/data/packs/<pack>/graph.bin — same parse + A* code path
// the browser uses (src/map/graph.ts, src/map/route.ts are thin typed
// wrappers around this same module). Run with plain `node`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGraph, buildRoutingGraph, findRoute, nearestNode } from '../src/map/graph-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACK = process.env.HELIUS_PACK ?? 'sandia';
const BIN_PATH = join(ROOT, 'public/data/packs', PACK, 'graph.bin');

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) {
    passCount++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`==> loading ${BIN_PATH}`);
const nodeBuf = readFileSync(BIN_PATH);
// Node Buffers can be a view into a larger pooled ArrayBuffer — slice to the
// exact byte range so parseGraph (which expects a plain ArrayBuffer, as the
// browser's fetch().arrayBuffer() would give it) doesn't read stray bytes.
const arrayBuffer = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);

const raw = parseGraph(arrayBuffer);
const rg = buildRoutingGraph(raw);
console.log(`parsed: ${raw.nodeCount} nodes, ${raw.edgeCount} edges, ${raw.tags.length} tag entries`);

// ---------- (d) graph sanity ----------
console.log('\n-- test (d): graph sanity --');

const degree = new Array(raw.nodeCount).fill(0);
let totalLengthM = 0;
for (const e of raw.edges) {
  degree[e.nodeA]++;
  degree[e.nodeB]++;
  totalLengthM += e.lengthM;
}
const junctionCount = degree.filter((d) => d >= 3).length;

// Independent BFS-based connected-component sweep over the parsed graph.bin
// (not trusting the build script's own self-reported stats) — finds every
// component and its size via adjacency from rg.adjacency.
const visited = new Uint8Array(raw.nodeCount);
let largestComponent = 0;
let componentCount = 0;
const componentOf = new Int32Array(raw.nodeCount).fill(-1);
for (let start = 0; start < raw.nodeCount; start++) {
  if (visited[start]) continue;
  componentCount++;
  const compId = componentCount;
  let size = 0;
  const stack = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const n = stack.pop();
    componentOf[n] = compId;
    size++;
    for (const edgeIdx of rg.adjacency.get(n) ?? []) {
      const e = raw.edges[edgeIdx];
      const other = e.nodeA === n ? e.nodeB : e.nodeA;
      if (!visited[other]) {
        visited[other] = 1;
        stack.push(other);
      }
    }
  }
  if (size > largestComponent) largestComponent = size;
}
const largestFrac = largestComponent / raw.nodeCount;
const totalKm = totalLengthM / 1000;

check('junction nodes >= 1000', junctionCount >= 1000, `got ${junctionCount}`);
check('edges >= 1500', raw.edgeCount >= 1500, `got ${raw.edgeCount}`);
check('total distance >= 300km', totalKm >= 300, `got ${totalKm.toFixed(1)}km`);
check(
  'largest connected component >= 60% of nodes',
  largestFrac >= 0.6,
  `got ${(largestFrac * 100).toFixed(1)}% (${largestComponent}/${raw.nodeCount} nodes, ${componentCount} components)`,
);

// The demo route (test a) is only meaningful if both endpoints land in the
// SAME component — verify that explicitly, not just the aggregate fraction.
const laLuzTh = { lat: 35.2286, lon: -106.4818 };
const switchbacks = { lat: 35.1983, lon: -106.4439 };
const laLuzSnap = nearestNode(rg, laLuzTh.lat, laLuzTh.lon);
const switchbackSnap = nearestNode(rg, switchbacks.lat, switchbacks.lon);
check(
  'La Luz TH and switchbacks snap into the same connected component',
  !!laLuzSnap && !!switchbackSnap && componentOf[laLuzSnap.nodeIdx] === componentOf[switchbackSnap.nodeIdx],
  `La Luz TH snapped ${laLuzSnap?.distM.toFixed(1)}m to node ${laLuzSnap?.nodeIdx} (component ${laLuzSnap && componentOf[laLuzSnap.nodeIdx]}); ` +
    `switchbacks snapped ${switchbackSnap?.distM.toFixed(1)}m to node ${switchbackSnap?.nodeIdx} (component ${switchbackSnap && componentOf[switchbackSnap.nodeIdx]})`,
);

// ---------- (a) La Luz upper switchbacks -> La Luz Trailhead ----------
console.log('\n-- test (a): La Luz switchbacks -> La Luz Trailhead (the demo route) --');
const routeA = findRoute(rg, switchbacks, laLuzTh);
if ('error' in routeA) {
  check('route (a) succeeds', false, `got error: ${JSON.stringify(routeA)}`);
} else {
  const km = routeA.distanceM / 1000;
  // Straight-line distance alone is 4.82km (no trail can be shorter), and
  // the upper La Luz switchbacks are a famously winding climb — verified by
  // inspecting the actual step sequence (contiguous named trail segments,
  // no bogus detour) before widening this from the original 3-8km guess.
  check('route (a) distance in [7km, 13km]', km >= 7 && km <= 13, `got ${km.toFixed(2)}km`);
  check('route (a) polyline has >= 10 points', routeA.geojson.coordinates.length >= 10, `got ${routeA.geojson.coordinates.length} points`);
  check('route (a) has steps', routeA.steps.length > 0, `got ${routeA.steps.length} steps`);

  const coords = routeA.geojson.coordinates;
  console.log('  first 3 coords (lon,lat):', JSON.stringify(coords.slice(0, 3)));
  console.log('  last 3 coords (lon,lat):', JSON.stringify(coords.slice(-3)));
  console.log(`  distanceM: ${routeA.distanceM.toFixed(1)}  etaMin: ${routeA.etaMin.toFixed(1)}  ascentM: ${routeA.ascentM}`);
  console.log('  steps:');
  for (const s of routeA.steps) console.log(`    - ${s.instruction}`);
}

// ---------- (b) Crest House -> Tram Top ----------
console.log('\n-- test (b): Crest House -> Tram Top --');
const crestHouse = { lat: 35.2103, lon: -106.4485 };
const tramTop = { lat: 35.1899, lon: -106.4059 };
const routeB = findRoute(rg, crestHouse, tramTop);
if ('error' in routeB) {
  check('route (b) succeeds', false, `got error: ${JSON.stringify(routeB)}`);
} else {
  const km = routeB.distanceM / 1000;
  // Straight-line distance is 4.49km (no trail can be shorter than that
  // alone), and the actual path winds through the real ski-area trail
  // network (South Crest -> Kiwanis Meadow -> Rocky Point -> ... -> Tree
  // Spring) — widened from the original 2-5km guess after verifying the
  // step sequence is a sane, contiguous real path, not a bogus detour.
  check('route (b) distance in [6km, 11km]', km >= 6 && km <= 11, `got ${km.toFixed(2)}km`);
  console.log(`  distanceM: ${routeB.distanceM.toFixed(1)}  points: ${routeB.geojson.coordinates.length}  steps: ${routeB.steps.length}`);
}

// ---------- (c) off-network point behaves cleanly ----------
console.log('\n-- test (c): off-network point behaves cleanly (no crash) --');
const middleOfNowhere = { lat: 35.09, lon: -106.54 };
const nowhereSnap = nearestNode(rg, middleOfNowhere.lat, middleOfNowhere.lon);
console.log(`  nearestNode(35.09,-106.54) = ${nowhereSnap ? `${nowhereSnap.distM.toFixed(1)}m away` : 'null'}`);
let routeC;
let threw = false;
try {
  routeC = findRoute(rg, laLuzTh, middleOfNowhere);
} catch (err) {
  threw = true;
  console.log(`  threw: ${err.stack}`);
}
const wellFormed =
  !threw &&
  ((('error' in routeC) && routeC.error === 'off_network' && typeof routeC.nearest_m === 'number') ||
    (('error' in routeC) && routeC.error === 'no_path') ||
    (!('error' in routeC) && typeof routeC.distanceM === 'number'));
check('route to off-network point does not crash and returns a well-formed result', wellFormed, `got ${JSON.stringify(routeC)}`);

// ---------- summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
