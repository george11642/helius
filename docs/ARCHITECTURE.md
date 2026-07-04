# Architecture (skeleton)

This is a map of the scaffold, not a design doc — it gets filled in as modules land during the build.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/main.ts` | Boots the app shell, registers the service worker. |
| `src/app/shell.ts` | Renders the DOM shell: header (wordmark, offline badge, model chip), chat/voice panel, map panel, status-bar footer, tool-trace overlay. Framework-free. |
| `src/state.ts` | Tiny typed event-emitter store that feature modules publish into; the shell subscribes to re-render. |
| `src/agent/` | The agent loop: parses hiker intent, plans a tool-call chain, streams results to the shell. |
| `src/llm/` | Model loading + inference (Gemma 4 E2B via `@huggingface/transformers`, WebGPU). |
| `src/tools/` | The tool registry the agent calls into: offline map lookup, A* routing, sun clock, sign OCR, Morse beacon. |
| `src/map/` | MapLibre GL init: offline PMTiles basemap + terrain contours for the active region pack. |
| `src/speech/` | Local speech in (`stt.ts`) and out (`tts.ts`) — voice never leaves the device. |
| `src/workers/` | Dedicated workers off the main thread; `model-fetch.worker.ts` streams LLM weights into OPFS. |

## Offline strategy

| Asset class | Strategy | Why |
| --- | --- | --- |
| App shell (JS/CSS/HTML/fonts/manifest) | Precached by the service worker (`vite-plugin-pwa`, `registerType: 'autoUpdate'`) | Must load with zero network, every time. |
| Map region packs (`*.pmtiles`) | Runtime-cached, `CacheFirst`, cache name `map-data` | Large but static per region; fetched once, then served from cache. |
| LLM weights (`.onnx` / `.onnx_data` / `.bin` / `.wasm`) | Chunked Range-request download straight to OPFS via `src/workers/model-fetch.worker.ts` — **never** the Service Worker cache | Multi-GB files would blow past any reasonable SW cache budget and can't be range-resumed through Workbox; OPFS gives resumable, quota-friendly storage the main thread doesn't block on. |

## Status

Everything in `src/` was built during the RAISE Summit Hackathon event window — this file describes scaffold structure only, filled in incrementally as real behavior lands.
