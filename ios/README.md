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
  Map/            Embedded offline map: MapSchemeHandler (helius:// bundle server with
                  Range support), MapBridge (Swift→JS command queue), MapPanelView (WKWebView host)
  Views/          StatusHeader, Transcript, ToolTrace (chips + result summaries), Compass,
                  MicButton, SettingsView, StrobeView (no-torch screen beacon)
  Resources/      graph.bin, pois.json
web-map/          Self-contained MapLibre+PMTiles page (index.html, map.js) + vendored
                  maplibre-gl/pmtiles JS, Noto glyphs, dark sprites, and pack/ (basemap.pmtiles
                  is git-ignored — run scripts/sync-pack.sh after cloning)
Packages/
  HeliusCore/     Pure-Swift, `swift test`-verified: sun math + graph.bin parser + A* routing
  LiteRTLM/       Vendored LiteRT-LM (xcframework + Swift wrapper)
```

### Offline map (WKWebView + MapLibre + PMTiles)

The same proven renderer as the web app, embedded natively. A `WKURLSchemeHandler`
serves the bundled `web-map/` folder over `helius://local/...` **with HTTP Range
support**, so the pmtiles JS client range-reads the 28 MB Sandia basemap archive
straight out of the app bundle (memory-mapped, zero network). The page is a
hand-port of `src/map/style.ts` + `src/map/render.ts` (night-ops palette, amber
dashed trails, pulsing fix marker, destination flag, **animated route reveal**);
terrain/DEM layers are omitted (the 78 MB terrain archive is not bundled).
Swift pushes state through `MapBridge` (`setFix`, `drawRoute`, `clearRoute` —
queued until the page reports ready); when `route_back` succeeds the `.route`
event draws the real A* geometry on the map, animated, and fits the camera.

