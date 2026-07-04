# H0 runtime spike results — 2026-07-04 03:37–03:43 MDT

Machine: MacBook Air M5 32GB · Chrome (WebGPU: apple/metal-3, crossOriginIsolated) ·
Runtime: @huggingface/transformers 4.2.0 · Model: onnx-community/gemma-4-E2B-it-ONNX (q4f16, all components) served from local mirror.

## Numbers
- **Model load → ready:** 8.5s cold, 3.9s warm (localhost, OS disk cache)
- **Prefill:** 445–874 ms at 48-token prompt
- **Decode:** 32.1 tok/s quiet, 19–24 tok/s while a 5GB download saturated I/O in the background (re-bench before demo, quiet machine)
- **Native audio-in (STT):** 2.35s WAV → verbatim transcript in 1218 ms. "Get me back to the trailhead before sunset" — zero errors.

## Tool calling (native, no grammar hacks)
- With `tools:` passed to `apply_chat_template`, model emits `<|tool_call>call:NAME{args}<tool_call|>` then stops after opening `<|tool_response>`.
- Probes: "get me back to the trailhead" → `call:locate{}` (correct chain start); "how much daylight" → `call:sun_clock{}`.
- **Multi-turn loop verified:** after a `locate` tool response, model chained to `sun_clock{}` unprompted — correct agentic ordering (position → daylight → route).
- Medical probe: clean refusal + emergency-services redirect. Non-medical stance holds at the model level.

## Message-shape constraints (jinja engine quirks — LOCKED API)
- assistant tool call: `{ role:'assistant', tool_calls:[{ type:'function', function:{ name, arguments:<OBJECT> } }] }` — arguments MUST be an object (string args render `{{}}`).
- tool response: `{ role:'tool', name, content:<JSON STRING> }` — mapping content throws (`format_tool_response_block` mapping branch broken in @huggingface/jinja); string renders `response:name{value:<|"|>…<|"|>}` and the model consumes it fine.

## Native vision probe (03:49)
Synthetic French trail sign rendered to canvas → `RawImage.fromCanvas` → user content `[{type:'image'},{type:'text',…}]` → **all four lines read verbatim, translated correctly ("verglas" → black ice), correct hiker-facing reasoning.** 12.0s for 220 tokens incl. vision encode (q4f16 encoder). `read_sign` tool upgrades to native Gemma 4 vision; tesseract OCR demoted to deterministic fallback.

## E4B tier probe (04:03)
`gemma-4-e4b-onnx` full q4f16 (incl. encoders): **load 19.4s, prefill 837ms, decode 16.0 tok/s**, clean output — with E2B still resident (both fit in 32GB unified). Elasticity beat CONFIRMED: E2B is 2.0× faster (32 vs 16 tok/s) → "battery low → morph E4B→E2B, latency halves" is real and visible. Engine will pre-warm both tiers for instant hot-swap.

## Decision
**LOCKED:** transformers.js + Gemma 4 E2B q4f16 WebGPU as the only runtime. Native audio-in replaces the planned moonshine STT on the primary path (moonshine stays mirrored as fallback). Kokoro remains for TTS. E4B q4f16 text stack mirrored for the MatFormer elasticity beat. MediaPipe/LiteRT-LM paths retired unexercised.

## Airplane-mode proof (07:52 MDT — network physically OFF)
macOS Wi-Fi disabled via `networksetup`; take-profile Chrome, cold navigation:
**app ready in 3.09s fully offline** (shell from SW precache, 3.4GB weights from
Cache API — the R2 URLs never touched the network), then a REAL agent turn
completed offline: `sun_clock()` chip → "You have 753 minutes… sunset 08:25 PM"
(correct NOAA math). `navigator.onLine === false` asserted throughout; Wi-Fi
auto-restored by the harness trap. Scripts: video/wifi-proof.sh + wifi-offline-check.mjs;
evidence: video/takes/wifi-proof-result.json + wifi-proof.png.
