#!/usr/bin/env bash
set -euo pipefail

# Generic tool-server E2E driver shared by every cell of e2e-device-smoke.yml
# (iOS sim / Android emulator / Chromium-Electron, on macOS or Linux). It boots
# ONE device through an already-running tool-server, then asserts the core
# interaction pipeline works headlessly:
#   1. boot-device reports booted:true
#   2. screenshot returns real (non-blank) pixels
#   3. gesture-tap round-trips
# This mirrors the three assertions inlined in wayland-e2e.yml, but parameterised
# so each platform job stays a few lines. Every tool takes the device id as
# `udid` and screenshots come back as the same ArtifactHandle envelope
# (data.image.hostPath) regardless of platform, so the body is uniform.
#
# Inputs (env):
#   BOOT_JSON          required  JSON body for POST /boot-device
#   DEVICE_ID          required  id/udid/serial for screenshot + gesture-tap
#                                (e.g. emulator-5554, an iOS UDID, chromium-cdp-<port>)
#   BASE_URL           optional  default http://127.0.0.1:3033/tools
#   MIN_SHOT_BYTES     optional  default 20000 (all-zero framebuffer PNGs are ~3-7 KB)
#   SLEEP_BEFORE_SHOT  optional  default 0  (Android needs ~15s for SurfaceFlinger)
#   BOOT_CURL_TIMEOUT  optional  default 900 (curl -m seconds; > the boot budget)
#   ARTIFACT_DIR       optional  default ${RUNNER_TEMP:-/tmp}; screenshot copied here

: "${BOOT_JSON:?BOOT_JSON is required}"
: "${DEVICE_ID:?DEVICE_ID is required}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3033/tools}"
MIN_SHOT_BYTES="${MIN_SHOT_BYTES:-20000}"
SLEEP_BEFORE_SHOT="${SLEEP_BEFORE_SHOT:-0}"
BOOT_CURL_TIMEOUT="${BOOT_CURL_TIMEOUT:-900}"
ARTIFACT_DIR="${ARTIFACT_DIR:-${RUNNER_TEMP:-/tmp}}"
mkdir -p "$ARTIFACT_DIR"

echo "::group::boot-device ($DEVICE_ID)"
echo "POST ${BASE_URL}/boot-device  body=${BOOT_JSON}"
T0=$(date +%s)
BOOT_RESP=$(curl -sS -m "$BOOT_CURL_TIMEOUT" -X POST "${BASE_URL}/boot-device" \
  -H 'Content-Type: application/json' -d "$BOOT_JSON")
T1=$(date +%s)
echo "boot-device ($((T1 - T0))s): $BOOT_RESP"
echo "::endgroup::"
echo "$BOOT_RESP" | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('data',{}).get('booted') is True else 1)" || {
  echo "::error::boot-device did not report booted:true"
  exit 1
}

if [ "$SLEEP_BEFORE_SHOT" -gt 0 ]; then
  echo "Waiting ${SLEEP_BEFORE_SHOT}s for the compositor to paint the first frame..."
  sleep "$SLEEP_BEFORE_SHOT"
fi

echo "::group::screenshot"
SHOT_JSON="$ARTIFACT_DIR/smoke-shot.json"
# Retry a few times: a fresh-spawn streaming-screenshot race (issue #391) can
# briefly return an error envelope before the first frame is available. A tiny
# loop is cheap belt-and-suspenders for this one-shot smoke.
HOST_PATH=""
for attempt in 1 2 3; do
  curl -sS -m 60 -X POST "${BASE_URL}/screenshot" \
    -H 'Content-Type: application/json' \
    -d "{\"udid\":\"${DEVICE_ID}\"}" >"$SHOT_JSON" || true
  # Surface a tool-side error as a clean annotation instead of letting the
  # hostPath extraction blow up with a raw python KeyError traceback.
  ERR=$(python3 -c "import json,sys;
try:
    d=json.load(open('$SHOT_JSON'))
except Exception as e:
    print('unparseable screenshot response: %s' % e); sys.exit(0)
print(d.get('error','') if isinstance(d,dict) else '')")
  if [ -n "$ERR" ]; then
    echo "screenshot attempt ${attempt}/3 failed: ${ERR}"
    sleep 2
    continue
  fi
  # The screenshot tool returns an ArtifactHandle ({ image: { hostPath, ... } });
  # the job runs co-located with the tool-server so hostPath is readable here.
  HOST_PATH=$(python3 -c "import json;print(json.load(open('$SHOT_JSON')).get('data',{}).get('image',{}).get('hostPath',''))")
  [ -n "$HOST_PATH" ] && break
  echo "screenshot attempt ${attempt}/3 returned no hostPath"
  sleep 2
done
if [ -z "$HOST_PATH" ]; then
  echo "::error::screenshot did not return a readable hostPath after 3 attempts (last response: $(cat "$SHOT_JSON"))"
  exit 1
fi
SHOT_PNG="$ARTIFACT_DIR/smoke-shot.png"
cp "$HOST_PATH" "$SHOT_PNG"
# `wc -c` instead of `stat` so the script is identical on macOS and Linux
# (BSD stat uses -f%z, GNU stat uses -c%s).
SZ=$(wc -c <"$SHOT_PNG" | tr -d '[:space:]')
echo "screenshot=${SHOT_PNG} size=${SZ}B (floor ${MIN_SHOT_BYTES}B)"
echo "::endgroup::"
# An all-zero / uniform framebuffer PNG-compresses to a few KB; a real painted
# screen is reliably larger. Guards against the boot "succeeding" but the
# device never actually rendering.
test "$SZ" -gt "$MIN_SHOT_BYTES" || {
  echo "::error::screenshot too small (${SZ}B) — likely a blank/all-zero framebuffer"
  exit 1
}

echo "::group::gesture-tap"
TAP_RESP=$(curl -sS -m 30 -X POST "${BASE_URL}/gesture-tap" \
  -H 'Content-Type: application/json' \
  -d "{\"udid\":\"${DEVICE_ID}\",\"x\":0.5,\"y\":0.5}")
echo "gesture-tap: $TAP_RESP"
echo "::endgroup::"
echo "$TAP_RESP" | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('data',{}).get('tapped') is True else 1)" || {
  echo "::error::gesture-tap did not report tapped:true"
  exit 1
}

echo "✅ smoke OK: booted + screenshot ${SZ}B + tap on ${DEVICE_ID}"
