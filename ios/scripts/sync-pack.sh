#!/usr/bin/env bash
# Copies the git-ignored offline map archive into the iOS bundle folder.
# The webapp's copy comes from R2 (see the repo README asset pipeline);
# fetch it there first if public/data/packs/sandia/basemap.pmtiles is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="../public/data/packs/sandia/basemap.pmtiles"
DST="web-map/pack/basemap.pmtiles"

if [[ ! -f "$SRC" ]]; then
  echo "error: $SRC not found — fetch the sandia pack for the webapp first" >&2
  exit 1
fi

cp "$SRC" "$DST"
echo "synced $(du -h "$DST" | cut -f1) -> $DST"
