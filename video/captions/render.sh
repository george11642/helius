#!/usr/bin/env bash
# render.sh — build the word-synced caption overlay as a TRANSPARENT .mov.
#
# Why a .mov and not a .webm: Remotion's webm-alpha ENCODE is broken on this
# machine. vp8 AND vp9, via the --pixel-format=yuva420p CLI flag AND via
# calculateMetadata, all flatten to opaque yuv420p — the FRAMES render rgba
# correctly (verified: a still is pix_fmt=rgba with a real alpha plane), but the
# mux drops the alpha. ffmpeg's own libvpx-vp9 can't encode alpha here either.
# So: render the transparent PNG sequence, then mux to QTRLE .mov — lossless,
# argb, tiny for mostly-transparent frames, and ffmpeg `overlay` composites it
# (all verified). assemble.sh's caption guard then picks up ../captions.mov.
set -euo pipefail
cd "$(dirname "$0")"                        # video/captions/
FRAMES="out/frames"
OUT="../captions.mov"
rm -rf "$FRAMES"; mkdir -p "$FRAMES"

# Real ElevenLabs /with-timestamps alignment → props (drives the per-word highlight).
node -e 'const fs=require("fs");fs.writeFileSync("render-props.json",JSON.stringify({alignment:require("../alignment.json").alignment,repoUrl:"github.com/george11642/helius"}))'

echo "==> rendering transparent caption PNG sequence (60s @ 60fps = 3600 frames)…" >&2
npx remotion render src/index.ts CaptionComp "$FRAMES" \
  --props=render-props.json --sequence --image-format=png --log=info

N=$(ls "$FRAMES"/element-*.png 2>/dev/null | wc -l | tr -d ' ')
[ "$N" -gt 0 ] || { echo "!! no frames rendered into $FRAMES" >&2; exit 1; }
echo "==> muxing $N frames → $OUT (QTRLE, argb)…" >&2
# Remotion zero-pads the sequence to the full frame count (element-0000.png …
# element-3599.png); a glob input is robust to whatever padding width it picks.
ffmpeg -hide_banner -loglevel error -y -framerate 60 -pattern_type glob -i "$FRAMES/element-*.png" \
  -c:v qtrle -pix_fmt argb "$OUT"

PF=$(ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of default=nw=1:nk=1 "$OUT")
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
echo "==> $OUT  pix_fmt=$PF  dur=${DUR}s  size=$(du -h "$OUT" | cut -f1)" >&2
case "$PF" in argb|rgba|yuva*) echo "==> alpha OK — assemble.sh will overlay it." >&2 ;; *) echo "!! $OUT has NO alpha (pix_fmt=$PF)" >&2; exit 1 ;; esac
rm -rf "$FRAMES"   # keep the .mov, drop the frame scratch
