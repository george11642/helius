#!/usr/bin/env bash
# capture.sh — parallel screen capture for the Helius demo (ffmpeg avfoundation).
#
# The craft move (see helius-assets/research/video.md §2): Playwright DRIVES a
# Chrome window; THIS captures the physical screen in a separate process — never
# Playwright's own recorder (its bitrate is hardcoded ~1Mbit/s). Chrome must be a
# 960x540 window at 0,0 with device-scale-factor 2 (→ 1920x1080 physical), so we
# crop exactly 1920:1080:0:0.
#
#   ./capture.sh [--rough] [--seconds N] [--out FILE]
#     --rough      h264_videotoolbox (fast, for timing checks). Default: ProRes mezzanine.
#     --seconds N  stop after N seconds. Default: record until Ctrl-C (q).
#     --out FILE   output path. Default: takes/capture-<ts>.mov
#   env: SCREEN_INDEX (override auto-detect), CROP_Y (menu-bar offset if not hidden)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p takes

ROUGH=0 SECONDS_ARG="" OUT="" LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rough) ROUGH=1; shift ;;
    --list) LIST=1; shift ;;
    --seconds) SECONDS_ARG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --- locate the screen-capture avfoundation device index ---
echo "==> avfoundation devices:" >&2
DEVLIST=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true)
echo "$DEVLIST" | grep -iE "capture screen|\bscreen\b|camera|microphone" >&2 || true
IDX="${SCREEN_INDEX:-$(echo "$DEVLIST" | grep -i "Capture screen" | head -1 | sed -E 's/.*\[([0-9]+)\] Capture screen.*/\1/')}"
if ! [[ "$IDX" =~ ^[0-9]+$ ]]; then
  echo "!! could not auto-detect the screen device index — set SCREEN_INDEX=N (from the list above)." >&2
  exit 1
fi
echo "==> using screen device index: $IDX" >&2
[ "$LIST" = "1" ] && { echo "$IDX"; exit 0; }

CROP_X="${CROP_X:-0}"
CROP_Y="${CROP_Y:-0}"
if [ "$CROP_Y" = "0" ]; then
  echo "   Pre-flight: HIDE the menu bar first (System Settings → Control Center →" >&2
  echo "   'Automatically hide and show the menu bar') so the window's top-left is a true 0,0." >&2
  echo "   If you can't, measure the menu-bar height in PHYSICAL px and pass CROP_Y=<h>." >&2
fi

# Pre-flight screenshot so the operator can eyeball window alignment before rolling.
PREFLIGHT="takes/preflight.png"
screencapture -x -R0,0,960,540 "$PREFLIGHT" 2>/dev/null || screencapture -x "$PREFLIGHT" 2>/dev/null || true
[ -f "$PREFLIGHT" ] && echo "==> pre-flight frame: $PREFLIGHT (check the Chrome window fills 0,0 → 960x540)" >&2

# --- codec ---
if [ "$ROUGH" = "1" ]; then
  VCODEC=(-c:v h264_videotoolbox -b:v 20M -realtime 1); LABEL="rough-h264"
else
  VCODEC=(-c:v prores_videotoolbox -profile:v 3); LABEL="prores"
fi
[ -n "$OUT" ] || OUT="takes/capture-$(date +%H%M%S)-${LABEL}.mov"
DUR=(); [ -n "$SECONDS_ARG" ] && DUR=(-t "$SECONDS_ARG")

echo "==> recording → $OUT  (${LABEL}, 60fps, cursor on; press q to stop)" >&2
exec ffmpeg -hide_banner \
  -f avfoundation -framerate 60 -capture_cursor 1 -i "${IDX}:none" \
  ${DUR[@]+"${DUR[@]}"} \
  -vf "crop=1920:1080:${CROP_X}:${CROP_Y}" \
  "${VCODEC[@]}" \
  -pix_fmt yuv420p \
  "$OUT"
