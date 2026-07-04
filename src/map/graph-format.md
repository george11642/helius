# `graph.bin` binary format (v1)

Compact routable-graph encoding produced by `scripts/build-graph.mjs` from raw
Overpass `out geom` trail data, and parsed by `src/map/graph-core.mjs` (shared,
isomorphic — used by both the browser via `src/map/graph.ts` and Node via
`scripts/test-route.mjs`).

All multi-byte integers/floats are **little-endian**. Coordinates are stored
as **microdegrees** (`degrees * 1e6`, rounded to nearest integer, `int32`) —
~0.11m precision at this latitude, half the size of `float64` degrees.

## Node identity

Graph nodes are **not** raw OSM nodes. A node in this file is a "kept vertex":
either a real trail junction (an OSM node touched by ≥2 ways, or one that
occurs more than once within a single way's node list — e.g. a closed loop),
or a way endpoint (dead-end, trailhead, summit spur, or a point where one way
tag-boundary meets another). Interior chain nodes — points that lie strictly
inside a single way, with no other way touching them — are contracted away;
their coordinates survive only as interior points of an edge's polyline.
Welding uses **exact OSM node-id identity** (not coordinate rounding): Overpass
`out geom` gives each way's `nodes[]` (OSM ids) 1:1 with `geometry[]`
(lat/lon), so shared ids across ways are ground-truth shared vertices — no
epsilon/proximity judgment call needed.

## Layout

```
[ header: 44 bytes ]
[ node table:     nodeCount           * 8  bytes ]
[ edge table:     edgeCount           * 20 bytes ]
[ polyline pool:  polylinePointCount  * 8  bytes ]
[ tags blob:      tagsBlobBytes bytes (raw UTF-8) ]
```

File length MUST equal `44 + nodeCount*8 + edgeCount*20 + polylinePointCount*8 + tagsBlobBytes`.
The build script asserts this before writing; the parser does not re-check it.

### Header (44 bytes)

| offset | size | field | notes |
| --- | --- | --- | --- |
| 0  | 4 | `magic` | ASCII bytes `"HLXG"`, no terminator |
| 4  | 2 | `version` | `uint16`, currently `1` |
| 6  | 2 | `flags` | `uint16`, reserved, currently `0` |
| 8  | 4 | `nodeCount` | `uint32` |
| 12 | 4 | `edgeCount` | `uint32` |
| 16 | 4 | `polylinePointCount` | `uint32` — total points across every edge's polyline, summed |
| 20 | 4 | `tagCount` | `uint32` — length of the tags JSON array (informational; the parser can also just check `.length` after `JSON.parse`) |
| 24 | 4 | `tagsBlobBytes` | `uint32` — byte length of the trailing JSON blob |
| 28 | 4 | `minLatE6` | `int32`, bbox, microdegrees |
| 32 | 4 | `minLonE6` | `int32` |
| 36 | 4 | `maxLatE6` | `int32` |
| 40 | 4 | `maxLonE6` | `int32` |

### Node table (starts at byte 44)

`nodeCount` records, 8 bytes each, indexed `0..nodeCount-1` — this index is
the `nodeA`/`nodeB` value used by the edge table.

| size | field |
| --- | --- |
| 4 | `latE6` (`int32`) |
| 4 | `lonE6` (`int32`) |

### Edge table (starts right after the node table)

`edgeCount` records, 20 bytes each. An edge is one contracted trail/road
segment between two kept vertices (see "Node identity" above); it carries
the **full** polyline between them (not just its endpoints), summed
haversine length (not straight-line endpoint distance — trails wind), and an
index into the tags pool for the source way's `highway`/`name`/`sac_scale`/
`surface`. The graph is **undirected** — one edge record serves both
traversal directions; `nodeA`/`nodeB` order only fixes the polyline's stored
direction (see decode note below).

| size | field | notes |
| --- | --- | --- |
| 4 | `nodeA` (`uint32`) | node-table index |
| 4 | `nodeB` (`uint32`) | node-table index |
| 4 | `lengthM` (`float32`) | summed haversine over the polyline, meters |
| 4 | `polylineOffset` (`uint32`) | **point** index (not byte) into the polyline pool |
| 2 | `polylineCount` (`uint16`) | number of points in this edge's polyline, always ≥2 |
| 2 | `tagIdx` (`uint16`) | index into the tags JSON array |

### Polyline pool (starts right after the edge table)

`polylinePointCount` records, 8 bytes each — a flat sequence of point runs,
one run per edge, back to back in edge-table order, each run `polylineCount`
points long starting at `polylineOffset`.

| size | field |
| --- | --- |
| 4 | `latE6 or deltaLatE6` (`int32`) |
| 4 | `lonE6 or deltaLonE6` (`int32`) |

**Decoding a run (points `offset .. offset+count-1`):** the first point in
the run is **absolute** microdegrees. Every subsequent point in the *same
run* is a **delta from the previous point in that run** (also microdegrees):
`lat[i] = lat[i-1] + deltaLatE6[i]`. Deltas reset at the start of each edge's
run — there is no cross-edge delta chaining. This means points must be
decoded in order from the start of a run; there is no random access to a
mid-run point without walking from `offset`. Runs always go from `nodeA`'s
coordinates (first point) to `nodeB`'s coordinates (last point) as stored —
if a route traverses the edge from `nodeB` to `nodeA`, the consumer reverses
the decoded point array.

### Tags blob (starts right after the polyline pool, runs to EOF)

Raw UTF-8 bytes of `JSON.stringify(tagsArray)`, where `tagsArray[i]` is a
compact tag object with **absent fields omitted** (not `null`/`undefined`
placeholders):

```ts
{ highway?: string; name?: string; sac_scale?: string; surface?: string }
```

Parse with `JSON.parse(new TextDecoder().decode(bytes))`; `tagIdx` in the
edge table indexes into this array.

## Worked example

An edge with `polylineOffset=100`, `polylineCount=3`, whose 3 pool entries
(as stored, LE int32 pairs) are:

```
[ 35228600, -106481800 ]   // point 100 — absolute
[     -120,        340 ]   // point 101 — delta from point 100
[      -95,        210 ]   // point 102 — delta from point 101
```

decodes to (microdegrees, then divided by 1e6 for degrees):

```
point 100: lat=35228600            lon=-106481800            -> (35.2286,   -106.4818)
point 101: lat=35228600 + -120     lon=-106481800 + 340       -> (35.228480, -106.481460)
point 102: lat=35228480 + -95      lon=-106481460 + 210       -> (35.228385, -106.481250)
```

## Not in v1

No elevation/ascent data — `graph.bin` is purely 2D. `route()` in
`src/map/route.ts` always returns `ascentM: null` and documents this as a
known v1 gap (a terrain-tile-based elevation lookup would need to join
against `terrain.pmtiles`, out of scope for this pass).
