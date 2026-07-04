#!/bin/zsh
# Real airplane-mode proof with GUARANTEED Wi-Fi restore.
# Pattern: buffer sleep (lets the orchestrator's API turn finish) → Wi-Fi OFF
# → self-contained Playwright offline check → Wi-Fi ON no matter what.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
BUFFER=${BUFFER:-45}
echo "buffer ${BUFFER}s before going offline…"
sleep "$BUFFER"

WIFI_DEV=$(networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}')
echo "wifi device: $WIFI_DEV"
restore() { networksetup -setairportpower "$WIFI_DEV" on; echo "WIFI RESTORED"; }
trap restore EXIT INT TERM

networksetup -setairportpower "$WIFI_DEV" off
echo "WIFI OFF at $(date +%T)"
sleep 5

cd "$HERE"
mkdir -p takes
node wifi-offline-check.mjs > takes/wifi-proof-result.json 2> takes/wifi-proof.log
EXIT=$?
echo "check exit=$EXIT at $(date +%T)"
# trap restores wifi on exit
exit $EXIT
