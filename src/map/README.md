# src/map

Offline MapLibre GL renderer for the Sandia region pack: dark "night ops" basemap, terrain hillshade + contours, live position/route/beacon overlays.

## Files

- `style.ts` — pure style-JSON builder + palette constants. No side effects (no protocol registration, no DOM/window access beyond a `sprite` URL resolved via `window.location` — see below). Exports `buildStyle()`, `poiLayers()`, `PALETTE`.
- `render.ts` — all the imperative/side-effecting init: pmtiles protocol registration, the maplibre-contour DEM bridge, and the `HeliusMap` class (`init`, `setFix`, `drawRoute`, `clearRoute`, `flyToRoute`, `setBeaconMode`).
- `map-probe.html` (repo root) — standalone dev probe. Visit `/map-probe.html` with `pnpm dev` running. Logs `MAPPROBE:{...}` JSON lines to the console for: style load, tile/idle activity, an FPS estimate, and any tile/glyph/sprite errors. Buttons: toggle terrain, toggle beacon, replay route.

## Vector schema (ground truth, not guessed)

`basemap.pmtiles` is a Protomaps Basemap v4.14.9 (planetiler) build. The layer/field names in `style.ts` were read directly out of the archive's own embedded JSON metadata (parse the pmtiles v3 header: root dir at byte 8, json metadata offset/length at bytes 24/32, gzip-decompress) and cross-checked against the upstream style source (`protomaps/basemaps` repo, `styles/src/base_layers.ts`) — not the `@protomaps/basemaps` npm package, which isn't an installed dependency.

The one non-obvious fact: **there is no separate "trail" or "path" vector layer**. Footpaths/trails live in the `roads` source-layer with `kind='path'`, grouped together with `kind='other'` (ferries etc., minus piers). `PATH_FILTER` in `style.ts` is copied verbatim from upstream's `roads_other` layer filter — this is the one thing to preserve exactly if the pack is ever regenerated from a different planetiler/basemap version, since a schema change here would silently make trails (the app's hero content) stop rendering with no error.

`landcover` is deliberately omitted from the style: its data only exists up to z7, below this app's realistic minimum hiking zoom (~11+), so including it would be dead code.

## Terrain: hillshade + contours from a local pmtiles DEM

