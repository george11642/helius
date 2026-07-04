#!/usr/bin/env bash
# assemble.sh — final timeline: capture + captions overlay + VO/music (ducked)
# → loudnorm -14 LUFS → YouTube 1080p60 master. All recipes from
# helius-assets/research/video.md §3.
#
#   ./assemble.sh [--rough] [--capture FILE] [--out FILE] [--intro FILE] [--outro FILE]
#     --rough   h264_videotoolbox single-pass, skip captions + two-pass loudnorm (timing check)
#     --smoke   self-test: fabricate 6s inputs, run the whole graph, prove it works (no real take needed)
#   Inputs (from the other scripts, in this dir): takes/*.mov, vo.mp3, music.mp3,
#   captions.webm (render via captions/), broll/*.mp4 (optional bookends).
set -euo pipefail
cd "$(dirname "$0")"

ROUGH=0 SMOKE=0 CAPTURE="" OUT="youtube_master.mp4" INTRO="" OUTRO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rough) ROUGH=1; shift ;;
    --smoke) SMOKE=1; shift ;;
    --capture) CAPTURE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --intro) INTRO="$2"; shift 2 ;;
    --outro) OUTRO="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

dur() { ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null || echo 0; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# ---------- smoke self-test: fabricate inputs ----------
VO="vo.mp3" MUSIC="music.mp3" CAPS="captions.webm"
if [ "$SMOKE" = "1" ]; then
  echo "==> SMOKE: fabricating 6s inputs" >&2
  CAPTURE="$WORK/cap.mov"; VO="$WORK/vo.mp3"; MUSIC="$WORK/music.mp3"; OUT="youtube_master_smoke.mp4"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=1920x1080:rate=60:duration=6" -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p "$CAPTURE"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=330:duration=5" -af "volume=0.6" -ar 44100 "$VO"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=110:duration=6" -ar 44100 "$MUSIC"
  [ -f "captions.webm" ] || CAPS=""   # use real captions if already rendered, else skip
fi

# ---------- resolve capture ----------
if [ -z "$CAPTURE" ]; then
  CAPTURE="$(ls -t takes/*.mov 2>/dev/null | head -1 || true)"
fi
[ -n "$CAPTURE" ] && [ -f "$CAPTURE" ] || { echo "!! no capture .mov found (takes/ empty). Record one with capture.sh, or use --smoke." >&2; exit 1; }
[ -f "$VO" ] || { echo "!! missing $VO (run vo.mjs)"; exit 1; }
[ -f "$MUSIC" ] || { echo "!! missing $MUSIC (run music.mjs)"; exit 1; }
[ -f "$CAPS" ] 2>/dev/null || CAPS=""   # captions optional
echo "==> capture=$CAPTURE  vo=$VO  music=$MUSIC  captions=${CAPS:-<none>}" >&2

# ---------- VO window (for music ducking) from alignment.json ----------
read -r VS VE < <(node -e '
  try {
    const a = require("./alignment.json").alignment;
    const s = a.character_start_times_seconds, e = a.character_end_times_seconds;
    console.log((s?.[0] ?? 0).toFixed(2), (e?.[e.length-1] ?? 0).toFixed(2));
  } catch { console.log("0", String('"$(dur "$VO")"')); }
' 2>/dev/null || echo "0 $(dur "$VO")")
echo "==> VO window: ${VS}s → ${VE}s (music ducks to 0.18 there, 0.5 elsewhere)" >&2

# ---------- AUDIO: vo + ducked music → mix → loudnorm ----------
MIX="$WORK/mix.wav"
ffmpeg -hide_banner -loglevel error -y -i "$VO" -i "$MUSIC" -filter_complex "
  [0:a]aresample=48000[vo];
  [1:a]aresample=48000,volume=eval=frame:volume='if(between(t,${VS},${VE}),0.18,0.5)'[mus];
  [vo][mus]amix=inputs=2:duration=longest:normalize=0[mix]
" -map "[mix]" -ac 2 -ar 48000 "$MIX"

AUDIO="$WORK/audio.wav"
if [ "$ROUGH" = "1" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$MIX" -af "loudnorm=I=-14:TP=-1.5:LRA=11" -ar 48000 "$AUDIO"
else
  echo "==> two-pass loudnorm to -14 LUFS" >&2
  MEAS=$(ffmpeg -hide_banner -y -i "$MIX" -af "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json" -f null - 2>&1 | awk '/^\{/{f=1} f{print} /^\}/{f=0}')
  gv() { echo "$MEAS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)['$1'])}catch{console.log('')}})"; }
  MI=$(gv input_i); MTP=$(gv input_tp); MLRA=$(gv input_lra); MTH=$(gv input_thresh)
  if [ -n "$MI" ] && [ "$MI" != "undefined" ]; then
    ffmpeg -hide_banner -loglevel error -y -i "$MIX" -af "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${MI}:measured_TP=${MTP}:measured_LRA=${MLRA}:measured_thresh=${MTH}:linear=true" -ar 48000 "$AUDIO"
  else
    echo "   (measure parse failed — single-pass fallback)" >&2
    ffmpeg -hide_banner -loglevel error -y -i "$MIX" -af "loudnorm=I=-14:TP=-1.5:LRA=11" -ar 48000 "$AUDIO"
  fi
fi

# ---------- VIDEO: pace per-scene clips to the VO beats, concat, overlay captions, guard 58-62s ----------
# ProRes mezzanine for the real path; software for --smoke (avoids the hw
# videotoolbox encoder stalling when the GPU is busy with model tabs).
if [ "$SMOKE" = "1" ] || [ "$ROUGH" = "1" ]; then MEZZ=(-c:v libx264 -preset ultrafast -crf 12); else MEZZ=(-c:v prores_videotoolbox -profile:v 3); fi
XF=0.6
CAPTURE_LEAD="${CAPTURE_LEAD:-0}"  # seconds the capture ran before scenes.mjs t0 (manual sync knob)

TIMING="scenes-timing.json"
if [ "$SMOKE" = "1" ]; then
  TIMING="$WORK/timing.json"
  printf '%s' '{"scenes":[{"label":"a","startMs":200,"ms":1500},{"label":"b","startMs":2200,"ms":1500},{"label":"c","startMs":4200,"ms":1400}]}' > "$TIMING"
fi
[ -f "$TIMING" ] || { echo "!! no $TIMING — run scenes.mjs first (or use --smoke)." >&2; exit 1; }

# Plan: pace each scene to a NARRATION beat. The warmed demo runs far faster than
# the 58.5s VO, so a straight trim races ahead of it. Instead every scene is held
# to a target window matched to the script order (hook→ask→chips→route→mic→tier→
# sign→beacon→close): if the real clip is SHORTER than target we freeze its last
# frame (tpad clone) up to target; if LONGER we trim the tail. Net: each clip ==
# its target, so the cut tracks the voice-over. Targets sum to ~60s; override any
# with a flat JSON map in BEATS_JSON (or ./beats.json) for final-cut tuning. The
# helper EXITS NONZERO if the paced total falls outside 58-62s (real path).
BEATS_FILE="${BEATS_JSON:-beats.json}"; [ -f "$BEATS_FILE" ] || BEATS_FILE=""
[ -n "$BEATS_FILE" ] && echo "==> BEATS override: $BEATS_FILE" >&2
MODE="real"; [ "$SMOKE" = "1" ] && MODE="smoke"
PLAN=$(node - "$TIMING" "$CAPTURE_LEAD" "$MODE" "$BEATS_FILE" <<'NODE'
const fs = require('fs');
const [, , tp, lead, mode, beatsFile] = process.argv;
const L = parseFloat(lead) || 0;
const MIN_REAL = 0.20;   // floor the real window so tpad always has a last frame to clone
const T = JSON.parse(fs.readFileSync(tp, 'utf8'));
// Beat targets (seconds), script order — sum ~= 60 so the cut fills the 58.5s VO.
const BEATS = { 'idle-ready': 4, 'hero-ask': 5, 'trace-chips': 12, 'route-draw': 8, 'mic-pulse': 3, 'tier-swap': 6, 'read-sign': 8, 'beacon': 8, 'end-hold': 6 };
if (beatsFile) { try { Object.assign(BEATS, JSON.parse(fs.readFileSync(beatsFile, 'utf8'))); } catch (e) { console.error('bad BEATS_JSON: ' + e.message); process.exit(4); } }
// Trim anchor per scene: 'head' keeps the first `target`s (default); 'tail' keeps
// the LAST `target`s. beacon tail-anchors so its 8s beat lands on the STROBE
// payoff (the ~13s climax) instead of the model arming that leads up to it.
const ANCHOR = { beacon: 'tail' };
const scenes = T.scenes || [];
if (!scenes.length) { console.error('no scenes in timing'); process.exit(2); }
let total = 0; const rows = [];
for (const s of scenes) {
  const real = Math.max((s.ms || 0) / 1000, 0);
  let target;
  if (s.label in BEATS) target = BEATS[s.label];
  else if (mode === 'smoke') target = Math.max(0.4, Math.min(real || 1.5, 6)); // smoke: cap, never stretch
  else { target = 6; console.error(`   (no beat for '${s.label}', defaulting ${target}s)`); }
  const ex = Math.min(Math.max(real, MIN_REAL), target);  // real window, floored, never past target
  const pad = +(target - ex).toFixed(3);                   // frozen tail (0 when we trimmed instead)
  const trimmed = real > target + 0.001;
  const anchor = ANCHOR[s.label] || 'head';
  // a tail-anchored trim slides the start forward to keep the LAST target seconds
  let startSec = L + (s.startMs || 0) / 1000;
  if (trimmed && anchor === 'tail') startSec += real - target;
  rows.push(`${s.label} ${startSec.toFixed(3)} ${ex.toFixed(3)} ${pad.toFixed(3)}`);
  total += target;
  const how = pad > 0.001 ? 'hold +' + pad.toFixed(1) + 's' : (trimmed ? 'trim(' + anchor + ')' : 'exact');
  console.error(`   ${s.label.padEnd(12)} real ${real.toFixed(1)}s → ${target}s  ${how}`);
}
total = +total.toFixed(3);
if (total > 62) { console.error(`paced plan ${total}s exceeds 62s`); process.exit(3); }
if (mode !== 'smoke' && total < 58) { console.error(`paced plan ${total}s under 58s (would not fill the VO)`); process.exit(3); }
console.error(`==> plan: ${rows.length} scenes paced to ${total}s (VO ~58.5s)`);
process.stdout.write(rows.join('\n'));
NODE
) || { echo "!! FAIL: paced plan outside the 58-62s window (or timing/BEATS parse failed)." >&2; exit 1; }

# Extract each scene → clean 1920x1080p60, holding the last frame (tpad clone) to
# fill its beat. stop_duration=0 is a safe no-op, so tpad is appended unconditionally.
i=0; CONCATLIST="$WORK/concat.txt"; : > "$CONCATLIST"
while read -r label st ex pad; do
  [ -z "$label" ] && continue
  clip="$WORK/clip_$(printf '%02d' "$i").mov"
  ffmpeg -hide_banner -loglevel error -y -ss "$st" -t "$ex" -i "$CAPTURE" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${pad}" \
    -an "${MEZZ[@]}" "$clip"
  echo "file '$clip'" >> "$CONCATLIST"; i=$((i + 1))
done <<< "$PLAN"
[ "$i" -gt 0 ] || { echo "!! no clips extracted" >&2; exit 1; }

DEMO="$WORK/demo.mov"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$CONCATLIST" "${MEZZ[@]}" -pix_fmt yuv420p "$DEMO"

# Overlay captions — ONLY if they carry alpha. An opaque caption webm (pix_fmt
# yuv420p) composites its black background over the entire demo and would ship an
# all-black master; detect that and SKIP (a caption-less but visible cut beats a
# black one) with a loud warning so the Remotion render gets re-done with alpha.
DEMOCAP="$DEMO"
if [ -n "$CAPS" ]; then
  CAPPF=$(ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of default=nw=1:nk=1 "$CAPS" 2>/dev/null || echo "")
  if echo "$CAPPF" | grep -qiE 'yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16'; then
    DEMOCAP="$WORK/democap.mov"
    ffmpeg -hide_banner -loglevel error -y -i "$DEMO" -i "$CAPS" \
      -filter_complex "[0:v]format=yuv420p[b];[1:v]scale=1920:1080,fps=60,format=yuva420p[c];[b][c]overlay=shortest=1[v]" \
      -map "[v]" "${MEZZ[@]}" -pix_fmt yuv420p "$DEMOCAP"
  else
    echo "!! WARNING: captions '$CAPS' have NO alpha (pix_fmt=${CAPPF:-unknown}) — an opaque overlay would black out the video. SKIPPING captions. Re-render the Remotion webm with alpha (vp8/vp9, pixel-format yuva420p)." >&2
  fi
fi

# Optional broll bookends (xfade); shift the audio to start at the demo.
VISUALS="$WORK/visuals.mov"; DEMODUR=$(dur "$DEMOCAP")
if [ -n "$INTRO" ] && [ -f "$INTRO" ] && [ -n "$OUTRO" ] && [ -f "$OUTRO" ]; then
  ID=$(dur "$INTRO")
  OFF1=$(node -e "console.log((${ID}-${XF}).toFixed(3))")
  OFF2=$(node -e "console.log((${ID}-${XF}+${DEMODUR}-${XF}).toFixed(3))")
  ffmpeg -hide_banner -loglevel error -y -i "$DEMOCAP" -i "$INTRO" -i "$OUTRO" -filter_complex "
    [1:v]scale=1920:1080,fps=60,format=yuv420p[intro];
    [2:v]scale=1920:1080,fps=60,format=yuv420p[outro];
    [intro][0:v]xfade=transition=fade:duration=${XF}:offset=${OFF1}[a];
    [a][outro]xfade=transition=fade:duration=${XF}:offset=${OFF2}[v]
  " -map "[v]" "${MEZZ[@]}" -pix_fmt yuv420p "$VISUALS"
  ADELAY=$(node -e "console.log(Math.round((${ID}-${XF})*1000))")
  ffmpeg -hide_banner -loglevel error -y -i "$AUDIO" -af "adelay=${ADELAY}|${ADELAY}" -ar 48000 "$WORK/audio_shift.wav"
  AUDIO="$WORK/audio_shift.wav"
else
  cp "$DEMOCAP" "$VISUALS"
fi

# HARD runtime guard — FAIL LOUDLY if the paced cut drifts out of the VO window.
# Real path: must land 58-62s (fills the 58.5s VO). Smoke: upper-bound only.
VDUR=$(dur "$VISUALS")
echo "==> assembled visuals: ${VDUR}s" >&2
if [ "$SMOKE" = "1" ]; then
  node -e "process.exit(parseFloat('${VDUR}') > 62 ? 1 : 0)" || { echo "!! FAIL: assembled runtime ${VDUR}s exceeds 62s." >&2; exit 1; }
else
  node -e "const d=parseFloat('${VDUR}'); process.exit(d>=57.5 && d<=62 ? 0 : 1)" || { echo "!! FAIL: assembled runtime ${VDUR}s outside the 58-62s window." >&2; exit 1; }
fi

# ---------- final encode ----------
echo "==> encoding → $OUT" >&2
if [ "$ROUGH" = "1" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$VISUALS" -i "$AUDIO" \
    -c:v h264_videotoolbox -b:v 16M -r 60 -pix_fmt yuv420p \
    -c:a aac -b:a 384k -ar 48000 -shortest -movflags +faststart "$OUT"
else
  ffmpeg -hide_banner -loglevel error -y -i "$VISUALS" -i "$AUDIO" \
    -c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p \
    -b:v 16M -maxrate 18M -bufsize 24M -r 60 \
    -c:a aac -b:a 384k -ar 48000 -shortest -movflags +faststart "$OUT"
fi
echo "==> done: $OUT  ($(dur "$OUT")s, $(du -h "$OUT" | cut -f1))" >&2
