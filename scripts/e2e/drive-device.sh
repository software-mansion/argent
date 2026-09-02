#!/usr/bin/env bash
set -euo pipefail

# Generic tool-server E2E driver for the e2e-device-smoke.yml jobs (iOS sim on
# macOS, Chromium/Electron on Linux and macOS). It boots ONE device through an
# already-running tool-server, then asserts the core interaction pipeline:
#   1. boot-device reports booted:true
#   2. screenshot returns real (non-blank) pixels
#   3. gesture-tap round-trips
# The same three assertions wayland-e2e.yml inlines for the Android emulator,
# parameterised: screenshot and gesture-tap take the device as `udid` and answer
# in the same shapes on every platform, so the body is uniform. With
# CHECK_RETRY_SCALE set it also holds the simulator-server binary to the resize
# contract REFUSED_CAPTURE_RETRY_SCALE rests on (see below).
#
# Inputs (env):
#   BOOT_JSON          JSON body for POST /boot-device
#   DEVICE_ID          udid for screenshot + gesture-tap
#                      (an iOS UDID, chromium-cdp-<port>, an adb serial)
#   BASE_URL           tool-server /tools endpoint
#   MIN_SHOT_BYTES     screenshot size floor; all-zero framebuffers are ~3-7 KB
#   SLEEP_BEFORE_SHOT  settle time before the first capture
#   BOOT_CURL_TIMEOUT  curl -m for boot-device; must exceed the boot budget
#   ARTIFACT_DIR       screenshot and raw response land here
#   CHECK_RETRY_SCALE  non-empty runs the retry-scale fidelity check. Only for
#                      simulator-server backends: on Chromium a scale below 1
#                      needs the optional `sharp` dependency.

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
# Retry: a fresh-spawn streaming-screenshot race (issue #391) can briefly return
# an error envelope before the first frame is available.
HOST_PATH=""
for attempt in 1 2 3; do
  curl -sS -m 60 -X POST "${BASE_URL}/screenshot" \
    -H 'Content-Type: application/json' \
    -d "{\"udid\":\"${DEVICE_ID}\"}" >"$SHOT_JSON" || true
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
  # hostPath is a tool-server-local path; this job is co-located, so it is
  # readable here.
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
# `wc -c`, not `stat`: BSD stat uses -f%z, GNU stat uses -c%s.
SZ=$(wc -c <"$SHOT_PNG" | tr -d '[:space:]')
echo "screenshot=${SHOT_PNG} size=${SZ}B (floor ${MIN_SHOT_BYTES}B)"
echo "::endgroup::"
# Catches a boot that "succeeds" while the device never renders: a uniform
# framebuffer PNG-compresses to a few KB, a painted screen is reliably larger.
test "$SZ" -gt "$MIN_SHOT_BYTES" || {
  echo "::error::screenshot too small (${SZ}B) — likely a blank/all-zero framebuffer"
  exit 1
}

# A capture the device refuses unscaled is re-requested at
# REFUSED_CAPTURE_RETRY_SCALE — one part in a million below 1
# (packages/tool-server/src/utils/simulator-client.ts). That recovers the frame
# rather than a reduced one only because simulator-server rounds
# `dimension × scale` back to the dimension, so the retry keys the same
# baseline file every other host writes. The binary is fetched from a rolling
# tag and is not in-tree, so no unit suite can hold it to that; this does.
if [ -n "${CHECK_RETRY_SCALE:-}" ]; then
  echo "::group::retry-scale fidelity"
  REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  # Read the scale off the constant rather than restating it: a check pinned to
  # its own literal would keep passing for a value the code no longer sends.
  RETRY_SCALE=$(python3 - "$REPO_ROOT/packages/tool-server/src/utils/simulator-client.ts" <<'READ_SCALE'
import re, sys
m = re.search(r"REFUSED_CAPTURE_RETRY_SCALE\s*=\s*([^;]+);", open(sys.argv[1]).read())
if not m:
    sys.exit("REFUSED_CAPTURE_RETRY_SCALE is gone from %s" % sys.argv[1])
scale = eval(m.group(1), {"__builtins__": {}})
if not 0 < scale < 1:
    sys.exit("REFUSED_CAPTURE_RETRY_SCALE is %r, which is not a scale below 1" % scale)
print(repr(scale))
READ_SCALE
  )
  # $1 = scale, $2 = label. Echoes the tool-server-local png path, or "" — the
  # caller reports, so a failed capture must not trip `set -e` in here.
  capture_at() {
    local out="$ARTIFACT_DIR/retry-scale-$2.json"
    curl -sS -m 60 -X POST "${BASE_URL}/screenshot" \
      -H 'Content-Type: application/json' \
      -d "{\"udid\":\"${DEVICE_ID}\",\"scale\":$1,\"includeImageInContext\":false}" \
      >"$out" || true
    python3 -c "import json,sys
try:
    d = json.load(open('$out'))
except Exception:
    print(''); sys.exit(0)
print(d.get('data', {}).get('image', {}).get('hostPath', '') if isinstance(d, dict) else '')"
  }
  png_dims() {
    python3 -c "import struct,sys
head = open(sys.argv[1], 'rb').read(24)
if head[:8] != b'\x89PNG\r\n\x1a\n':
    sys.exit('%s is not a PNG' % sys.argv[1])
print('%dx%d' % struct.unpack('>II', head[16:24]))" "$1"
  }
  FULL_PATH=$(capture_at 1.0 unscaled)
  RETRY_PATH=$(capture_at "$RETRY_SCALE" retry)
  if [ -z "$FULL_PATH" ] || [ -z "$RETRY_PATH" ]; then
    echo "::error::retry-scale check could not capture (unscaled=$(cat "$ARTIFACT_DIR/retry-scale-unscaled.json"), retry=$(cat "$ARTIFACT_DIR/retry-scale-retry.json"))"
    exit 1
  fi
  FULL_DIMS=$(png_dims "$FULL_PATH")
  RETRY_DIMS=$(png_dims "$RETRY_PATH")
  echo "unscaled=${FULL_DIMS}  scale ${RETRY_SCALE}=${RETRY_DIMS}"
  echo "::endgroup::"
  test "$FULL_DIMS" = "$RETRY_DIMS" || {
    echo "::error::simulator-server returned ${RETRY_DIMS} at scale ${RETRY_SCALE} for a ${FULL_DIMS} screen — REFUSED_CAPTURE_RETRY_SCALE would now silently reduce every recovered capture, re-keying committed snapshot baselines"
    exit 1
  }
fi

echo "::group::gesture-tap"
# Symmetric with the screenshot retry: a successful screenshot already proves the
# device is painted, so a tap race (#391) is unlikely — but a non-JSON or error
# response retries instead of hard-failing on the first attempt.
TAPPED=""
for attempt in 1 2 3; do
  TAP_RESP=$(curl -sS -m 30 -X POST "${BASE_URL}/gesture-tap" \
    -H 'Content-Type: application/json' \
    -d "{\"udid\":\"${DEVICE_ID}\",\"x\":0.5,\"y\":0.5}" || true)
  echo "gesture-tap attempt ${attempt}/3: $TAP_RESP"
  if printf '%s' "$TAP_RESP" | python3 -c "import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(d, dict) and d.get('data', {}).get('tapped') is True else 1)"; then
    TAPPED=1
    break
  fi
  sleep 2
done
echo "::endgroup::"
[ -n "$TAPPED" ] || {
  echo "::error::gesture-tap did not report tapped:true after 3 attempts"
  exit 1
}

echo "✅ smoke OK: booted + screenshot ${SZ}B + tap on ${DEVICE_ID}"
