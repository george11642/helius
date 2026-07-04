#!/usr/bin/env node
// Builds public/data/packs/<pack>/graph.bin + pois.json from raw Overpass
// `out geom` trail data. Byte layout: src/map/graph-format.md (read that
// first if you're touching this file). Run with plain `node` — no deps
// beyond core `fs`/`path`.
//
// Input (not part of the repo — a build-time asset cache, see
// scripts/sync-assets.sh for the sibling pmtiles/peaks copy step):
//   $HELIUS_ASSETS/map/sandia-trails.json  (~20MB Overpass ways, `out geom`)
//   $HELIUS_ASSETS/map/sandia-peaks.json   (Overpass `natural=peak` nodes)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = process.env.HELIUS_ASSETS ?? join(process.env.HOME ?? '', 'dev/helius-assets');
const PACK = process.env.HELIUS_PACK ?? 'sandia';

const TRAILS_PATH = process.env.HELIUS_TRAILS ?? join(ASSETS, 'map/sandia-trails.json');
const PEAKS_PATH = process.env.HELIUS_PEAKS ?? join(ASSETS, 'map/sandia-peaks.json');
const OUT_DIR = join(ROOT, 'public/data/packs', PACK);

// Known-safe trailheads: overridable per pack via HELIUS_TRAILHEADS (path to a
// JSON array of {name,lat,lon}) — OSM extracts don't tag these reliably
// (verified: sandia-peaks.json has zero trailhead-tagged nodes, only
// natural=peak). Default = the Sandia set.
const TRAILHEADS = process.env.HELIUS_TRAILHEADS
  ? JSON.parse(readFileSync(process.env.HELIUS_TRAILHEADS, 'utf8'))
  : [
      { name: 'La Luz Trailhead', lat: 35.2286, lon: -106.4818, role: 'trailhead' },
      { name: 'Sandia Crest House', lat: 35.2103, lon: -106.4485, role: 'crest' },
      { name: 'Tram Top Station', lat: 35.1899, lon: -106.4059, role: 'tram_station' },
      { name: 'Elena Gallegos / Pino Trailhead', lat: 35.1624, lon: -106.4682 },
    ];

// highway values considered walkable/routable. Everything else (service
// driveways aside — service IS included per spec) is dropped.
const WALKABLE_HIGHWAY = new Set([
  'path', 'footway', 'track', 'steps', 'bridleway', 'cycleway',
  'unclassified', 'residential', 'tertiary', 'secondary', 'primary', 'service',
]);

const KEPT_TAG_KEYS = ['highway', 'name', 'sac_scale', 'surface'];

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isWayKept(tags) {
  const hw = tags.highway;
  if (!WALKABLE_HIGHWAY.has(hw)) return false;
  const access = tags.access;
  if ((access === 'private' || access === 'no') && tags.foot !== 'yes') return false;
  return true;
}

console.log(`==> reading ${TRAILS_PATH}`);
const raw = JSON.parse(readFileSync(TRAILS_PATH, 'utf8'));
const allWays = raw.elements.filter((e) => e.type === 'way');
console.log(`input: ${allWays.length} ways`);

const ways = allWays.filter((w) => isWayKept(w.tags ?? {}));
console.log(`kept ways (walkable, not excluded by access): ${ways.length}`);

let inputPoints = 0;
for (const w of allWays) inputPoints += w.geometry.length;

// ---------- pass 1: decide which OSM node ids become graph vertices ----------
// Keep a node iff: it's a way endpoint, OR it's touched by >=2 distinct
// kept ways, OR it occurs more than once within a single way's own node
// list (closed loops / self-touching ways). See graph-format.md "Node
// identity" for why exact OSM node-id welding is used instead of
// coordinate rounding.
const nodeWaySet = new Map(); // osmNodeId -> Set<wayIndex> (dedup within a way first)
const keepNode = new Set();
const nodePos = new Map(); // osmNodeId -> [lat, lon]

ways.forEach((w, wi) => {
  const ids = w.nodes;
  const geom = w.geometry;
  const seenThisWay = new Map(); // osmNodeId -> occurrence count within this way
  for (let i = 0; i < ids.length; i++) {
    const nid = ids[i];
    if (!nodePos.has(nid)) nodePos.set(nid, [geom[i].lat, geom[i].lon]);
    seenThisWay.set(nid, (seenThisWay.get(nid) ?? 0) + 1);
    let set = nodeWaySet.get(nid);
    if (!set) {
      set = new Set();
      nodeWaySet.set(nid, set);
    }
    set.add(wi);
  }
  keepNode.add(ids[0]);
  keepNode.add(ids[ids.length - 1]);
  for (const [nid, count] of seenThisWay) {
    if (count > 1) keepNode.add(nid);
  }
});
for (const [nid, set] of nodeWaySet) {
  if (set.size > 1) keepNode.add(nid);
}

// Assign stable output indices to kept nodes.
const nodeIndex = new Map(); // osmNodeId -> output index
const nodeLat = [];
const nodeLon = [];
for (const nid of keepNode) {
  const [lat, lon] = nodePos.get(nid);
  nodeIndex.set(nid, nodeLat.length);
  nodeLat.push(lat);
  nodeLon.push(lon);
}
console.log(`welded/kept vertices: ${nodeLat.length} (raw distinct OSM node ids seen: ${nodePos.size})`);

