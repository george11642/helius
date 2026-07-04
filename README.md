# Helius

### The AI that works when nothing else does.

Helius is an offline-first, installable web app that runs **Gemma 4 entirely on your device** — no cloud, no signal, no account, no data leaving the phone. It's a voice-capable agent that chains **real local tools** — offline maps, A\* trail routing, sun/pace math, native sign-reading, a Morse strobe beacon — to get a lost hiker back to the trailhead before dark. Every position, route, and time comes from a deterministic on-device tool; the model orchestrates, it never invents the facts.

Built during the **RAISE Summit Hackathon 2026** for the **Google DeepMind — Statement Five** track: *the best web/edge application running Gemma locally for offline, privacy-first inference.*

> ### Scope: non-medical by design
> Helius is a **navigation, signaling, and procedural field-tools** agent. It is deliberately **non-medical and non-diagnostic** — it refuses medical questions on principle and redirects to emergency services, and it surfaces that refusal as a feature. Deterministic local tools are orchestrated by Gemma; the model is not asked to be a doctor, and it is not asked to guess.

---

## The demo

Phone in **airplane mode**, visibly, the whole time.

1. The hiker taps the mic and says: *"I'm off the trail and I'm not sure where I am. Get me back to the trailhead before sunset."*
2. Gemma 4 transcribes the speech **on-device** (native audio-in — no separate STT service), and the **tool-trace rail** lights up as the agent reasons:
   `locate → sun_clock → route_back → pace_eta → safety_plan → morse_beacon(armed)`
3. The route **draws on a real offline map** (Protomaps vector basemap + terrain contours for the Sandia Mountains, served from a local pack — zero tiles fetched from the network).
4. Helius **speaks** the answer through an on-device voice: how much daylight is left, the distance and ETA back, and the single most important thing to do now — in both metric and imperial.
5. Point the camera at a **French trail sign** and Helius reads it natively — transcribes it verbatim, translates it, and turns it into one actionable line — again, entirely on-device.

Nothing in that sequence touches a network. That's the point: **the agentic reasoning is visible** (the tool trace is the hero UI), and it keeps working when the bars hit zero.

---

## Architecture

Everything below runs in the browser. The only "backend" is a static file host (Cloudflare Pages + R2) that streams the model weights and map packs **once**; after that the app is fully offline, installable, and self-contained.

```
                        ┌──────────────────────────── the browser (one origin, crossOriginIsolated) ────────────────────────────┐
                        │                                                                                                        │
   user: voice / text / │   ┌───────────────┐        ┌──────────────────────────┐        ┌─────────────────────────────────┐    │
   camera ─────────────────▶│  UI shell     │  events │   Agent loop             │  tools │  Tool registry (deterministic)  │    │
                        │   │  (framework-  │◀───────▶│  src/agent/loop.ts       │◀──────▶│  locate · sun_clock · pace_eta  │    │
                        │   │   free DOM)   │         │  parse → call → regen×N  │        │  route_back · safety_plan       │    │
                        │   │  tool trace,  │         │  (max 6 steps)           │        │  morse_beacon · read_sign       │    │
                        │   │  map, chat    │         └───────────┬──────────────┘        └───────────────┬─────────────────┘    │
                        │   └──────┬────────┘                     │ createHelius() façade                 │                      │
                        │          │                              │ (src/lib/contract.ts)                 │                      │
                        │   ┌──────▼────────┐        ┌────────────▼─────────────┐        ┌────────────────▼─────────────────┐    │
                        │   │ Kokoro TTS    │        │  LLM engine client       │  RPC   │  Offline map + routing           │    │
                        │   │ (on-device    │        │  src/llm/engine.ts       │◀──────▶│  MapLibre GL + PMTiles + DEM     │    │
                        │   │  voice out)   │        └────────────┬─────────────┘        │  ngraph A* over graph.bin        │    │
                        │   └───────────────┘                     │ postMessage / transferables                              │    │
                        │                            ┌────────────▼─────────────┐        └──────────────────────────────────┘    │
                        │                            │  Module Worker           │                                                │
                        │                            │  src/workers/llm.worker  │   Gemma 4 E2B / E4B · q4f16 · WebGPU            │
                        │                            │  transformers.js 4.2.0   │   two-instance cache · prewarm · hot-swap      │
                        │                            └────────────┬─────────────┘                                                │
                        │                                         │                                                              │
                        │   ┌─────────────────────────────────────▼──────────────────────────────────────────────────────┐     │
                        │   │  Cache Storage + Service Worker  —  model weights, map packs, app shell cached after 1st load│     │
                        │   └─────────────────────────────────────┬──────────────────────────────────────────────────────┘     │
                        └─────────────────────────────────────────┼────────────────────────────────────────────────────────────┘
                                                                  │  first load only (then never again)
                                                     ┌────────────▼────────────┐
                                                     │  Static host: R2 + Pages │  q4f16 weight set · *.pmtiles packs
                                                     └─────────────────────────┘
```

