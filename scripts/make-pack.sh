#!/bin/zsh
# make-pack.sh — build a complete Helius offline region pack from a bounding box.
#
#   scripts/make-pack.sh <pack-id> <west,south,east,north> "<Display Name>" [trailheads.json]
#
# Produces public/data/packs/<pack-id>/{basemap.pmtiles, terrain.pmtiles,
# graph.bin, pois.json, manifest.json}. Each new region ≈ 2 minutes on decent
# wifi. Raw Overpass inputs are cached in $HELIUS_ASSETS/map/<pack-id>/ so
# rebuilds are offline-capable.
#
# Requires: pmtiles CLI (brew install pmtiles), curl, node, python3.
set -euo pipefail

PACK_ID=${1:?pack id}
BBOX=${2:?bbox west,south,east,north}
NAME=${3:?display name}
TRAILHEADS=${4:-}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ASSETS=${HELIUS_ASSETS:-$HOME/dev/helius-assets}
CACHE="$ASSETS/map/$PACK_ID"
OUT="$ROOT/public/data/packs/$PACK_ID"
mkdir -p "$CACHE" "$OUT"

W=$(echo "$BBOX" | cut -d, -f1); S=$(echo "$BBOX" | cut -d, -f2)
E=$(echo "$BBOX" | cut -d, -f3); N=$(echo "$BBOX" | cut -d, -f4)
# Overpass wants south,west,north,east
OP_BBOX="$S,$W,$N,$E"
PROTOMAPS_BUILD=${PROTOMAPS_BUILD:-20260703}

echo "==> [$PACK_ID] basemap extract ($BBOX)"
[ -s "$OUT/basemap.pmtiles" ] || pmtiles extract "https://build.protomaps.com/$PROTOMAPS_BUILD.pmtiles" "$OUT/basemap.pmtiles" --bbox="$BBOX"

echo "==> [$PACK_ID] terrain extract"
[ -s "$OUT/terrain.pmtiles" ] || pmtiles extract https://download.mapterhorn.com/planet.pmtiles "$OUT/terrain.pmtiles" --bbox="$BBOX"

fetch_overpass() { # <query> <outfile>
  local q=$1 out=$2 url
  [ -s "$out" ] && head -c1 "$out" | grep -q '{' && { echo "    (cached $out)"; return 0; }
  for url in "https://overpass.kumi.systems/api/interpreter" "https://overpass-api.de/api/interpreter" "https://maps.mail.ru/osm/tools/overpass/api/interpreter"; do
    echo "    overpass: $url"
    if curl -s --max-time 240 "$url" --data-urlencode "data=$q" -o "$out" && head -c1 "$out" | grep -q '{'; then
      return 0
    fi
  done
  echo "FAIL: overpass exhausted for $out"; return 1
}

echo "==> [$PACK_ID] trails (Overpass)"
fetch_overpass "[out:json][timeout:180][bbox:$OP_BBOX];(way[highway~\"^(track|path|footway|steps|bridleway|residential|tertiary|secondary|primary|unclassified)\$\"];);out geom;" "$CACHE/trails.json"

echo "==> [$PACK_ID] peaks + huts (Overpass)"
fetch_overpass "[out:json][timeout:60][bbox:$OP_BBOX];(node[natural=peak][name];node[amenity=shelter][name];node[tourism=alpine_hut][name];);out;" "$CACHE/peaks.json"

echo "==> [$PACK_ID] routing graph"
export HELIUS_PACK="$PACK_ID" HELIUS_TRAILS="$CACHE/trails.json" HELIUS_PEAKS="$CACHE/peaks.json"
if [ -n "$TRAILHEADS" ]; then export HELIUS_TRAILHEADS="$TRAILHEADS"; else unset HELIUS_TRAILHEADS; fi
node "$ROOT/scripts/build-graph.mjs"

echo "==> [$PACK_ID] manifest"
python3 - "$PACK_ID" "$NAME" "$W" "$S" "$E" "$N" "$OUT" <<'EOF'
import json, os, sys
pid, name, w, s, e, n, out = sys.argv[1:8]
w, s, e, n = map(float, (w, s, e, n))
sizes = {f: os.path.getsize(os.path.join(out, f)) for f in os.listdir(out) if not f.startswith('.') and f != 'manifest.json'}
json.dump({
  'id': pid, 'name': name,
  'bbox': [w, s, e, n], 'center': [round((w+e)/2, 5), round((s+n)/2, 5)],
  'files': sizes, 'totalBytes': sum(sizes.values()),
}, open(os.path.join(out, 'manifest.json'), 'w'), indent=2)
print(f"manifest: {sum(sizes.values())/1e6:.1f} MB total")
EOF

echo "==> [$PACK_ID] DONE → $OUT"
ls -la "$OUT"
