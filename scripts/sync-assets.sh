#!/usr/bin/env bash
set -euo pipefail

# Copies demo/dev assets from the local prep cache (~/dev/helius-assets — not
# committed to git, not part of this repo) into public/, where Vite serves
# them and the workbox runtimeCaching rules in vite.config.ts pick them up
# (*.pmtiles -> 'map-data' cache). Safe to re-run.

ASSETS="${HELIUS_ASSETS:-$HOME/dev/helius-assets}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MAP_SRC="$ASSETS/map"
PACK_DIR="$ROOT/public/data/packs/sandia"
VENDOR_DIR="$ROOT/public/vendor"

mkdir -p "$PACK_DIR" "$VENDOR_DIR"

echo "==> basemap + terrain + peaks (Sandia pack)"
cp -f "$MAP_SRC/abq-sandia.pmtiles" "$PACK_DIR/basemap.pmtiles"
cp -f "$MAP_SRC/abq-sandia-terrain.pmtiles" "$PACK_DIR/terrain.pmtiles"
cp -f "$MAP_SRC/sandia-peaks.json" "$PACK_DIR/peaks.json"

echo "==> fonts + sprites"
rm -rf "$VENDOR_DIR/fonts" "$VENDOR_DIR/sprites"
cp -r "$MAP_SRC/basemaps-assets/fonts" "$VENDOR_DIR/fonts"
cp -r "$MAP_SRC/basemaps-assets/sprites" "$VENDOR_DIR/sprites"

# TODO: sandia-trails.json ($MAP_SRC/sandia-trails.json, ~20MB raw Overpass
# data) is intentionally NOT copied here. It needs a build step to compact it
# into a routing graph (ngraph.graph nodes/edges) before the A* tool can use
# it — once that step exists, copy its compacted output (not the raw JSON)
# into $PACK_DIR instead.

echo "done."
du -sh "$PACK_DIR"/* "$VENDOR_DIR/fonts" "$VENDOR_DIR/sprites" 2>/dev/null || true