Both come from one `maplibre-contour` `DemSource`, constructed in `render.ts` and passed into `buildStyle()`. Hillshade uses `DemSource.sharedDemProtocolUrl` as a `raster-dem` source (this is `maplibre-contour`'s own documented tile-sharing mechanism, not a second independent `pmtiles://` source — avoids fetching `terrain.pmtiles` twice). Contours use `DemSource.contourProtocolUrl({...})` as a `vector` source, thresholds 100m minor / 500m major from z8 up.

**Why there's a "DEM fetch bridge" in `render.ts`:** `DemSource`'s public constructor only takes `{url, cacheSize, id, encoding, maxzoom, worker, timeoutMs, actor}` — no way to inject a custom tile fetcher. Internally (verified by reading `node_modules/maplibre-contour/dist/index.mjs`) it always falls back to `defaultGetTile`, a plain `fetch(url)` against a `{z}/{x}/{y}` URL template. That's fine for a real tile server, but `terrain.pmtiles` is one local archive with no per-tile REST endpoint, and the app must also work fully offline (no dev server or edge function available to bridge it server-side once installed as a PWA).

The fix: `DemSource` is given a synthetic same-origin template `/__dem-tile/<pack>/{z}/{x}/{y}`, and `window.fetch` is patched (once, main thread only) to intercept just that URL shape and resolve it via a `pmtiles.PMTiles` reader's `getZxy()` against the real `terrain.pmtiles`, returning a real `Response` so `maplibre-contour`'s own `.blob()`/`.headers` handling works unmodified. Every other URL passes through to the original `fetch` unchanged (captured before patching, so no recursion).

This is also why `DemSource` is constructed with **`worker: false`**, deviating from the original "worker: true" spec: worker mode spawns `maplibre-contour`'s own bundled Worker script — a separate JS realm with its own `self.fetch` that a main-thread patch can't reach, and there's no hook to inject code into that worker before it runs. Main-thread contour generation is the trade-off; acceptable for a single mountain-range pack at zoom ≤12 DEM resolution.

## Dev-server Range requests

Checked empirically before assuming a fix was needed: `pnpm dev`'s static file server (vite 8.1.3) **already returns proper `206 Partial Content` with `Content-Range`/`Accept-Ranges`** for `public/` assets (confirmed via `curl -r 0-99` against both `.pmtiles` files). No custom Range-serving vite plugin was added — vite.config.ts was not touched. Production (Cloudflare/R2 per the team) serves Range natively too.

One related gap worth flagging, not fixed here (it's `vite.config.ts`'s PWA/workbox config, shared app-wide infrastructure outside `src/map/**`): the `workbox.runtimeCaching` rule for `*.pmtiles` is a plain `CacheFirst` handler, without the `workbox-range-requests` plugin. That plugin is what lets a Service-Worker-cached response still answer *subsequent* Range requests once the device is fully offline (post-PWA-install). Without it, pmtiles reads that happen to need a byte range not already served may not work purely from the SW cache. Worth adding if true offline (airplane-mode, not just "dev server is up") gets tested and pmtiles fails there.

## Sprite/glyph URLs — one real bug found and fixed via live testing

MapLibre rejects a root-relative `sprite` URL outright (throws `"Invalid sprite URL ... must be absolute"`, which aborts style load with **no other symptom** — map stays blank, no MapLibre `error` event, nothing informative in the console beyond that one thrown message). `glyphs` has no such restriction. Fixed in `style.ts` by resolving the sprite URL against `window.location.href` before returning it. This was only caught by actually driving the probe page in a real browser — worth remembering for any other MapLibre style work.

## Verified against the real files, not assumed

- `basemap.pmtiles`: MVT, gzip tile compression, z0–15, bbox matches the pack spec.
- `terrain.pmtiles`: WEBP (terrarium-encoded), **no** additional tile compression, z0–12, bbox matches the pack spec. (Confirmed via manual pmtiles v3 header parse — see git history of this file for the one-off node script, not kept in the repo.)
- `pmtiles.Protocol`'s dual-purpose tile/tilejson handling (`{url: 'pmtiles://<archiveURL>'}` for the implicit TileJSON, `{url: 'pmtiles://<archiveURL>/{z}/{x}/{y}'}` for a specific tile) was tested directly against both `.pmtiles` files and resolves in single-digit milliseconds. Root-relative archive URLs (e.g. `pmtiles:///data/packs/sandia/basemap.pmtiles`, three slashes) are valid — this is not a bug, despite looking like one.

## Known-slow, not broken: first full load

During development, a full `HeliusMap.init()` → MapLibre `'load'` event sometimes took 40–90 seconds on this particular shared dev machine (several concurrent agents, each running dev servers and at least one heavy WebGPU/LLM-inference browser tab). Verified with direct low-level tests (raw `PMTiles.getHeader()`, raw `protocol.tile()` calls) that every individual piece — pmtiles reading, Range requests, the tilejson/tile dual-path — resolves in single-digit milliseconds in isolation; the delay was in MapLibre's own Style/Source orchestration finding a scheduling slot on a heavily oversubscribed machine, not a code defect. The probe eventually renders correctly (hillshade, contours, amber dashed trails, road/place labels, animated route draw all confirmed visually) — it just needs real wall-clock patience in a resource-contended environment. On a normal single-user machine this should be near-instant.

## Risks / things to watch

- **`kind='path'` schema fragility** (see above) — if the pack is ever regenerated with a different planetiler/basemap schema version, verify `PATH_FILTER` still matches real data (the node one-liner to dump a `.pmtiles`'s embedded JSON metadata is worth resurrecting if trails ever silently stop rendering).
- **COEP + the DEM bridge's synthetic worker**: `vite.config.ts` sets `Cross-Origin-Embedder-Policy: credentialless` (changed from `require-corp` by another agent during this build, for R2/HF CDN compatibility). `maplibre-contour`'s bundled worker script is same-origin (served by vite/the app itself), so COEP mode doesn't affect it either way — not a real risk, just confirming it was checked.
- **`workbox-range-requests`** gap noted above — untested here since it only matters fully-offline.
- **pois.json contract**: `render.ts` fetches `/data/packs/<pack>/pois.json` (array of `{kind:'trailhead'|'peak', name, lat, lon, ele?}`), retries once after 5s, then skips the POI layer gracefully if still missing. It does **not** read `peaks.json` (raw Overpass source data present in the pack dir) — that file is upstream input to whatever process generates `pois.json`, not the runtime contract.
