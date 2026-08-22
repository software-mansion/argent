#!/usr/bin/env bash
# End-to-end CI smoke test for argent's Vega (Fire TV) tools, built from THIS
# branch's source. Runs as the `script:` of finloop/vega-virtual-device-action,
# inside its container with the VVD already booted
# (.github/workflows/vega-vvd-e2e.yml).
#
# Drives the tools through the tool-server's HTTP API, so it exercises the real
# code:
#   - list-devices       → discovers the VVD and its serial
#   - screenshot         → `adb emu screenrecord` (PNG written host-side)
#   - tv-remote          → `adb shell inputd-cli` button injection
#   - describe           → `adb forward` + on-device automation toolkit
#   - keyboard           → `adb shell inputd-cli send_text`
#   - restart-app / reinstall-app
#                        → the `vega`/`kepler` CLI
#
# Prereq: the workspace is already built (`npm ci` + `tsc --build` on the runner,
# bind-mounted in at /workspace), so `packages/tool-server/dist/index.js` exists.
#
# NOT `set -e`: gated checks are captured for a per-tool summary, then we exit
# non-zero if any failed.
set -uo pipefail

PORT="${ARGENT_PORT:-3033}"
OUT_DIR="${OUT_DIR:-artifacts}"
mkdir -p "$OUT_DIR"
KEPLER_VPKG="${KEPLER_VPKG:-fixtures/keplervideoapp_aarch64.vpkg}"
APP_PKG="${APP_PKG:-com.amazondeveloper.keplervideoapp}"
APP_ID="${APP_ID:-${APP_PKG}.main}"
TOOLS_URL="http://127.0.0.1:${PORT}"

