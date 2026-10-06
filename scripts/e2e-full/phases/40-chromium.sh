#!/usr/bin/env bash
# Phase 4 — Chromium / Electron tier (Linux + macOS).
#
# Generates a minimal Electron app and boots it through boot-device
# (electronAppPath). Electron is an argent optionalDependency, installed by
# run-e2e only when the chromium or rn phase is selected. resolveLauncher()
# prefers <app>/node_modules/.bin/electron, so the bundled binary is symlinked
# in. Needs a display on Linux.

_find_electron() {
  find "$E2E_PREFIX" "$E2E_UNPACKED/.." -path '*/.bin/electron' 2>/dev/null | head -1
}

# Loads over http, not file://, so localStorage/sessionStorage have a storable
# origin — file:// origins are opaque and throw.
_gen_electron_app() { # electron-bin http-port  -> echoes app dir
  local ebin="$1" httpport="$2" dir="$E2E_WORK/electron-app"
  mkdir -p "$dir/node_modules/.bin"
  ln -sf "$ebin" "$dir/node_modules/.bin/electron"
  cat > "$dir/package.json" <<'JSON'
{ "name": "argent-e2e-electron", "version": "0.0.0", "private": true, "main": "main.js" }
JSON
  cat > "$dir/main.js" <<JS
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("disable-gpu");
function createWindow() {
  const win = new BrowserWindow({ width: 1024, height: 768, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.loadURL("http://127.0.0.1:${httpport}/index.html");
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
JS
  # Random noise keeps the PNG large and incompressible, above the screenshot
  # size floor; the button and input sit at known positions for the gestures.
  cat > "$dir/index.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:auto}
  #c{position:fixed;inset:0;z-index:0}
  #b{position:absolute;left:45%;top:46%;width:10%;height:8%;font-size:20px;z-index:1}
  #i{position:absolute;left:40%;top:60%;width:20%;z-index:1}
</style></head><body>
  <canvas id="c" width="1024" height="768"></canvas>
  <button id="b" onclick="this.textContent='tapped'">Tap me</button>
  <input id="i" placeholder="type here"/>
  <div id="scrollpad" style="height:3000px"></div>
  <script>
    const cv = document.getElementById('c'), x = cv.getContext('2d');
    const img = x.createImageData(cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i]=Math.random()*255; d[i+1]=Math.random()*255; d[i+2]=Math.random()*255; d[i+3]=255; }
    x.putImageData(img, 0, 0);
  </script>
</body></html>
HTML
  printf '%s\n' "$dir"
}

run_phase() {
  local P=chromium
  ensure_server || { skip "$P" tier all "tool-server unavailable"; return 0; }

  # Display gate (Linux; macOS always has one). A merely installed xvfb-run does
  # not count — nothing wraps the Electron spawn in it, so run the whole harness
  # under `xvfb-run` instead. A set-but-unreachable DISPLAY (e.g. a session
  # switch left it pointing at a server this process has no cookie for) shows up
  # only as an opaque CDP readiness timeout, hence the probe.
  if [ "$E2E_OS" = "linux" ]; then
    if [ -z "${DISPLAY:-}" ]; then
      skip "$P" tier all "no DISPLAY on Linux (re-run the harness under xvfb-run)"; return 0
    fi
    if command -v xdpyinfo >/dev/null 2>&1; then
      xdpyinfo >/dev/null 2>&1 || { skip "$P" tier all "DISPLAY=$DISPLAY set but not reachable (xdpyinfo failed)"; return 0; }
    elif command -v xset >/dev/null 2>&1; then
      xset -q >/dev/null 2>&1 || { skip "$P" tier all "DISPLAY=$DISPLAY set but not reachable (xset failed)"; return 0; }
    else
      info "no xdpyinfo/xset: DISPLAY=$DISPLAY assumed usable, unverified"
    fi
  fi

  local ebin; ebin="$(_find_electron)"
  if [ -z "$ebin" ] || [ ! -e "$ebin" ]; then
    skip "$P" tier all "electron not installed (run without --skip-install and with chromium selected)"; return 0
  fi

  local httpport; httpport="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  local appdir; appdir="$(_gen_electron_app "$ebin" "$httpport")"
  # Serve the fixture so the renderer has a real http origin (for storage).
  ( cd "$appdir" && exec python3 -m http.server "$httpport" --bind 127.0.0.1 ) >/dev/null 2>&1 &
  export E2E_HTTP_PID=$!
  local port; port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  sleep 1

  # --no-sandbox: Electron's sandbox is unusable under many CI/root Linux setups.
  run_tool boot-device "{\"electronAppPath\":\"$appdir\",\"electronPort\":$port,\"electronArgs\":[\"--no-sandbox\",\"--disable-gpu\"]}"
  if [ "$RT_RC" -ne 0 ] || ! printf '%s' "$RT_JSON" | jq -e '.booted==true' >/dev/null 2>&1; then
    fail "$P" boot-device boot "$(rt_detail 180)"
    skip "$P" tier remaining "electron did not boot"; return 0
  fi
  local DEV; DEV="$(printf '%s' "$RT_JSON" | jq -r '.id // .udid // .serial // empty')"
  [ -z "$DEV" ] && DEV="chromium-cdp-$port"
  export E2E_ELECTRON_PID="$(printf '%s' "$RT_JSON" | jq -r '.pid // empty')"
  export E2E_ELECTRON_PORT="$port"
  pass "$P" boot-device boot "electron $DEV (port $port)"

  assert_true "$P" list-devices present "{}" "(any(.devices[]?; (.id//.udid//.serial)==\"$DEV\"))"
  if capture_screenshot "$DEV" "$E2E_WORK/chromium-shot.png"; then
    pass "$P" screenshot shot "${SHOT_SIZE}B"
  else
    fail "$P" screenshot shot "size=${SHOT_SIZE:-0} rc=${SHOT_RC:-?} (blank framebuffer?)"
  fi
  assert_field "$P" describe describe "{\"udid\":\"$DEV\"}" '(.description|length>0)' 'true'

  assert_true "$P" gesture-tap tap    "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.5}" '.tapped'
  assert_true "$P" gesture-scroll scroll "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.5,\"deltaY\":0.5}" '.scrolled'
  assert_true "$P" gesture-drag drag   "{\"udid\":\"$DEV\",\"fromX\":0.4,\"fromY\":0.4,\"toX\":0.6,\"toY\":0.6}" '.dragged'
  assert_ok   "$P" keyboard  text     "{\"udid\":\"$DEV\",\"text\":\"hello chromium\"}"
  # Stay on the http origin: the storage cases below need a storable one.
  assert_true "$P" open-url  url      "{\"udid\":\"$DEV\",\"url\":\"http://127.0.0.1:$httpport/index.html\"}" '.opened'

  # Electron has no browser-level target creation, so `new` comes back
  # "Not supported"; tolerate that.
  assert_ok "$P" chromium-tabs list "{\"udid\":\"$DEV\",\"action\":\"list\"}"
  run_tool chromium-tabs "{\"udid\":\"$DEV\",\"action\":\"new\",\"url\":\"about:blank\",\"label\":\"e2e-tab\"}"
  if [ "$RT_RC" -eq 0 ]; then
    pass "$P" chromium-tabs new
    assert_ok "$P" chromium-tabs select "{\"udid\":\"$DEV\",\"action\":\"select\",\"tab\":\"e2e-tab\"}"
    assert_ok "$P" chromium-tabs close  "{\"udid\":\"$DEV\",\"action\":\"close\",\"tab\":\"e2e-tab\"}"
  else
    case "$RT_OUT" in
      *"Not supported"*|*"not supported"*)
        skip "$P" chromium-tabs new "single-window Electron: tab creation not supported" ;;
      *) fail "$P" chromium-tabs new "$(rt_detail 140)" ;;
    esac
    skip "$P" chromium-tabs select "no extra tab to select"
    skip "$P" chromium-tabs close "no extra tab to close"
  fi

  assert_ok "$P" chromium-cookies set   "{\"udid\":\"$DEV\",\"action\":\"set\",\"name\":\"e2e\",\"value\":\"1\",\"url\":\"https://example.com\"}"
  assert_ok "$P" chromium-cookies get   "{\"udid\":\"$DEV\",\"action\":\"get\"}"
  assert_ok "$P" chromium-cookies delete "{\"udid\":\"$DEV\",\"action\":\"delete\",\"name\":\"e2e\",\"url\":\"https://example.com\"}"
  assert_ok "$P" chromium-cookies clear "{\"udid\":\"$DEV\",\"action\":\"clear\"}"

  local store
  for store in local session; do
    assert_ok "$P" chromium-storage "set-$store"    "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"set\",\"key\":\"e2e\",\"value\":\"v\"}"
    assert_ok "$P" chromium-storage "get-$store"    "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"get\",\"key\":\"e2e\"}"
    assert_ok "$P" chromium-storage "remove-$store" "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"remove\",\"key\":\"e2e\"}"
    assert_ok "$P" chromium-storage "clear-$store"  "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"clear\"}"
  done

  if [ -n "${E2E_ELECTRON_PID:-}" ] && kill -0 "$E2E_ELECTRON_PID" 2>/dev/null; then
    kill "$E2E_ELECTRON_PID" 2>/dev/null || true
  else
    # Fall back to the CDP port's listener. The port is matched as the whole
    # last field and the pid taken from that same line: ":$port" as a substring
    # also hits ":${port}9", and a stray pid may be another user's process.
    local pid; pid="$(python3 -c "
import re, subprocess
port = '$port'
pid = ''
try:
    out = subprocess.run(['ss', '-ltnp'], capture_output=True, text=True).stdout
    for line in out.splitlines():
        f = line.split()
        if len(f) < 5 or f[3].rsplit(':', 1)[-1] != port:
            continue
        m = re.search(r'pid=(\\d+)', line)
        if m:
            pid = m.group(1)
            break
except Exception:
    pass
print(pid)" 2>/dev/null)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
  [ -n "${E2E_HTTP_PID:-}" ] && kill "$E2E_HTTP_PID" 2>/dev/null || true
  # Electron takes a moment to go down after SIGTERM, and this case is the run's
  # only record that the tier left nothing behind — so poll, don't assert.
  local waited=0
  while [ -n "${E2E_ELECTRON_PID:-}" ] && kill -0 "$E2E_ELECTRON_PID" 2>/dev/null && [ "$waited" -lt 5 ]; do
    sleep 1; waited=$((waited + 1))
  done
  if [ -n "${E2E_ELECTRON_PID:-}" ] && kill -0 "$E2E_ELECTRON_PID" 2>/dev/null; then
    kill -9 "$E2E_ELECTRON_PID" 2>/dev/null || true
    fail "$P" teardown electron-stopped "pid $E2E_ELECTRON_PID survived SIGTERM for ${waited}s"
  else
    pass "$P" teardown electron-stopped
  fi
}
