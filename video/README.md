# Helius — video production kit

Everything to turn the running app into a 60-second, judge-ready demo video.
Machine-grounded recipes (this Mac, ffmpeg 8.1.1) live in
`~/dev/helius-assets/research/video.md` — read that for the *why*; this is the *how*.

**The one craft rule:** Playwright only **drives** a real Chrome window; a
separate **ffmpeg avfoundation** process captures the screen. Never Playwright's
own recorder (its bitrate is hard-capped ~1 Mbit/s). Chrome is a `960×540`
window at `0,0` with `device-scale-factor 2` → a crisp `1920×1080` physical
region we crop exactly.

## Pipeline (rough cut ≈ hour 18, polished master ≈ hour 23)

```
 script.txt ─▶ vo.mjs ─▶ vo.mp3 + alignment.json ─┐
                                                   ├─▶ captions/ (Remotion) ─▶ captions.webm ─┐
              music.mjs ─▶ music.mp3 ──────────────┤                                          │
              broll.mjs ─▶ broll/*.mp4 ────────────┤                                          ▼
                                                   └────────────────────────────────▶ assemble.sh ─▶ youtube_master.mp4
   scenes.mjs (drive Chrome)  ‖  capture.sh (ffmpeg) ─▶ takes/*.mov ────────────────────────▲
```

## Scripts (each runnable on its own)

| File | What it does | Run |
| --- | --- | --- |
| `script.txt` | The ~140-word narration (the beats). Edit this, then re-run vo.mjs. | — |
| `vo.mjs` | ElevenLabs `eleven_multilingual_v2` `/with-timestamps` → `vo.mp3` + `alignment.json` (character timings for captions). Voice resolved by name (Brian→Adam→Rachel). | `node vo.mjs` |
| `music.mjs` | fal CassetteAI 60s cinematic-tech bed → `music.mp3` (~$0.02). | `node music.mjs` |
| `broll.mjs` | Pexels bookend clips → `broll/mountain-dusk.mp4`, `broll/night-sky-stars.mp4` (bookends ONLY — never over the demo). | `node broll.mjs` |
| `make-sign.mjs` | Renders the French trail-sign fixture `sign.png` (→ `sign.y4m` fake-camera feed for the read_sign beat). | `node make-sign.mjs` |
| `scenes.mjs` | Playwright driver: deterministic scene sequence against the running app, per-scene screenshots → `takes/<label>/`, console `SCENE:`/`TRACE:` markers, `scenes-timing.json`. Feeds Chrome a fake camera (the sign) for a glare-free read. | `node scenes.mjs` |
| `capture.sh` | Parallel ffmpeg avfoundation screen capture. `--rough` (h264, fast) / default ProRes; `--list` prints the screen device index. | `./capture.sh [--rough]` |
| `captions/` | Remotion project: transparent title card + word-synced lower-thirds (from `alignment.json`) + end card → `captions.webm`. | see below |
| `assemble.sh` | Final timeline: capture + captions overlay + VO/music (ducked) → two-pass loudnorm −14 LUFS → 1080p60 master. `--rough` fast path; `--smoke` self-test. | `./assemble.sh` |

Keys come from `~/.config/global.env` (ELEVENLABS_API_KEY, FAL_KEY, PEXELS_API_KEY):
`set -a; source ~/.config/global.env; set +a` before running the API scripts.

## Recording a take

1. **Free the GPU:** close other WebGPU/model Chrome tabs (leaked GPU heaps across tabs can exhaust the GPU). Ideally quit Chrome first.
2. **Hide the menu bar** (System Settings → Control Center → *Automatically hide and show the menu bar*) so the window's top-left is a true `0,0`. Otherwise pass `CROP_Y=<menu-bar-height-in-physical-px>` to `capture.sh`.
3. **Grant Screen Recording** to your terminal (System Settings → Privacy & Security → Screen Recording). Until you do, `capture.sh --list` won't see a *Capture screen* device (only cameras/mics). Once granted it appears (index 3 on this machine, per the research doc).
4. Start capture, then drive, in two shells:
   ```bash
   ./capture.sh --rough            # or omit --rough for the ProRes final take; Ctrl-C / q to stop
   TAKE_LABEL=take1 node scenes.mjs
   ```
   `scenes.mjs` launches Chrome at `0,0`/960×540@2x itself; the crop is `1920:1080:0:0`.

## Building captions

```bash
cd captions
./render.sh          # → ../captions.mov (transparent QTRLE/argb)
```
`render.sh` renders the word-synced overlay as a transparent PNG sequence, then
muxes it to a QTRLE `.mov` (argb) that `assemble.sh` composites with ffmpeg
`overlay`. All burned text goes through Remotion (this ffmpeg build has no
`libass`/`drawtext` — better typography anyway, and it reads ElevenLabs' timing
JSON directly).

**Why a `.mov`, not a transparent `.webm`:** the Remotion webm-alpha encode is
broken on this machine — vp8 *and* vp9, via the `--pixel-format=yuva420p` flag
*and* `calculateMetadata`, all flatten to opaque `yuv420p` (the frames render
`rgba`; the mux drops the alpha), and ffmpeg's own `libvpx-vp9` can't encode
alpha here either. QTRLE `.mov` sidesteps it: lossless, real `argb` alpha, tiny
for mostly-transparent frames, and `overlay` honors it. `assemble.sh` prefers
`captions.mov`, and its guard skips any caption file lacking alpha (so it can
never ship an all-black master).

## Assembling

```bash
./assemble.sh --rough                         # hour-18 rough cut (fast, no two-pass)
./assemble.sh                                  # hour-23 master → youtube_master.mp4 (two-pass loudnorm, libx264 slow)
./assemble.sh --intro broll/mountain-dusk.mp4 --outro broll/night-sky-stars.mp4   # with bookends
./assemble.sh --smoke                          # self-test the whole graph with synthetic inputs
```
Music ducks to 0.18 during the VO window (read from `alignment.json`), 0.5 at the bookends. Audio lands on YouTube's −14 LUFS target so its own loudness pass won't touch it. Final: `libx264 -preset slow`, 16 Mbps, 1080p60, `yuv420p`, `+faststart`.

## Upload (manual, per research doc §6)

Drive `studio.youtube.com` on a signed-in Chrome profile (NOT the Data API — it silently forces unverified-project uploads to *private*). Create → Upload → set the file → title/description → **Not made for kids** → **Unlisted** → copy the share URL. Front-load it so 1080p processing finishes before judges click.

## Notes / risks

- **Screen Recording permission** is required for `capture.sh` to see the screen device (see step 3) — this is the one manual prereq the automated shell can't self-grant.
- **GPU contention:** running a fresh model load (scenes.mjs) while other WebGPU tabs are open can starve the GPU. Close them before a take.
- **Prod-map tile regression** (tracked separately) can render the map dark in the prod bundle — the route toast (`ROUTE READY …`) still fires, so the trace/route beat reads regardless; use a build where the map draws for the final take.
- **Music billing:** both AI music sources are currently paid-plan-gated (fal.ai = *exhausted balance*, ElevenLabs Music = *paid plan required*), so `music.mjs` falls back to a **synthesized placeholder bed** so the pipeline isn't blocked. Top up fal.ai credits (fal.ai/dashboard/billing) and re-run `node music.mjs` to get the real CassetteAI track — no other change needed.
- `sign.y4m`, `takes/`, `node_modules/`, and generated media are git-ignored (regenerate from the scripts). `sign.png` and the scripts are committed.
