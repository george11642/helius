# Helius Go — native iOS companion

Helius Go is the on-device iOS build of **Helius**, the offline-first field agent
that gets a lost hiker back before dark. Gemma 4 runs **entirely on the phone**
(no network, no cloud), chains deterministic tools (`locate → sun_clock →
route_back → pace_eta → safety_plan`, plus `morse_beacon` and `read_sign`), and
answers in a calm, directive voice — the same agent as the web app, but with the
things a phone does that a laptop can't: **real GPS**, the **camera torch as an
SOS beacon**, **on-device speech**, and **camera OCR** of trail signs.

The web PWA is the judged product. This native app is the field-test + "genuinely
on-device mobile" story.

---

## Runtime decision: LiteRT-LM (LOCKED)

Two candidates were spiked. **LiteRT-LM won on every stated criterion
(works-at-all > RAM headroom > integration speed).**

| | **A · LiteRT-LM** ✅ | B · MLX-swift |
|---|---|---|
| Model on disk | `gemma-4-E2B-it.litertlm` (2.4 GB) | `gemma-4-e2b-mlx-4bit` (3.4 GB) |
| Resident RAM (text) | **~0.8 GB** (2/4/8-bit mixed weights + mmap'd embeddings) | ~3.4 GB |
| Runs on iOS Simulator | **Yes** — xcframework ships an `ios-arm64-simulator` slice; CPU/XNNPACK | **No** — needs a real Apple GPU |
| Gemma 4 support | **Native** — this is Google's own Gemma-4 mobile runtime | `gemma4` is in mlx-swift's registry, but unproven for this exact bundle |
| Tool calling | **Built in** — `Tool` protocol + automatic parse/execute/feed-back loop | Hand-written `<|tool_call>` parser |
| Integration | Official SPM package + prebuilt xcframework + official iOS sample | SPM package, but more glue |
| Multimodal | Vision/audio executors load on demand | VLM path |

**Why LiteRT-LM:** it is the official, Gemma-4-native iOS runtime (Google ships an
App Store app — AI Edge Gallery — running these exact `.litertlm` bundles). It has
a prebuilt xcframework (no C++ build), an official Swift API with **automatic
function calling**, and by far the safer RAM profile — **~0.8 GB resident vs
~3.4 GB** — which is decisive on an 8 GB iPhone 16e with a ~5 GB app jetsam
ceiling. It also runs on the **simulator** (CPU/XNNPACK), so the app was proven
end-to-end before the device arrived; MLX can't run on the simulator at all.

MediaPipe's `MediaPipeTasksGenAI` (`.task` bundle) was considered and rejected:
Google has put it in **maintenance-only mode and explicitly recommends migrating
iOS to the LiteRT-LM Swift API**.

### How it's wired
- LiteRT-LM is **vendored as a local Swift package** at `ios/Packages/LiteRTLM/`
  — the official prebuilt `CLiteRTLM.xcframework` (v0.13.1, iOS device + simulator
  slices) plus the unmodified v0.13.1 Swift wrapper sources. We vendor rather than
  use SPM's remote `binaryTarget` because the remote artifact fetch is slow/flaky
  and an offline-first app should build without a network round-trip.
  > Note: the wrapper sources and the xcframework **must come from the same
  > release**. v0.13.1 is the latest release that ships an xcframework; pairing it
  > with the newer `main` wrapper fails to link (missing `litert_lm_stream_chunk_*`
  > C symbols). Both are pinned to v0.13.1 here.
- The model file is **not** committed. `ModelLocator` resolves it at runtime:
  `HELIUS_MODEL_PATH` env → app `Documents/` → app bundle → dev fallback path.

---

## Architecture

```
HeliusGo/
  App/            HeliusGoApp, ContentView (root), Theme (night-ops palette)
  Engine/         HeliusEngine protocol + AgentEvent; LiteRTEngine (real), MockEngine (scripted); ModelLocator
  Agent/          SystemPrompt (mirrors web), HeliusRuntime (shared state + event bus)
  Tools/          The 7 tools as LiteRTLM `Tool` conformances; Morse encoder
  Platform/       LocationProvider (CoreLocation), TorchController (torch SOS),
                  SpeechRecognizer (on-device STT), Speaker (TTS), SignReader (Vision OCR)
  Views/          StatusHeader, Transcript, ToolTrace (chips), Compass, MicButton
  Resources/      graph.bin, pois.json
Packages/
  HeliusCore/     Pure-Swift, `swift test`-verified: sun math + graph.bin parser + A* routing
  LiteRTLM/       Vendored LiteRT-LM (xcframework + Swift wrapper)
```

- **Engine abstraction.** `HeliusEngine` has two implementations: `LiteRTEngine`
  (real Gemma 4) and `MockEngine` (deterministic scripted turn for instant UI
  work and as a fallback). Both emit the same `AgentEvent` stream.
- **Tools.** Each tool is a `LiteRTLM.Tool` struct with `@ToolParam` properties.
  LiteRT-LM generates the schema, parses the model's calls, executes `run()`, and
  feeds results back automatically (up to 25 chained calls). Tools are stateless
  (re-instantiated per call), so they read live state — GPS fix, routing graph,
  pending camera frame — from `HeliusRuntime.shared`, and emit trace events onto
  its event bus so the UI chips light up.
- **Core math** (`HeliusCore`) is a separate pure-Swift package with no iOS/GPU
  deps, so the routing/sun logic is unit-tested with plain `swift test` on macOS
  against the same La Luz oracle the web app uses.

---

## Build & run (simulator)

```bash
cd ios
xcodegen generate            # regenerate HeliusGo.xcodeproj from project.yml
open HeliusGo.xcodeproj       # or use xcodebuild
```

The `.litertlm` model is not in the repo. For simulator/dev runs, point at the
asset directly (the simulator can read host paths):

```
HELIUS_MODEL_PATH=/path/to/gemma-4-E2B-it.litertlm
```

To exercise the full UI instantly without a model load, launch with
`HELIUS_ENGINE=mock`.

---

## 13:30 device sideload runbook (free provisioning, one session)

Target: **iPhone 16e** (8 GB, A18), George's Apple ID, USB-C. Everything below is
a one-time, ~10-minute session. Do it in order.

1. **Connect** the iPhone to the Mac by USB-C. On the phone tap **Trust This
   Computer** and enter the passcode.
2. **Developer Mode:** on the phone, Settings → **Privacy & Security** →
   **Developer Mode** → **On** → confirm and let it restart; unlock to enable.
3. **Add the Apple ID to Xcode:** Xcode → **Settings… → Accounts → `+` → Apple
   ID** → sign in as George. This creates the free "Personal Team" signing cert.
4. **Open the project:** `cd ios && xcodegen generate && open HeliusGo.xcodeproj`.
5. **Signing:** select the project → **HeliusGo** target → **Signing &
   Capabilities** → check **Automatically manage signing** → **Team = George's
   Personal Team**. If it complains the bundle ID is taken, change
   `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` to something unique (e.g.
   `com.<george>.heliusgo`), re-run `xcodegen generate`, reopen.
6. **Select the device** in the run-destination dropdown (top center) — pick
   "George's iPhone", not a simulator.
7. **Provision the model** (keeps the app small — do NOT bundle 2.4 GB):
   - Build & run once (step 8) so the app container exists, then push the model
     into the app's Documents:
     ```bash
     xcrun devicectl device copy to --device <UDID> \
       --domain-type appDataContainer --domain-identifier com.helius.go \
       --source /path/to/gemma-4-E2B-it.litertlm \
       --destination Documents/gemma-4-E2B-it.litertlm
     ```
     (`xcrun devicectl list devices` for the UDID.) `ModelLocator` checks
     `Documents/` first.
   - *Fallback if devicectl is fussy:* drag `gemma-4-E2B-it.litertlm` into the
     Xcode project, tick the HeliusGo target so it lands in **Copy Bundle
     Resources**, and rebuild — the app is then ~2.4 GB but fully self-contained.
8. **Build & Run** (`Cmd + R`). First launch, the phone will block the developer
   cert: Settings → **General → VPN & Device Management** → tap the developer
   app → **Trust**. Re-run.
9. **Grant permissions** on first use: Location (When In Use), Microphone, Speech
   Recognition, Camera. Location must be granted for real GPS `locate`.
10. **Field test.** Outdoors with a real fix: "Get me back to the trailhead
    before dark" → watch the tool chain, the compass arrow, and try the torch SOS
    beacon and camera sign-reading.

> Free-provisioning certs expire after 7 days; re-run from Xcode to refresh. Fine
> for the field test window.

---

## Verification — GO ✅ (full-app run complete, 2026-07-04)

**Verdict: GO.** The full Stage-2 app builds and the on-device agent loop runs
end-to-end on the iOS Simulator (iPhone 17, iOS 26.5, arm64, CPU/XNNPACK).

**Build**
- **Simulator (arm64):** clean build, 0 errors. App boots, requests permissions,
  loads `gemma-4-E2B-it.litertlm` (2.4 GB) in **~5.6 s**; header reads
  "Gemma 4 E2B · GPS SIM · CPU · on-device · no network".
- **Device (`generic/platform=iOS`, unsigned):** `xcodebuild archive` **SUCCEEDED**.
  The `.xcarchive` main binary is `arm64`, the embedded `CLiteRTLM.framework` is the
  `arm64` **device** slice, and `graph.bin`/`pois.json` are bundled. Unsigned
  (`code object is not signed at all`) — signing happens at the 13:30 sideload.

**On-device agent loop** (real turns driven on the simulator)
- **"Get me back to the trailhead before dark"** → trace chips lit green
  `locate()` → `sun_clock()` → `route_back()`; compass showed **10.6 km → LA LUZ
  TRAILHEAD**; grounded answer: *"The trailhead is 10.6 km / 6.6 mi away. The
  estimated time is 2 hours and 8 minutes. Proceed now."* — 10.64 km / 128 min,
  **bit-identical to the HeliusCore La Luz oracle**. (The model used a 3-tool chain
  because `route_back` already returns the ETA.)
- **"If I walk 3 km with 200 m of climbing, how long + beat sunset?"** →
  `pace_eta()` fired; grounded answer: *"It will take about 56 minutes. You will
  beat sunset."* — 36 min flat + 20 min climb = 56 min Naismith, exact.
- Screenshots: `docs/fullapp-toolchain-GO.jpg`, `docs/fullapp-pace_eta-GO.jpg`,
  `docs/probe-verdict-GO.jpg`.

**Core math:** `HeliusCore` is unit-tested with `swift test` (5/5) against the La
Luz oracle (10638.5 m, 16 steps, 1584 coords) and an Albuquerque sunset.

**Two runtime bugs found and fixed before this run:**
1. **`pace_eta` args wouldn't decode.** `@ToolParam` property names must be
   camelCase (`distanceM`), not snake_case (`distance_m`): LiteRT-LM exposes them to
   the model as snake_case and decodes the model's args with `.convertFromSnakeCase`,
   so a snake_case property fails to decode (`keyNotFound`) and the tool call throws.
   Fixed; proven by the 56-minute turn above.
2. **Constrained decoding was off.** Enabled
   `ExperimentalFlags.enableConversationConstrainedDecoding` in `warmUp` (Google's
   flag "primarily for function calling") for reliable tool-calling.
