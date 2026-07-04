# Architecture

Helius is a single-origin browser app with no application backend. Gemma 4 runs
in the browser on WebGPU; every tool the agent calls is a deterministic local
function; the map and routing data are static files. A static host (Cloudflare
Pages + R2) streams the model weights and region packs on first load — after
that the app is fully offline and installable.

Everything in `src/` was built during the RAISE 2026 event window.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Boots the UI shell; registers the service worker (prod only). |
| `src/app/` | Framework-free DOM shell: header (offline badge, tier chip), chat, **tool-trace rail**, map panel, voice/camera controls. |
| `src/lib/contract.ts` | **The one shared contract** between the UI and the engine. Both sides import only this. `AgentEvent` union, `ChatMessage`, `ToolSpec`, `EngineStatus`. |
| `src/agent/` | `createHelius()` façade + the agent loop. Owns the turn: build messages → generate → parse → run tools → regenerate. |
| `src/llm/` | Main-thread engine **client** (`engine.ts`), the worker wire protocol (`protocol.ts`). |
| `src/workers/llm.worker.ts` | Worker-hosted inference: transformers.js + Gemma 4 on WebGPU, tier cache, prewarm, hot-swap. |
| `src/lib/parse.ts` | Pure tool-call parsing, marker stripping, and the streaming display filter. Unit-tested. |
| `src/tools/` | The tool registry (7 tools) + per-tool state (GPS fix, active pack, pending route, camera frame, Morse timing). |
| `src/map/` | MapLibre GL renderer: offline PMTiles basemap + terrain contours, live fix/route/beacon overlays. A\* routing core (`graph-core.mjs`) shared with the Node test. |
| `src/speech/` | Voice **in** (`stt.ts`: mic → 16 kHz mono Float32) and **out** (`tts.ts`: Kokoro). Audio never leaves the device. |

The UI never imports the engine internals — only `createHelius()` and types from
`contract.ts`. That single seam is what let the engine, UI, map, and graph be
built in parallel.

## Inference is worker-hosted

transformers.js + Gemma 4 run inside a module Worker (`llm.worker.ts`); WebGPU
works in workers in Chrome, so prefill/decode never touch the main thread. The
main-thread client (`engine.ts`) talks to it over a small typed protocol
(`protocol.ts`):

| Message (main → worker) | Purpose |
| --- | --- |
| `load { tier, modelBaseUrl, prewarm }` | Set the model host, load the primary tier, optionally pre-warm the other. |
| `setTier { tier }` | Hot-swap tiers (instant if warm; loads on demand otherwise). |
| `generate { id, kind, messages, tools?, audio?, image? }` | Run a chat / transcription / vision generation. `audio` and `image` are sent as **transferables**. |
| `abort { id }` | Interrupt an in-flight generation. |

The worker streams `token` messages back as text decodes, then a final `result`
(full raw text + timing). Status flows as `engine-status` events:
`downloading{pct} → compiling → ready{tier, loadMs}` (or `error`).

### Model loading: `remoteHost`, not `localModelPath`

The weights load through transformers.js's **remote** pathway:

```
env.allowRemoteModels = true;  env.allowLocalModels = false;
env.remoteHost = modelBaseUrl;  env.remotePathTemplate = '{model}';
```

This is a real, load-bearing decision. transformers.js 4.2.0's
`get_file_metadata` treats an **absolute-URL** `localModelPath` as a *remote*
source; with `allowRemoteModels = false` it short-circuits to `exists: false`,
`get_tokenizer_files` returns `[]`, and the tokenizer config destructures to
`undefined` (`reading 'tokenizer_class'`). `remoteHost` / `remotePathTemplate`
is the library's native cross-origin mechanism (the same one the HF CDN uses)
and works identically for the dev mirror (`localhost:8737`) and prod R2.

### Two tiers, instant hot-swap