- **Inference is worker-hosted.** transformers.js + Gemma 4 run inside a module Worker on WebGPU, so prefill/decode never block the UI. The main thread talks to it over a small typed protocol (`load` / `generate` / `setTier` / `abort`, streamed tokens back, transferable buffers for audio and camera frames).
- **The agent loop is native tool-calling, not a grammar hack.** Gemma 4 emits its own `<|tool_call>call:NAME{args}<tool_call|>` format; we parse it, run the tool locally, feed the result back as a `role:'tool'` message, and regenerate — up to 6 steps — until the model produces a final spoken answer. Tool-call turns are suppressed from the chat and shown as the trace rail instead.
- **Two model tiers, instant switch.** E2B (fast) and E4B (stronger) are both full multimodal q4f16. On hardware with the memory for it, pre-warming both (opt-in, `?prewarm=1`) makes the elasticity toggle an instant hot-swap; otherwise the second tier loads on first switch.
- **The map is real and offline.** MapLibre GL renders a Protomaps vector basemap with Mapterhorn terrain hillshade + contours from local `.pmtiles` archives; routes come from an A\* search over a compact binary trail graph (`graph.bin`) built from OpenStreetMap data.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the worker protocol, the jinja/tool-call message shapes, the tier hot-swap, and the caching strategy in detail.

---

## Built entirely during RAISE 2026

