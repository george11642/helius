# Helius — SUBMISSION-READY (Sat Jul 4, ~13:35 MDT)

Everything is done except the form itself. **George submits the form** (deadline
04:00 MDT Sun / noon Paris). Paste-ready text: `docs/SUBMISSION.md`.

## The three links that matter
- **Judge URL:** https://helius-9d0.pages.dev (verified: onboarding gate, model
  from R2, offline reload 3.0s, real turn, /api/brief live with NVIDIA key)
- **Video (public, 60.0s):** https://youtu.be/csRsCrKx_oM
- **Repo (PUBLIC, tag v1.0):** https://github.com/george11642/helius

## What shipped today after the morning handoff (wave 2)
- Real geolocation primary + explicit Demo GPS + off-pack coverage honesty;
  deterministic display numbers (model quotes tool strings verbatim).
- Resumable chunked Range→OPFS model downloads, capability pre-flight
  (go/degraded/unsupported), phone guidance, map-only mode, single-copy weights.
- Onboarding gate: pack pick BEFORE the 3.4GB download, explicit start, staged
  progress; mobile-first layout (bottom-sheet chat).
- NVIDIA Nemotron bonus: /api/brief (Pages Function → nemotron-3-nano-30b-a3b)
  → MissionBrief cached into the offline pack → Gemma's mission_brief tool
  reads it OFFLINE. Key active in global.env + Pages secret.
- iOS Helius Go: offline MapLibre map (WKWebView + Range scheme handler),
  chip summaries, GPS gate fixed, settings, screen-strobe fallback.
  (George's phone still has the PRE-wave build — resideload via ios/README.)
- **Critical fix:** workbox RegExp routes never match cross-origin mid-URL →
  R2 pack assets were silently uncacheable in prod. Function matchers fixed it;
  OFFLINE-READY badge now reachable (warm ~1-2 min on good Wi-Fi).
- 2 adversarial reviews + Codex + E2E: 15 findings fixed; tests 161 green.

## Video kit (for reruns)
`CAPTURE=1 CAPTURE_SECONDS=150 CAPTURE_OUT=takes/<name>.mov TAKE_LABEL=<label>
node video/scenes.mjs` — scenes spawns capture itself at t0 (sync by
construction), chromeless --app window, measured crop. Then normalize to CFR
(`ffmpeg -fps_mode cfr -r 60 -c:v h264_videotoolbox -b:v 30M`) and
`CAPTURE_LEAD=$(t0Epoch/1000 - file birth) ./assemble.sh --capture <cfr.mov>`.
ProRes videotoolbox drops ~15% frames at 1080p60 on this box — always CFR-normalize.

## George's remaining items
1. **Submit the form** (docs/SUBMISSION.md has the draft + video link).
2. Optional: re-sideload iOS with the new map build; finish Crusoe account
   (payment info) for rate-limit-free Nemotron; fal top-up (not needed).