// ---------- pass 2: contract each way into edges between kept vertices ----------
const tagPoolIndex = new Map(); // json string -> index
const tagPool = [];
function tagIdxFor(tags) {
  const compact = {};
  for (const k of KEPT_TAG_KEYS) if (tags[k] != null) compact[k] = tags[k];
  const key = JSON.stringify(compact);
  let idx = tagPoolIndex.get(key);
  if (idx === undefined) {
    idx = tagPool.length;
    tagPoolIndex.set(key, idx);
    tagPool.push(compact);
  }
  return idx;
}

const edges = []; // { nodeA, nodeB, lengthM, polyline: [[lat,lon],...], tagIdx }
let degenerateSkipped = 0;

for (const w of ways) {
  const ids = w.nodes;
  const geom = w.geometry;
  const tagIdx = tagIdxFor(w.tags ?? {});

  let startOsmId = ids[0];
  let poly = [[geom[0].lat, geom[0].lon]];
  let lengthM = 0;

  for (let i = 1; i < ids.length; i++) {
    const prev = poly[poly.length - 1];
    const cur = [geom[i].lat, geom[i].lon];
    lengthM += haversineM(prev[0], prev[1], cur[0], cur[1]);
    poly.push(cur);

    if (keepNode.has(ids[i])) {
      // nodeA === nodeB is fine here (a real loop trail returning to the same
      // junction with genuine distance covered) — only reject near-zero
      // length, which is a duplicate-coincident-point artifact, not a loop.
      if (poly.length < 2 || lengthM < 0.5) {
        degenerateSkipped++;
      } else {
        edges.push({
          nodeA: nodeIndex.get(startOsmId),
          nodeB: nodeIndex.get(ids[i]),
          lengthM,
          polyline: poly,
          tagIdx,
        });
      }
      startOsmId = ids[i];
      poly = [cur];
      lengthM = 0;
    }
  }
}
console.log(`edges: ${edges.length} (degenerate/zero-length skipped: ${degenerateSkipped})`);

// ---------- stats: junction count (degree >= 3 in the CONTRACTED graph) ----------
const degree = new Array(nodeLat.length).fill(0);
let totalLengthM = 0;
let totalPolylinePoints = 0;
for (const e of edges) {
  degree[e.nodeA]++;
  degree[e.nodeB]++;
  totalLengthM += e.lengthM;
  totalPolylinePoints += e.polyline.length;
}
const junctionCount = degree.filter((d) => d >= 3).length;
const deadEndCount = degree.filter((d) => d === 1).length;

// ---------- connected-component check (union-find over output node indices) ----------
const parent = new Int32Array(nodeLat.length);
for (let i = 0; i < parent.length; i++) parent[i] = i;
function find(x) {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}
function union(a, b) {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[ra] = rb;
}
for (const e of edges) union(e.nodeA, e.nodeB);
const compSize = new Map();
for (let i = 0; i < parent.length; i++) {
  const r = find(i);
  compSize.set(r, (compSize.get(r) ?? 0) + 1);
}
const largestComp = Math.max(0, ...compSize.values());
const largestCompFrac = nodeLat.length > 0 ? largestComp / nodeLat.length : 0;

console.log(
  `stats: junction(deg>=3)=${junctionCount} deadEnd(deg=1)=${deadEndCount} ` +
    `totalKm=${(totalLengthM / 1000).toFixed(1)} largestComponent=${(largestCompFrac * 100).toFixed(1)}% ` +
    `(${largestComp}/${nodeLat.length} nodes, ${compSize.size} components)`,
);

