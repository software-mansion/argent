#!/usr/bin/env bash
# End-to-end CI smoke test for argent's Vega (Fire TV) tools, built from THIS
# branch's source. Runs INSIDE the vega-virtual-device-host container with the
# VVD already booted and ready — i.e. as the `script:` of
# finloop/vega-virtual-device-action (see .github/workflows/vega-vvd-e2e.yml).
#
# It drives the tools through the tool-server's HTTP API (the same way
# wayland-e2e.yml drives the Android path), so it exercises the real code:
#   - list-devices       → discovers the VVD and its serial
#   - screenshot         → `adb emu screenrecord` (host-side, no native binary)
#   - remote             → `adb shell inputd-cli` button injection
#   - describe           → `adb forward` + on-device automation toolkit
#   - keyboard           → `adb shell inputd-cli send_text`
#   - list-installed-apps / read-device-logs / restart-app / reinstall-app
#                        → the `vega`/`kepler` CLI
#
# There is intentionally no vega-fast-cli probe anymore: the host binary is gone,
# so the arch/glibc question it raised is moot. `remote` working here proves the
# adb/inputd-cli replacement drives the device.
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

# Call a tool over HTTP: post_tool <id> <json-args>. Prints the raw response.
post_tool() {
  curl -fsS -m 60 -X POST "${TOOLS_URL}/tools/$1" \
    -H 'Content-Type: application/json' -d "$2" 2>/dev/null
}

# Dig a dotted field out of a tool response, tolerating the `{data:{…}}` wrapper.
# The JSON is piped on stdin (not passed as argv) so large responses — e.g.
# read-device-logs' full log blob — don't trip "Argument list too long". The
# program goes via `-c` (stdin is the data), with the dotted path as argv[1].
# jget '<json>' path.to.field
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

# PNG non-black check: a black capture decompresses to ~all-zero bytes (~0.000);
# the kepler app is a DARK media UI that renders ~0.01+, so the floor is 0.004
# (matches the action repo's navigation script). Prints WxH + the fraction.
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

# ── Environment ─────────────────────────────────────────────────────────────
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

# ── Start the tool-server (built from this branch) ──────────────────────────
# The container's Node (20.x) is older than 22.12, where `require(esm)` is on by
# default. tool-server compiles to CommonJS but depends on the ESM-only
# `@argent/configuration-core`, so the raw `tsc` dist needs
# `--experimental-require-module` (backported to Node 20.17+) to load it. The
# production esbuild bundle inlines the dep and doesn't need this.
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

# ── adb + install/launch the kepler app ─────────────────────────────────────
group "adb sees the VVD"
adb start-server >/dev/null 2>&1 || true
timeout 60 adb wait-for-device || { echo "ERROR: adb never saw the device"; exit 1; }
adb devices -l
endg

group "Install + launch kepler video app"
VPKG_ABS="$(readlink -f "$KEPLER_VPKG" 2>/dev/null || echo "$KEPLER_VPKG")"
[ -f "$VPKG_ABS" ] || { echo "ERROR: fixture vpkg not found at ${VPKG_ABS}"; exit 1; }
echo "vpkg: ${VPKG_ABS} ($(stat -c%s "$VPKG_ABS" 2>/dev/null || echo '?') bytes)"
# `vega device <sub>` targets the single connected VVD (no -d; see vega-cli.ts).
vega device uninstall-app -a "$APP_ID" >/dev/null 2>&1 || true
vega device install-app -p "$VPKG_ABS" >/tmp/install-app.log 2>&1 || true
if ! grep -qi success /tmp/install-app.log; then
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

# ── Discover the Vega serial via list-devices ───────────────────────────────
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

# ── TEST 1: screenshot (adb emu — arch-agnostic baseline) ───────────────────
group "TEST screenshot"
SHOT_BEFORE="${OUT_DIR}/kepler-before.png"
captured=""
for attempt in 1 2 3 4 5; do
  rm -f "$SHOT_BEFORE"
  resp="$(post_tool screenshot "$(printf '{"udid":"%s","scale":1}' "$SERIAL")")"
  # The HTTP screenshot result is an image artifact: {data:{image:{hostPath,…}}}.
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