# /tmp is lost when the container exits; copy logs into the uploaded artifact dir.
# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
copy_logs() { cp /tmp/tool-server.log /tmp/*-app.log "$OUT_DIR/" 2>/dev/null || true; }
trap copy_logs EXIT

FAILURES=()
fail() { echo "FAIL: $*"; FAILURES+=("$*"); }
group() { echo "::group::$*"; }
endg() { echo "::endgroup::"; }

# post_tool <id> <json-args> — prints the raw response.
post_tool() {
  curl -fsS -m 60 -X POST "${TOOLS_URL}/tools/$1" \
    -H 'Content-Type: application/json' -d "$2" 2>/dev/null
}

# jget <json> path.to.field — dotted lookup, tolerating the `{data:{…}}` wrapper.
# The JSON is piped on stdin, not passed as argv, so large responses don't trip
# "Argument list too long".
jget() {
  printf '%s' "$1" | python3 -c '
import sys, json
try:
    obj = json.load(sys.stdin)
except Exception:
    sys.exit(0)
node = obj.get("data", obj) if isinstance(obj, dict) else obj
for key in sys.argv[1].split("."):
    if isinstance(node, dict) and key in node:
        node = node[key]
    else:
        sys.exit(0)
print(node if not isinstance(node, (dict, list)) else json.dumps(node))
' "$2"
}

# PNG non-black check: a black capture decompresses to ~all-zero bytes; the dark
# kepler media UI renders ~0.01+, so the floor sits at 0.004.
NONBLACK_MIN_FRAC="${NONBLACK_MIN_FRAC:-0.004}"
nonblack() {
  python3 - "$1" "$NONBLACK_MIN_FRAC" <<'PY'
import sys, zlib, struct
try:
    d = open(sys.argv[1], "rb").read()
except OSError:
    sys.exit(1)
if d[:8] != b"\x89PNG\r\n\x1a\n":
    sys.exit(1)
i, idat, w, h = 8, bytearray(), 0, 0
while i + 8 <= len(d):
    ln = struct.unpack(">I", d[i:i + 4])[0]; t = d[i + 4:i + 8]
    if t == b"IHDR": w, h = struct.unpack(">II", d[i + 8:i + 16])
    if t == b"IDAT": idat += d[i + 8:i + 8 + ln]
    i += 12 + ln
    if t == b"IEND": break
raw = zlib.decompress(bytes(idat))
frac = (len(raw) - raw.count(0)) / len(raw) if raw else 0.0
sys.stderr.write(f"{w}x{h} nonblack_frac={frac:.4f}\n")
sys.exit(0 if frac > float(sys.argv[2]) else 1)
PY
}

group "Environment"
echo "node $(node -v 2>/dev/null || echo '<none>')"
adb version 2>/dev/null | head -1 || echo "adb <none>"
echo "vega $(vega -v 2>/dev/null | tr '\n' ' ' || echo '<none>')"
if test -f packages/tool-server/dist/index.js; then
  echo "tool-server dist: present"
else
  echo "ERROR: packages/tool-server/dist/index.js missing — build the workspace first"; exit 1
fi
endg

# The CommonJS `tsc` dist requires the ESM-only `@argent/configuration-core`, so
# on the container's Node 20 it needs `--experimental-require-module`; that flag
# is implicit only from Node 22.12. The production esbuild bundle inlines the dep
# and doesn't need it.
group "Start tool-server"
: > /tmp/tool-server.log
setsid env ARGENT_PORT="$PORT" node --experimental-require-module packages/tool-server/dist/index.js start \
  </dev/null >/tmp/tool-server.log 2>&1 &
ready=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "${TOOLS_URL}/tools" 2>/dev/null; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then echo "ERROR: tool-server not ready"; cat /tmp/tool-server.log; exit 1; fi
echo "tool-server up at ${TOOLS_URL}"
endg

group "adb sees the VVD"
adb start-server >/dev/null 2>&1 || true
timeout 60 adb wait-for-device || { echo "ERROR: adb never saw the device"; exit 1; }
adb devices -l
endg

group "Install + launch kepler video app"
VPKG_ABS="$(readlink -f "$KEPLER_VPKG" 2>/dev/null || echo "$KEPLER_VPKG")"
[ -f "$VPKG_ABS" ] || { echo "ERROR: fixture vpkg not found at ${VPKG_ABS}"; exit 1; }
echo "vpkg: ${VPKG_ABS} ($(stat -c%s "$VPKG_ABS" 2>/dev/null || echo '?') bytes)"
# adb seeing the device isn't enough: the Vega device agent attaches a beat after
# adb, so an early `vega device install-app` hits "No connected Vega devices".
# Wait for `vega virtual-device status` running:true, then retry the install to
# ride out a late attach.
for attempt in $(seq 1 30); do
  if vega virtual-device status 2>/dev/null | grep -qE '"running"[[:space:]]*:[[:space:]]*true'; then
    echo "VVD reports running"; break
  fi
  echo "attempt ${attempt}: vega virtual-device status not running yet; waiting..."
  sleep 2
done
vega device uninstall-app -a "$APP_ID" >/dev/null 2>&1 || true
install_ok=""
for attempt in $(seq 1 10); do
  vega device install-app -p "$VPKG_ABS" >/tmp/install-app.log 2>&1 || true
  if grep -qi success /tmp/install-app.log; then install_ok=1; echo "install-app succeeded"; break; fi
  echo "attempt ${attempt}: install-app not ready; retrying..."
  sleep 3
done
if [ -z "$install_ok" ]; then
  echo "ERROR: vega install-app did not report success"; cat /tmp/install-app.log; exit 1
fi
vega device launch-app -a "$APP_ID" >/tmp/launch-app.log 2>&1 || true
tail -3 /tmp/launch-app.log 2>/dev/null || true
running=""
for attempt in $(seq 1 30); do
  apps="$(vega device running-apps 2>/dev/null || true)"
  if [[ "$apps" == *"$APP_PKG"* ]]; then running=1; echo "app ${APP_ID} is running"; break; fi
  echo "attempt ${attempt}: ${APP_ID} not running yet; retrying..."
  sleep 2
done
[ -z "$running" ] && echo "WARNING: ${APP_ID} not in running-apps; continuing anyway"
sleep 10
endg

group "Discover Vega device"
SERIAL=""
for attempt in $(seq 1 12); do
  resp="$(post_tool list-devices '{}')"
  SERIAL="$(python3 - "$resp" <<'PY'
import sys, json
try:
    o = json.loads(sys.argv[1]); o = o.get("data", o)
    print(next((d.get("serial") or d.get("udid") or d.get("id")
                for d in o.get("devices", []) if d.get("platform") == "vega"), ""))
except Exception:
    pass
PY
)"
  [ -n "$SERIAL" ] && break
  echo "attempt ${attempt}: no Vega device yet; retrying..."
  sleep 5
done
[ -z "$SERIAL" ] && { echo "ERROR: no Vega device from list-devices"; post_tool list-devices '{}'; exit 1; }
echo "Vega serial: ${SERIAL}"
endg

# The bootstrap `vega device launch-app` above does NOT set the toolkit-enable
# flag, which is read only at app launch, so describe would return an empty tree.
# argent's restart-app asserts the flag, then terminate+launches.
group "Relaunch via argent (attach automation toolkit)"
resp="$(post_tool restart-app "$(printf '{"udid":"%s","bundleId":"%s"}' "$SERIAL" "$APP_ID")")" || resp=""
echo "  restart-app response: ${resp:0:200}"
sleep 10
endg

group "TEST screenshot"
SHOT_BEFORE="${OUT_DIR}/kepler-before.png"
captured=""
for attempt in 1 2 3 4 5; do
  rm -f "$SHOT_BEFORE"
  resp="$(post_tool screenshot "$(printf '{"udid":"%s","scale":1}' "$SERIAL")")"
  # The screenshot result is an image artifact: {data:{image:{hostPath,…}}}.
  src="$(jget "$resp" image.hostPath)"; [ -n "$src" ] || src="$(jget "$resp" path)"
  [ -n "$src" ] && [ -f "$src" ] && cp "$src" "$SHOT_BEFORE" 2>/dev/null
  if nonblack "$SHOT_BEFORE"; then captured=1; break; fi
  echo "attempt ${attempt}: screenshot missing/black; retrying..."
  echo "  response: ${resp:0:200}"
  sleep 5
done
if [ -n "$captured" ]; then
  echo "OK: screenshot is non-black -> ${SHOT_BEFORE}"
else
  fail "screenshot did not return a non-black image"
fi
endg

# The whole D-pad path is injected in one adb round-trip.
group "TEST tv-remote (adb inputd-cli)"
REMOTE_ARGS="$(printf '{"udid":"%s","button":["down","right","right","select"]}' "$SERIAL")"
echo "tv-remote args: ${REMOTE_ARGS}"
resp="$(post_tool tv-remote "$REMOTE_ARGS")" || resp=""
count="$(jget "$resp" count)"
echo "response: ${resp:0:300}"
if [ -n "$count" ] && [ "$count" -ge 4 ] 2>/dev/null; then
  echo "OK: tv-remote injected ${count} presses via adb inputd-cli"
else
  fail "tv-remote did not inject the expected presses (count='${count}')"
fi
# Post-navigation screen; best-effort, not gated.
resp="$(post_tool screenshot "$(printf '{"udid":"%s","scale":1}' "$SERIAL")")"
src="$(jget "$resp" image.hostPath)"; [ -n "$src" ] || src="$(jget "$resp" path)"
[ -n "$src" ] && [ -f "$src" ] && cp "$src" "${OUT_DIR}/kepler-after.png" 2>/dev/null && echo "saved ${OUT_DIR}/kepler-after.png"
endg

# The toolkit attaches only at app launch, so an empty tree is retried with a
# relaunch to ride out a late attach.
group "TEST describe"
desc_ok=""
for attempt in 1 2 3 4 5; do
  resp="$(post_tool describe "$(printf '{"udid":"%s"}' "$SERIAL")")" || resp=""
  src="$(jget "$resp" source)"
  desc="$(jget "$resp" description)"
  # An unreachable toolkit still returns source:"vega-automation" and a non-empty
  # description (format-tree always emits the Source/Mode/ROOT header + hint), so
  # only element lines beyond the ROOT header prove a real tree.
  elems="$(printf '%s\n' "$desc" | awk '/^ROOT /{seen=1; next} seen && NF {c++} END{print c+0}')"
  if [ "$src" = "vega-automation" ] && [ "${elems:-0}" -ge 1 ] 2>/dev/null; then desc_ok=1; break; fi
  echo "attempt ${attempt}: describe empty/not ready (element lines beyond header: ${elems:-0}); relaunch + retry..."
  echo "  response: ${resp:0:200}"
  post_tool restart-app "$(printf '{"udid":"%s","bundleId":"%s"}' "$SERIAL" "$APP_ID")" >/dev/null 2>&1 || true
  sleep 4
done
if [ -n "$desc_ok" ]; then
  echo "OK: describe returned a vega-automation tree with ${elems} element line(s) beyond the header"
else
  fail "describe did not return a tree with element content beyond the header"
fi
endg

# No focused field is needed: this only checks that the send_text channel accepts
# the text.
group "TEST keyboard"
resp="$(post_tool keyboard "$(printf '{"udid":"%s","text":"argent"}' "$SERIAL")")" || resp=""
keys="$(jget "$resp" keys)"
echo "response: ${resp:0:200}"
if [ -n "$keys" ] && [ "$keys" -ge 1 ] 2>/dev/null; then
  echo "OK: keyboard injected ${keys} chars via inputd-cli"
else
  fail "keyboard did not report injected keys (keys='${keys}')"
fi
endg

group "TEST restart-app"
restarted=""
for attempt in 1 2 3; do
  resp="$(post_tool restart-app "$(printf '{"udid":"%s","bundleId":"%s"}' "$SERIAL" "$APP_ID")")" || resp=""
  if printf '%s' "$resp" | grep -qiE '"restarted"[[:space:]]*:[[:space:]]*true'; then restarted=1; break; fi
  echo "attempt ${attempt}: restart not confirmed; retrying..."
  echo "  response: ${resp:0:200}"
  sleep 4
done
if [ -n "$restarted" ]; then
  echo "OK: restart-app relaunched ${APP_ID}"
else
  fail "restart-app did not report success for ${APP_ID}"
fi
sleep 5
endg

# Runs last: it leaves the app freshly installed and not running.
group "TEST reinstall-app"
reinstalled=""
for attempt in 1 2 3; do
  resp="$(curl -fsS -m 180 -X POST "${TOOLS_URL}/tools/reinstall-app" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"udid":"%s","bundleId":"%s","appPath":"%s"}' "$SERIAL" "$APP_ID" "$VPKG_ABS")" 2>/dev/null)" || resp=""
  if printf '%s' "$resp" | grep -qiE '"reinstalled"[[:space:]]*:[[:space:]]*true'; then reinstalled=1; break; fi
  echo "attempt ${attempt}: reinstall not confirmed; retrying..."
  echo "  response: ${resp:0:300}"
  sleep 5
done
if [ -n "$reinstalled" ]; then
  echo "OK: reinstall-app reinstalled ${APP_ID} from the vpkg"
else
  fail "reinstall-app did not report success for ${APP_ID}"
fi
endg

echo "::group::Summary"
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: all Vega tool checks passed against the kepler app on the VVD —"
  echo "      list-devices, screenshot, tv-remote, describe, keyboard,"
  echo "      restart-app, reinstall-app."
  endg
  exit 0
fi
echo "FAILED checks:"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
endg
exit 1