// ---------- sanity gate ----------
const problems = [];
if (nodeLat.length < 500) problems.push(`too few nodes: ${nodeLat.length}`);
if (edges.length < 1000) problems.push(`too few edges: ${edges.length}`);
if (totalLengthM / 1000 < 50) problems.push(`too little total distance: ${(totalLengthM / 1000).toFixed(1)}km`);
if (junctionCount < 100) problems.push(`too few junctions: ${junctionCount}`);
if (largestCompFrac < 0.5) problems.push(`largest connected component too small: ${(largestCompFrac * 100).toFixed(1)}%`);
if (problems.length > 0) {
  console.error('FAIL: graph looks degenerate:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// ---------- encode binary ----------
const HEADER_SIZE = 44;
const NODE_SIZE = 8;
const EDGE_SIZE = 20;
const POLY_SIZE = 8;

const tagsJson = JSON.stringify(tagPool);
const tagsBytes = Buffer.from(tagsJson, 'utf8');

const nodeTableBytes = nodeLat.length * NODE_SIZE;
const edgeTableBytes = edges.length * EDGE_SIZE;
const polyTableBytes = totalPolylinePoints * POLY_SIZE;
const totalBytes = HEADER_SIZE + nodeTableBytes + edgeTableBytes + polyTableBytes + tagsBytes.length;

const buf = Buffer.alloc(totalBytes);
let off = 0;

// header
buf.write('HLXG', 0, 'ascii');
buf.writeUInt16LE(1, 4); // version
buf.writeUInt16LE(0, 6); // flags
buf.writeUInt32LE(nodeLat.length, 8);
buf.writeUInt32LE(edges.length, 12);
buf.writeUInt32LE(totalPolylinePoints, 16);
buf.writeUInt32LE(tagPool.length, 20);
buf.writeUInt32LE(tagsBytes.length, 24);
const minLat = Math.min(...nodeLat);
const maxLat = Math.max(...nodeLat);
const minLon = Math.min(...nodeLon);
const maxLon = Math.max(...nodeLon);
buf.writeInt32LE(Math.round(minLat * 1e6), 28);
buf.writeInt32LE(Math.round(minLon * 1e6), 32);
buf.writeInt32LE(Math.round(maxLat * 1e6), 36);
buf.writeInt32LE(Math.round(maxLon * 1e6), 40);
off = HEADER_SIZE;

// node table
for (let i = 0; i < nodeLat.length; i++) {
  buf.writeInt32LE(Math.round(nodeLat[i] * 1e6), off);
  buf.writeInt32LE(Math.round(nodeLon[i] * 1e6), off + 4);
  off += NODE_SIZE;
}

// edge table (write now; polyline offsets computed as we go) + polyline pool
const edgeTableStart = off;
const polyPoolStart = edgeTableStart + edgeTableBytes;
let polyCursor = 0; // point index within the pool

off = edgeTableStart;
let polyOff = polyPoolStart;
for (const e of edges) {
  buf.writeUInt32LE(e.nodeA, off);
  buf.writeUInt32LE(e.nodeB, off + 4);
  buf.writeFloatLE(Math.fround(e.lengthM), off + 8);
  buf.writeUInt32LE(polyCursor, off + 12);
  buf.writeUInt16LE(e.polyline.length, off + 16);
  buf.writeUInt16LE(e.tagIdx, off + 18);
  off += EDGE_SIZE;

  let prevLatE6 = 0;
  let prevLonE6 = 0;
  e.polyline.forEach(([lat, lon], i) => {
    const latE6 = Math.round(lat * 1e6);
    const lonE6 = Math.round(lon * 1e6);
    if (i === 0) {
      buf.writeInt32LE(latE6, polyOff);
      buf.writeInt32LE(lonE6, polyOff + 4);
    } else {
      buf.writeInt32LE(latE6 - prevLatE6, polyOff);
      buf.writeInt32LE(lonE6 - prevLonE6, polyOff + 4);
    }
    prevLatE6 = latE6;
    prevLonE6 = lonE6;
    polyOff += POLY_SIZE;
    polyCursor++;
  });
}
off = polyPoolStart + polyTableBytes;

// tags blob
tagsBytes.copy(buf, off);
off += tagsBytes.length;

if (off !== totalBytes) {
  console.error(`FAIL: byte accounting mismatch — wrote ${off}, expected ${totalBytes}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const binPath = join(OUT_DIR, 'graph.bin');
writeFileSync(binPath, buf);
console.log(`wrote ${binPath} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);

if (buf.length > 8 * 1024 * 1024) {
  console.error(`FAIL: graph.bin exceeds 8MB budget (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
  process.exit(1);
}

// ---------- POIs (trailheads + peaks passthrough) ----------
console.log(`==> reading ${PEAKS_PATH}`);
const peaksRaw = JSON.parse(readFileSync(PEAKS_PATH, 'utf8'));
const peakNodes = peaksRaw.elements.filter((e) => e.type === 'node' && e.tags?.natural === 'peak');
const trailheadTagged = peaksRaw.elements.filter(
  (e) => Object.entries(e.tags ?? {}).some(([k, v]) => /trailhead|trail_head/i.test(`${k}=${v}`)) || e.tags?.tourism === 'information',
);
if (trailheadTagged.length > 0) {
  console.log(`note: found ${trailheadTagged.length} trailhead-tagged node(s) in peaks.json (not auto-added — review manually)`);
}

const peaks = peakNodes.map((e) => ({
  name: e.tags.name ?? `Peak ${e.id}`,
  lat: e.lat,
  lon: e.lon,
  ele: e.tags.ele != null ? Number(e.tags.ele) : null,
}));

const pois = { trailheads: TRAILHEADS, peaks };
const poisPath = join(OUT_DIR, 'pois.json');
writeFileSync(poisPath, JSON.stringify(pois, null, 2));
console.log(`wrote ${poisPath} (${TRAILHEADS.length} trailheads, ${peaks.length} peaks)`);

console.log('==> done');
console.log(
  JSON.stringify(
    {
      inputWays: allWays.length,
      inputPoints,
      keptWays: ways.length,
      vertices: nodeLat.length,
      edges: edges.length,
      junctions: junctionCount,
      deadEnds: deadEndCount,
      totalKm: Number((totalLengthM / 1000).toFixed(1)),
      largestComponentPct: Number((largestCompFrac * 100).toFixed(1)),
      binBytes: buf.length,
    },
    null,
    2,
  ),
);