# ── TEST 2: remote (adb inputd-cli — the headline) ──────────────────────────
# A path of D-pad presses navigates the kepler UI in one round-trip. Success =
# the tool returns the full press count; failure surfaces the device error
# (e.g. inputd-cli missing / no focused surface).
group "TEST remote (adb inputd-cli)"
REMOTE_ARGS="$(printf '{"udid":"%s","button":["down","right","right","select"]}' "$SERIAL")"
echo "remote args: ${REMOTE_ARGS}"
resp="$(post_tool remote "$REMOTE_ARGS")" || resp=""
count="$(jget "$resp" count)"
echo "response: ${resp:0:300}"
if [ -n "$count" ] && [ "$count" -ge 4 ] 2>/dev/null; then
  echo "OK: remote injected ${count} presses via adb inputd-cli"
else
  fail "remote did not inject the expected presses (count='${count}')"
fi
# Capture the post-navigation screen (best-effort).
resp="$(post_tool screenshot "$(printf '{"udid":"%s","scale":1}' "$SERIAL")")"
src="$(jget "$resp" image.hostPath)"; [ -n "$src" ] || src="$(jget "$resp" path)"
[ -n "$src" ] && [ -f "$src" ] && cp "$src" "${OUT_DIR}/kepler-after.png" 2>/dev/null && echo "saved ${OUT_DIR}/kepler-after.png"
endg

# ── TEST 3: describe (adb forward + on-device automation toolkit) ────────────
# The element tree is the core of the Vega nav loop. The toolkit attaches at app
# launch; retry to ride out a late attach (an empty tree is the relaunch hint).
group "TEST describe"
desc_ok=""
for attempt in 1 2 3 4 5; do
  resp="$(post_tool describe "$(printf '{"udid":"%s"}' "$SERIAL")")" || resp=""
  src="$(jget "$resp" source)"
  desc="$(jget "$resp" description)"
  if [ "$src" = "vega-automation" ] && [ -n "$desc" ]; then desc_ok=1; break; fi
  echo "attempt ${attempt}: describe empty/not ready; retrying..."
  echo "  response: ${resp:0:200}"
  sleep 4
done
if [ -n "$desc_ok" ]; then
  echo "OK: describe returned a vega-automation tree"
else
  fail "describe did not return a non-empty vega-automation tree"
fi
endg

# ── TEST 4: keyboard (adb inputd-cli send_text) ─────────────────────────────
# Smoke: the text path injects via inputd-cli without erroring and reports the
# per-character count. No focused field is needed to exercise the channel.
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

# ── TEST 5: list-installed-apps ─────────────────────────────────────────────
group "TEST list-installed-apps"
listed=""
for attempt in 1 2 3; do
  resp="$(post_tool list-installed-apps "$(printf '{"udid":"%s"}' "$SERIAL")")" || resp=""
  if printf '%s' "$resp" | grep -q "$APP_PKG"; then listed=1; break; fi
  echo "attempt ${attempt}: ${APP_PKG} not listed yet; retrying..."
  sleep 3
done
if [ -n "$listed" ]; then
  echo "OK: list-installed-apps includes ${APP_PKG}"
else
  echo "  response: ${resp:0:300}"
  fail "list-installed-apps did not include ${APP_PKG}"
fi
endg

# ── TEST 6: read-device-logs (vega start-log-stream) ────────────────────────
# Capture a short window; success = a well-formed capture (numeric
# capturedMs/lines) returned without taking the server down (the spawn-error
# guard path in vega-logs.ts).
group "TEST read-device-logs"
resp="$(post_tool read-device-logs "$(printf '{"udid":"%s","durationMs":3000}' "$SERIAL")")" || resp=""
cap="$(jget "$resp" capturedMs)"
nlines="$(jget "$resp" lines)"
echo "response: ${resp:0:200}"
if [ -n "$cap" ] && [ "$cap" -ge 0 ] 2>/dev/null && [ -n "$nlines" ]; then
  echo "OK: read-device-logs captured ${nlines} lines in ${cap}ms"
else
  fail "read-device-logs did not return a well-formed capture (capturedMs='${cap}', lines='${nlines}')"
fi
endg

# ── TEST 7: restart-app (terminate + relaunch) ──────────────────────────────
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

# ── TEST 8: reinstall-app (uninstall + install the .vpkg) ────────────────────
# Runs last: it leaves the app freshly installed (and not running). Uses a longer
# timeout for the install and retries the vega CLI's occasionally-racy handshake.
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

# ── Summary ─────────────────────────────────────────────────────────────────
echo "::group::Summary"
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "PASS: all Vega tool checks passed against the kepler app on the VVD —"
  echo "      list-devices, screenshot, remote, describe, keyboard,"
  echo "      list-installed-apps, read-device-logs, restart-app, reinstall-app."
  endg
  exit 0
fi
echo "FAILED checks:"
for f in "${FAILURES[@]}"; do echo "  - $f"; done
endg
exit 1