E2B and E4B are **both full multimodal q4f16** checkpoints (embed, decoder,
vision encoder, audio encoder) loaded the same way. The worker keeps a
per-tier instance cache. On startup it loads the primary tier and reports
`ready`; then, **only if pre-warm is explicitly enabled** (`createHelius({ prewarm })`,
wired to a `?prewarm=1` / localStorage flag the shell sets), it **silently
pre-warms the other tier** into the cache. `setTier` is then an instant ref
swap (`ready { loadMs: 0 }`); otherwise — pre-warm off, or still in flight — it
falls back to an on-demand load with a `compiling` status (~19 s). Pre-warm is
**opt-in and off by default on purpose**: holding two q4f16 stacks resident
risks a WebGPU OOM, which can kill the tab rather than throw, so ordinary
machines shouldn't do it automatically (`navigator.deviceMemory` is privacy-
capped at 8, so a memory heuristic can't tell an 8 GB laptop from a 32 GB one).
A pre-warm failure is swallowed; the tier just loads on demand later. E4B
decodes ~2× slower than E2B — that contrast is the MatFormer "elasticity" beat.

### Cache resilience

A truncated config/template written during a flaky first load can permanently
brick loading. On a primary-load failure the worker purges **only** the small
`.json` / `.jinja` entries under the current `remoteHost` from Cache Storage
(the multi-GB weights stay cached), then retries the load **once** before
emitting `error`.

## The agent loop

`src/agent/loop.ts`, one user turn:

1. Build `messages = [system, ...history, user]`.
2. `generate` with the tool specs. Stream visible tokens to the UI as
   `assistant-token` — **but** the display filter suppresses tool-call turns
   (the trace rail shows those) and only streams a real prose answer.
3. Parse the raw output (`parse.ts`). If it contains tool calls: emit
   `tool-start`, run the tool from the registry, emit `tool-done` / `tool-error`,
   append the assistant tool-call message and the tool result, and **regenerate**.
4. Loop up to **6 steps**, then a final plain-text answer → `assistant-done` +
   `speak`.

Voice turns transcribe first (native Gemma 4 audio-in) → emit the transcript as
`user-message` → then run the normal text turn. `readSign()` runs native Gemma 4
vision **as the `read_sign` tool** so it appears in the trace.

### Message shapes are LOCKED (jinja engine quirks)

Verified against the model's `chat_template.jinja` on the H0 spike, and encoded
in `contract.ts` — do not change:

- **Assistant tool call:** `{ role:'assistant', tool_calls:[{ type:'function', function:{ name, arguments } }] }` — `arguments` MUST be an **object**. A string renders as `{{}}` and the model ignores it.
- **Tool result:** `{ role:'tool', name, content }` — `content` MUST be a **JSON string**. A mapping throws (`format_tool_response_block`'s mapping branch is broken in `@huggingface/jinja`); the string form renders `response:name{value:<|"|>…<|"|>}` and the model consumes it cleanly.

Tool-call markers (`<|tool_call>`, `<|"|>`, `<|turn>`, …) are ordinary BPE text,
not special tokens — so `parse.ts` matches them as literal strings on the raw
(`skip_special_tokens:false`) decode, and the display filter strips them for the
chat.

## Tools

| Tool | What it returns (deterministic, offline, never throws) |
| --- | --- |
| `locate` | Current GPS fix (lat/lon/accuracy/elevation) — real Geolocation in the field, a simulated fix in demo mode. |
| `sun_clock` | Sunset + minutes of daylight/usable light, from offline NOAA solar math (`src/lib/sun.ts`). |
| `pace_eta` | Naismith's-rule ETA for a distance/climb, and whether it beats sunset. |
| `route_back` | **A\* over the pack graph** — see below. |
| `safety_plan` | An ordered shelter/signal/stay-put-vs-move checklist from position + remaining light. Non-medical. |
| `morse_beacon` | Morse timing pattern for a message (default SOS); emits a `beacon` event the UI strobes. |
| `read_sign` | Native Gemma 4 vision over a camera frame: transcribe → translate → one action line. |

### `route_back` and the `pendingRoute` pattern

`route_back` (`src/tools/route.ts`) lazy-loads and caches each pack's `graph.bin`
+ `pois.json`, resolves the destination enum against the pack's trailheads —
which the pack pipeline tags with a matching `role`
(`trailhead` / `crest` / `tram_station`), so packs swap with no code change —
and runs A\* (`src/map/route.ts`) from the current fix.

The route geometry (a full GeoJSON `LineString`, often 1000+ points) must reach
the map **without** entering the model's context window. So the tool returns
only compact numbers to the model (`distance_m`, `eta_min`, `waypoints`, …) and
**stashes the geometry** as a module-level pending route. The agent loop picks it
up right after the tool succeeds and emits the `route` `AgentEvent`
(`{ geojson, distanceM, etaMin }`) for the map to draw. `off_network` / `no_path`
come back as graceful `{ error }` tool results.

## Offline map + routing data

MapLibre GL renders a dark "night-ops" style over local `.pmtiles` archives:
a Protomaps vector basemap, plus a Mapterhorn terrain DEM driven through
`maplibre-contour` for hillshade + contours (a main-thread DEM "fetch bridge"
serves DEM tiles out of the single `terrain.pmtiles` archive — details in
[`src/map/README.md`](../src/map/README.md)). Routing runs over `graph.bin`, a
compact binary trail graph built from OpenStreetMap by `scripts/build-graph.mjs`
— format spec in [`src/map/graph-format.md`](../src/map/graph-format.md). The
same `graph-core.mjs` powers both the browser and `scripts/test-route.mjs`, so
the routing code under test is the code that ships.

## Caching / offline strategy

Two cooperating layers persist everything after the first load:

| Asset class | Cached by | Strategy |
| --- | --- | --- |
| App shell (JS/CSS/HTML/SVG/PNG/woff2/manifest) | `vite-plugin-pwa` (Workbox) precache | Precached at install; loads with zero network every time. |
| Model config + weights (`.onnx` / `.onnx_data` / …) | transformers.js **Cache Storage** (`transformers-cache`), from `remoteHost`; Workbox `ml-models` CacheFirst as a backstop | Streamed once from R2/mirror, then served from cache — offline forever after. |
| Map packs (`*.pmtiles`) | Workbox `map-data` CacheFirst, `rangeRequests: true` | pmtiles are read via Range; the app "pack warm-up" does one full `GET` (a cacheable `200`), and `rangeRequests` then slices that cached full body to answer offline Range reads. |
| Map glyphs + sprites (`/vendor/…`) | Workbox `map-assets` CacheFirst | Too many fontstacks to precache; cached on demand. |
| Pack data (`pois.json` / manifests / `graph.bin`) | Workbox `pack-data` CacheFirst — registered **before** the model-weights rule | Per-region routing + POI data; ordering keeps `graph.bin` out of the LLM shards' eviction budget. |

**Cross-origin isolation.** WebGPU + transformers.js need a `crossOriginIsolated`
context (SharedArrayBuffer / WASM threads). Dev (`vite.config.ts`) and prod
(`public/_headers`) both set `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: credentialless`. `credentialless` (not
`require-corp`) is required so the public R2 bucket — which doesn't send a
`Cross-Origin-Resource-Policy` header — still loads; `require-corp` would block it.
`index.html` and `sw.js` are served `Cache-Control: no-cache` so PWA
auto-updates aren't served stale.

## Verification

- `src/lib/parse.ts` — 37 unit tests (`tests/parse.test.ts`), incl. the exact spike tool-call strings, malformed input, and the streaming filter.
- `src/tools/morse.ts` — 8 unit tests (`tests/morse.test.ts`).
- Routing core — `scripts/test-route.mjs` (10 checks) runs the shipped `graph-core.mjs` against the real `graph.bin` (BFS connectivity, the demo route, off-network handling).
- Runtime numbers — `spike/RESULTS.md`.
