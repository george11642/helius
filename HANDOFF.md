# Helius — build handoff (Sat Jul 4, ~09:35 MDT)

State of the RAISE 2026 build for a fresh session or for George. Everything below
is **done and verified** unless a line says otherwise. Submission deadline:
**04:00 MDT Sun / noon Paris** — George refines + submits the form himself.

## The live deliverables (share these)

- **Judge URL (live, real-model verified):** https://helius-9d0.pages.dev
  - Gemma E2B loads from R2 in ~82s; offline map (basemap + hillshade + contours
    from R2 terrain) + trails + POIs render; real turn @ ~22 tok/s draws the
    10.64 km La Luz route; zero console errors. Scroll/zoom/pan work.
  - Cloudflare Pages project `helius`, account `d13d307f042336a52467a0583099794c`.
    Deploy token in `~/.config/global.env` as `CLOUDFLARE_PAGES_TOKEN` (Pages:Write).
  - Redeploy: `pnpm build && find dist -name '*.pmtiles' -delete && \
    CLOUDFLARE_API_TOKEN=$CLOUDFLARE_PAGES_TOKEN CLOUDFLARE_ACCOUNT_ID=d13d307f042336a52467a0583099794c \
    npx wrangler@latest pages deploy dist --project-name=helius --branch=main --commit-dirty=true`
    (pmtiles are stripped from the upload — they exceed the 25 MiB Pages cap and
    stream from R2 in prod via `src/map/pack-base.ts`).
- **Repo:** https://github.com/george11642/helius (PRIVATE — make public before
  submitting; clean in-window history begins 03:30:49 MDT Jul 4).
- **iOS "Helius Go":** signed + installed + running on George's iPhone 16e.
  Gemma 4 E2B loads on-device in ~6.2 s (A18, CPU), offline routing live.
  Team `8ZBX3F56T7`, bundle `com.helius.go`, device UDID
  `1A237960-FB80-582A-8579-008C02F1A2C7`. Unsigned archive at
  `$CLAUDE_JOB_DIR/tmp/HeliusGo.xcarchive`. Sideload runbook: `ios/README.md`.

## Verified facts (see `spike/RESULTS.md` for the full log)

- Runtime: transformers.js 4.2.0 + `onnx-community/gemma-4-E2B-it-ONNX` q4f16 on
  WebGPU in a Worker. E2B 32 tok/s / E4B 16 tok/s; hot-swap 0 ms with `?prewarm=1`.
- Native audio-in (STT ~1.2 s), native vision (French sign read + translated),
  medical prompts refused by design.
- **Airplane-mode PROVEN:** Wi-Fi physically off → ready 3.09 s → real grounded
  turn (`video/wifi-proof.sh`, auto-restores Wi-Fi).
- 3 region packs on R2 (`pub-186c78c24ee54dda820fe564c0ac4608.r2.dev/packs`):
  **sandia** (demo, 3336 km), **chamonix** (Alps), **fontainebleau** (Paris day
  trip). `scripts/make-pack.sh <id> <bbox> "<name>" [trailheads.json]` = any region.
- 3 Codex adversarial review waves (12 + 7 + 7 findings) — all fixed + verified.

## Docs (all committed)

- `README.md` — judge-facing (hero, demo beats, architecture diagram, verified
  numbers, non-medical scope, packs, dev quickstart, credits).
- `docs/ARCHITECTURE.md`, `docs/SUBMISSION.md` (form draft + 60-s shot list +
  CC-BY music attribution line), `docs/DEMO-RUNBOOK.md` (live-judging script +
  recovery table — **run the demo in a FRESH Chrome profile**; a cache-heavy dev
  profile can wedge the SW precache).

## The one thing NOT done: the demo video

- **Kit:** `video/` — `scenes.mjs` (Playwright driver, 9 scenes, dry-run-proven
  real turns incl. grounded sign-read + SOS), `capture.sh` (avfoundation screen
  cap, index 3, crop 1920x1080 @ 0,0), `assemble.sh` (paces scenes to the VO
  beat → 60.0 s, two-pass loudnorm, guards opaque captions), `vo.mjs`/`music.mjs`/
  `broll.mjs`, `captions/` (Remotion).
- **Assets ready:** VO `vo.mp3` (58.5 s, Brian + `alignment.json`), music
  `music.mp3` (real, "Ascending the Vale" / Kevin MacLeod / CC BY 4.0 — credit in
  `video/music-CREDIT.txt` + SUBMISSION.md), b-roll ×2.
- **To finish (no George input needed except a clear screen for the take):**
  1. Roll a clean take: keep the Mac's top-left quarter clear, then
     `./capture.sh --rough &` + `node scenes.mjs` (crash-restore dialog now
     suppressed; screen-recording permission already works).
  2. `./assemble.sh --rough --capture takes/<file>.mov` → review → final master.
  3. Upload **unlisted** via authed Chrome at studio.youtube.com (channel `bpapp`
     `UC0BaCe0TUTk55D3wRFX-Caw`, pre-authed; has 1 strike — George may swap).
- **Captions:** DONE — transparent `captions.mov` (QTRLE/argb; vp8/vp9 alpha
  encode is broken on this machine, proven, so .mov not .webm). Rebuild with
  `video/captions/render.sh`. `assemble.sh` prefers `captions.mov` and overlays it.
  The ONLY remaining video step is rolling a clean-content take + assemble +
  upload — the kit itself is fully built and verified.

## George's open items (all optional / his-to-do)

- Confirm on the PHONE: header load time, the demo turn's chips + answer, **does
  the rear torch actually flash SOS**, compass tracks on rotation.
- Optional: fal.ai top-up (would swap the free CC-BY music for CassetteAI — not
  needed); R2 custom domain (r2.dev has variable rate limits); YouTube channel swap.
- Before submit: make the repo public, tag v1.0, paste judge URL + video link into
  the form, submit himself.
