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

# ---------- VIDEO: trim per-scene clips (scenes-timing.json), concat, overlay captions, guard ≤62s ----------
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

# Plan: per-scene trimmed window (label startSec durSec) from the timings + a beat
# budget. The helper totals it and EXITS NONZERO if the budget already exceeds 62s.
PLAN=$(node - "$TIMING" "$CAPTURE_LEAD" <<'NODE'
const fs = require('fs');
const [, , tp, lead] = process.argv;
const L = parseFloat(lead) || 0;
const T = JSON.parse(fs.readFileSync(tp, 'utf8'));
// beat budget (seconds): hook ~5, demo ~30, tech ~8, close ~8
const BUD = { 'idle-ready': 2, 'hero-ask': 3, 'trace-chips': 12, 'route-draw': 6, 'mic-pulse': 2, 'tier-swap': 8, 'read-sign': 9, 'beacon': 5, 'end-hold': 3, a: 1.5, b: 1.5, c: 1.4 };
let total = 0; const rows = [];
for (const s of (T.scenes || [])) {
  const cap = BUD[s.label] ?? 6;
  const dur = Math.max(0.4, Math.min((s.ms || cap * 1000) / 1000, cap));
  rows.push(`${s.label} ${(L + (s.startMs || 0) / 1000).toFixed(3)} ${dur.toFixed(3)}`);
  total += dur;
}
if (!rows.length) { console.error('no scenes in timing'); process.exit(2); }
if (total > 62) { console.error(`plan budget ${total.toFixed(1)}s exceeds the 62s limit`); process.exit(3); }
console.error(`==> plan: ${rows.length} scenes, ${total.toFixed(1)}s trimmed total`);
process.stdout.write(rows.join('\n'));
NODE
) || { echo "!! FAIL: scene plan exceeds the 62s limit (or timing parse failed)." >&2; exit 1; }

# Extract each trimmed scene clip, letterboxed to a clean 1920x1080p60.
i=0; CONCATLIST="$WORK/concat.txt"; : > "$CONCATLIST"
while read -r label st du; do
  [ -z "$label" ] && continue
  clip="$WORK/clip_$(printf '%02d' "$i").mov"
  ffmpeg -hide_banner -loglevel error -y -ss "$st" -t "$du" -i "$CAPTURE" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p,setpts=PTS-STARTPTS" \
    -an "${MEZZ[@]}" "$clip"
  echo "file '$clip'" >> "$CONCATLIST"; i=$((i + 1))
done <<< "$PLAN"
[ "$i" -gt 0 ] || { echo "!! no clips extracted" >&2; exit 1; }

DEMO="$WORK/demo.mov"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$CONCATLIST" "${MEZZ[@]}" -pix_fmt yuv420p "$DEMO"

# Overlay captions onto the trimmed demo.
DEMOCAP="$DEMO"
if [ -n "$CAPS" ]; then
  DEMOCAP="$WORK/democap.mov"
  ffmpeg -hide_banner -loglevel error -y -i "$DEMO" -i "$CAPS" \
    -filter_complex "[0:v]format=yuv420p[b];[1:v]scale=1920:1080,fps=60[c];[b][c]overlay=shortest=1[v]" \
    -map "[v]" "${MEZZ[@]}" -pix_fmt yuv420p "$DEMOCAP"
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

# HARD runtime guard — FAIL LOUDLY if the assembled visuals exceed 62s.
VDUR=$(dur "$VISUALS")
echo "==> assembled visuals: ${VDUR}s" >&2
node -e "process.exit(parseFloat('${VDUR}') > 62 ? 1 : 0)" || { echo "!! FAIL: assembled runtime ${VDUR}s exceeds the 62s limit." >&2; exit 1; }

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