**After cloning:** `./scripts/sync-pack.sh` copies `basemap.pmtiles` from
`../public/data/packs/sandia/` into `web-map/pack/` (it's git-ignored at 28 MB).
Without it the app still builds; the map page just has no basemap tiles.

### GPS, Demo Mode, and coverage honesty

Real Core Location fixes are accepted **anywhere** (no bbox gate). `locate`
reports `source` (`gps`/`demo_preset`), `in_pack_coverage`, and — when outside
the Sandia bbox — an explicit note ("outside Sandia Mountains pack coverage,
~N km from the nearest trail data") instead of silently substituting a preset.
**Demo Mode** (Settings, default ON, persisted) pins the position to the La Luz
switchbacks preset for indoor demos; the header badge shows DEMO FIX / GPS LIVE /
GPS WAIT accordingly.

### Settings & beacon fallback

The gear in the status header opens Settings: engine (Gemma 4 E2B ↔ Mock, hot-
swappable, persisted), Demo Mode, speak-answers toggle, pack info, credits.
`morse_beacon` on a device with no torch (simulator, iPad) now falls back to a
**full-screen white strobe** flashing the same Morse timeline at max brightness,
with a STOP control (DEBUG env `HELIUS_TEST_BEACON=1` arms it at launch for
simulator testing).

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
./scripts/sync-pack.sh       # copy the git-ignored basemap.pmtiles into web-map/pack/
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
10. **On-device smoke check (this session, ~5 min)** — verify each before George leaves:
    - **Model loads:** launch; the header goes to "on-device · no network". First load
      reads the 2.4 GB weights from `Documents/` (step 7) — a few seconds on the A18.
      If it says "model not found", the copy in step 7 didn't land — redo it.
    - **Tool chain:** "Get me back to the trailhead before dark" → chips light
      `locate → sun_clock → route_back` with result summaries under each chip, a
      grounded answer, and the **route drawn animated on the offline map**.
      (Indoors: keep **Demo Mode ON** in Settings so the La Luz preset is used.
      Outdoors: turn Demo Mode OFF for the real fix — routing works when the fix
      is inside the Sandia pack; elsewhere `locate` reports coverage honestly.)
    - **read_sign (2 min — marquee beat, FIRST real-camera OCR test):** tap the camera
      button, point at the printed French test sign ("SENTIER DU LAC / Refuge — 2,4 km
      / Danger : verglas"), take the photo → the `read_sign()` chip fires and Helius
      returns the transcription + translation (verglas → ice; "be cautious of ice on
      the trail"). On the simulator this was verified via the photo library.
    - **Torch SOS (first real hardware test):** "Start an SOS beacon" → the rear torch
      should actually FLASH the `... --- ...` pattern; the banner's STOP ends it.
    - **Compass:** after a route, the amber arrow points at the waypoint and swings as
      the phone rotates (needs a real heading — turn the phone).
11. **Field test.** Outdoors with a real fix inside the Sandia pack: "Get me back to
    the trailhead before dark" → tool chain + compass + torch SOS, on camera.

> Signing note (this machine): there is currently **no Apple ID in Xcode → Accounts**,
> so `-allowProvisioningUpdates` fails with "No Accounts / No profiles". Two unblocks:
> (a) add George's Apple ID in Xcode (free Personal Team, step 3); or (b) an App Store
> Connect API key exists for team **PFSQAU75V7** at
> `~/.appstoreconnect/private_keys/AuthKey_PFSQAU75V7.p8` — pass it to `xcodebuild`
> with `-authenticationKeyPath/-authenticationKeyID PFSQAU75V7/-authenticationKeyIssuerID <issuer>`
> to sign non-interactively (the Issuer ID must come from App Store Connect → Users
> and Access → Integrations). Free-provisioning certs expire after 7 days; re-run to refresh.

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
- **read_sign** (a French trail-sign photo) → `read_sign()` fired (Vision OCR,
  ~1.2 s), transcribed all three lines verbatim ("SENTIER DU LAC. Refuge - 2.4 km.
  Danger: verglas.") and Gemma translated the hazard: *"Action: Be cautious of ice
  on the trail."* ("verglas" → ice, correct). On the simulator the picker uses the
  photo library (the sim's camera is synthetic); on device it uses the real camera.
- **morse_beacon** ("Start an SOS beacon") → `morse_beacon()` fired, the SOS banner
  lit with the `... --- ...` pattern + a STOP control; the torch loop runs (no-ops on
  the simulator, flashes the real torch on device).
- Screenshots: `docs/fullapp-toolchain-GO.jpg`, `docs/fullapp-pace_eta-GO.jpg`,
  `docs/fullapp-read_sign-GO.jpg`, `docs/fullapp-sos-beacon.jpg`,
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

---

## Verification — map/trace/settings upgrade (2026-07-04, in-window)

Verified on the iOS Simulator (iPhone 17 Pro, iOS 26.5), `HELIUS_ENGINE=mock`:

- **Offline map:** boots with zero network — night-ops basemap, amber dashed
  trails, POI/peak labels, pulsing fix marker at the La Luz preset. After the
  "back before dark" turn, the **real A\* route (1584 pts, 10.64 km) draws
  animated** to the La Luz Trailhead flag with a camera fit. Collapse/expand
  keeps the WKWebView (and route) alive. `docs/screenshots/map-route.jpg`.
- **Chip summaries:** every finished chip shows its result line (fix coords,
  sunset/light minutes, route km/eta, pace verdict) — `docs/screenshots/map-route-chips.jpg`.
- **Mock routes over the real graph:** MockEngine now runs the same
  `RoutingGraph.findRoute` as the real engine, so the map shows genuine geometry.
- **Settings sheet:** engine picker, Demo Mode, voice toggle, pack + about render
  and toggle live; Demo Mode OFF flipped the header to GPS LIVE using the
  simulator's real fix (the anywhere-GPS path).
- **Screen-strobe beacon:** with no torch, the SOS beacon renders a full-screen
  white Morse strobe with STOP — `docs/screenshots/strobe-flash.jpg`
  (white "on" frame captured).
- **Real-engine build:** the same binary contains `LiteRTEngine` (compiles in
  this build); on-device model load unchanged (Documents/ `.litertlm`).