This repository was **born inside the event window** — first commit `1c67246`, *"Helius is born,"* at **03:30:49 MDT on July 4, 2026**, the moment the window opened. There is no pre-event code: the runtime spike, the stack decision, the engine, the UI, the map, the routing graph, and the region packs were all built in-window. **The commit history is the build log** — read it top to bottom: [github.com/george11642/helius/commits](https://github.com/george11642/helius/commits).

---

## Verified numbers

Measured on a MacBook Air M5 (32 GB), Chrome, WebGPU (`apple` / `metal-3`), `crossOriginIsolated`. Spike-harness figures are from [`spike/RESULTS.md`](spike/RESULTS.md); the model runs `onnx-community/gemma-4-E2B-it-ONNX`, q4f16 across all components.

| What | Measured | Source |
| --- | --- | --- |
| Model load → ready (E2B) | **8.5 s cold, 3.9 s warm** (local mirror, OS disk cache) | spike |
| Prefill latency | **445–874 ms** at a 48-token prompt | spike |
| Decode throughput (E2B) | **32.1 tok/s** quiet; 19–24 tok/s under concurrent I/O | spike |
| Decode throughput (E4B) | **16 tok/s**, 19.4 s load — the MatFormer "elasticity" trade-off, verified in-browser | spike |
| Native audio-in (STT) | 2.35 s WAV → **verbatim transcript in 1218 ms**, zero errors | spike |
| Native vision (sign read) | French trail sign, **all lines read verbatim + translated** ("verglas" → black ice); 12.0 s for 220 tokens incl. vision encode | spike |
| Medical prompt | **clean refusal** + emergency-services redirect (non-medical stance holds at the model level) | spike |
| Full agentic turn, live in-app | `locate → sun_clock → route_back` chain → grounded spoken answer @ **~22.5 tok/s** | live |
| `route_back` (A\* over real graph) | **10.64 km / 1584-point route in 78 ms**, drawn on the offline map | live |

No network is involved in any of the above once the weights and pack are cached.

---

## Region packs

A region is a **product feature, not a hardcoded map.** One command builds a complete offline pack for any bounding box:

```bash
scripts/make-pack.sh <pack-id> <west,south,east,north> "Display Name" [trailheads.json]
```

It extracts a Protomaps vector basemap and a Mapterhorn terrain DEM for the box, pulls trails + peaks from OpenStreetMap (Overpass), compiles a compact routing graph (`graph.bin`), and writes a manifest — **≈ 2 minutes per region** on decent wifi. Two packs ship in the repo:

- **Sandia Mountains, Albuquerque** — the demo region (~115 MB: basemap + terrain + 3,336 km of routable trail graph).
- **Chamonix, France** — proves the pack pipeline (and the sign-reading demo) generalize to a different continent and language.

The routing destination enum resolves against the pack's own trailheads in `pois.json` — each tagged with a matching role (`trailhead` / `crest` / `tram_station`) — so a new pack's destinations just work with no code change. Binary format: [`src/map/graph-format.md`](src/map/graph-format.md).

---

## NVIDIA Nemotron — online mission planning (bonus track)

> **Nemotron plans your mission online; Gemma keeps you alive offline.**

An optional pre-trip enhancement — the offline product stays **100% Gemma on-device** and never depends on it:

- While you still have signal, the **PLAN BRIEF** header chip calls `/api/brief` — a Cloudflare Pages Function that feeds the pack's *real* data (pois.json trailheads, manifest bbox, the app's own offline sun math) to **Nemotron 3 Nano** (`nvidia/nemotron-3-nano-30b-a3b` via NVIDIA NIM) under a strict-JSON, strictly non-medical contract.
- The returned **MissionBrief** — route/daylight plan, ranked bail-out points (coordinates snapped to the pack's real POIs, never model-invented), water/gear checklist, terrain cautions, signal expectations, key French phrases for the Chamonix/Fontainebleau packs — is cached **on-device** alongside the pack.
- Offline, Gemma reads it through the `mission_brief` tool: Nemotron's planning shows up inside a fully offline Gemma tool trace. Nemotron **never** does inference in the field.

Setup (all optional — everything degrades gracefully key-less):

```bash
npx wrangler pages secret put NVIDIA_API_KEY --project-name=helius   # prod (Pages secret)
NVIDIA_API_KEY=... pnpm dev                                          # dev (vite middleware reads the env var)
```

Without a key the endpoint answers `501 {reason:'not_configured'}` and the UI hides the feature; `?brief=mock` exercises the entire path (a deterministic brief built from the same real pack data) with no key and no upstream call. Code: `functions/api/brief.ts` (Pages Function), `src/brief/` (client + shared protocol, unit-tested in `tests/brief.test.ts`), `src/tools/brief.ts` (the offline tool).

---

## Local development

```bash
pnpm install
scripts/sync-assets.sh          # stage the Sandia map pack + fonts/sprites into public/
                                # (or build a fresh pack: scripts/make-pack.sh …)
pnpm dev                        # Vite dev server, cross-origin-isolated headers preset
```

The model weight set streams from a model host that the app is pointed at: the public **R2** bucket in production, or a **local mirror** in dev (`spike/serve.mjs` serves `~/dev/helius-assets/models` on `:8737` with Range + the CORP/CORS headers WebGPU's isolated context needs). Weights are cached in the browser after the first load, so every subsequent run — including fully offline — is instant.

`pnpm build` produces the installable PWA; `pnpm typecheck` runs `tsc --noEmit`. Two standalone probe pages (`/loop-probe.html`, `/map-probe.html`) drive the agent loop and the map renderer in isolation for debugging.

---

## Built with

Open tools, all running client-side:

- **[Transformers.js](https://github.com/huggingface/transformers.js)** (Hugging Face) — Gemma 4 E2B/E4B on WebGPU, including native audio-in and vision.
- **[Kokoro](https://github.com/hexgrad/kokoro)** (`kokoro-js`) — on-device text-to-speech.
- **[MapLibre GL](https://maplibre.org/)** + **[PMTiles](https://protomaps.com/)** + **[maplibre-contour](https://github.com/onthegomap/maplibre-contour)** — offline vector map, terrain, and contours.
- **[Protomaps](https://protomaps.com/)** basemap builds, **[Mapterhorn](https://mapterhorn.com/)** terrain, and **[OpenStreetMap](https://www.openstreetmap.org/copyright)** trail data (© OpenStreetMap contributors).
- **[ngraph](https://github.com/anvaka/ngraph.graph)** — the graph structure behind A\* routing.

---

*Helius — offline navigation, signaling, and procedural field tools; deterministic local tools orchestrated by Gemma; non-medical, non-diagnostic.*
