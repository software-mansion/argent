#!/usr/bin/env bash
# Phase 4 — Chromium / Electron tier (Linux + macOS).
#
# Generates a minimal Electron app, boots it through boot-device
# (electronAppPath), and drives every Chromium/CDP tool. Electron ships as an
# argent optionalDependency, so it's present after a sandbox install that kept
# optional deps (run-e2e installs them when the chromium/rn phases are
# selected). resolveLauncher() prefers <app>/node_modules/.bin/electron, so we
# symlink the bundled binary in. Needs a display (DISPLAY or xvfb) on Linux.

# Locate the electron launcher binary the sandbox install pulled in.
_find_electron() {
  find "$E2E_PREFIX" "$E2E_UNPACKED/.." -path '*/.bin/electron' 2>/dev/null | head -1
}

# Write the minimal Electron app into $E2E_WORK/electron-app and link electron.
# Loads over http://127.0.0.1:$1 (not file://) so localStorage/sessionStorage
# have a real, storable origin — file:// origins are opaque and throw.
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
  # A full-window canvas painted with random noise guarantees a large,
  # incompressible PNG (well above the blank-framebuffer floor), with a button +
  # input at known positions for the interaction tools.
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

  # Display gate (Linux). macOS always has one.
  if [ "$E2E_OS" = "linux" ] && [ -z "${DISPLAY:-}" ] && ! command -v xvfb-run >/dev/null 2>&1; then
    skip "$P" tier all "no DISPLAY and no xvfb-run on Linux"; return 0
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

  # electronArgs: --no-sandbox is required for Electron under many CI/root/Linux
  # setups; disable-gpu keeps rendering deterministic.
  run_tool boot-device "{\"electronAppPath\":\"$appdir\",\"electronPort\":$port,\"electronArgs\":[\"--no-sandbox\",\"--disable-gpu\"]}"
  if [ "$RT_RC" -ne 0 ] || ! printf '%s' "$RT_JSON" | jq -e '.booted==true' >/dev/null 2>&1; then
    fail "$P" boot-device "$(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-180)"
    skip "$P" tier remaining "electron did not boot"; return 0
  fi
  local DEV; DEV="$(printf '%s' "$RT_JSON" | jq -r '.id // .udid // .serial // empty')"
  [ -z "$DEV" ] && DEV="chromium-cdp-$port"
  export E2E_ELECTRON_PID="$(printf '%s' "$RT_JSON" | jq -r '.pid // empty')"
  export E2E_ELECTRON_PORT="$port"
  pass "$P" boot-device "electron $DEV (port $port)"

  # --- discovery ------------------------------------------------------------
  assert_true "$P" list-devices present "{}" "(any(.devices[]?; (.id//.udid//.serial)==\"$DEV\"))"
  if capture_screenshot "$DEV" "$E2E_WORK/chromium-shot.png"; then
    pass "$P" screenshot "shot (${SHOT_SIZE}B)"
  else
    fail "$P" screenshot "size=${SHOT_SIZE:-0} rc=${SHOT_RC:-?}"
  fi
  assert_field "$P" describe describe "{\"udid\":\"$DEV\"}" '(.description|length>0)' 'true'

  # --- interaction ----------------------------------------------------------
  assert_true "$P" gesture-tap tap    "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.5}" '.tapped'
  assert_true "$P" gesture-scroll scroll "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.5,\"deltaY\":0.5}" '.scrolled'
  assert_true "$P" gesture-drag drag   "{\"udid\":\"$DEV\",\"fromX\":0.4,\"fromY\":0.4,\"toX\":0.6,\"toY\":0.6}" '.dragged'
  assert_ok   "$P" keyboard  text     "{\"udid\":\"$DEV\",\"text\":\"hello chromium\"}"
  # navigate within the same http origin so storage tests below keep a storable
  # origin (about:/data: origins are opaque and reject Web Storage).
  assert_true "$P" open-url  url      "{\"udid\":\"$DEV\",\"url\":\"http://127.0.0.1:$httpport/index.html\"}" '.opened'

  # --- tabs -----------------------------------------------------------------
  # `list` always works; new/select/close need a multi-window/tab target, which
  # a single-window Electron app doesn't provide — tolerate "Not supported".
  assert_ok "$P" chromium-tabs list "{\"udid\":\"$DEV\",\"action\":\"list\"}"
  run_tool chromium-tabs "{\"udid\":\"$DEV\",\"action\":\"new\",\"url\":\"about:blank\",\"label\":\"e2e-tab\"}"
  if [ "$RT_RC" -eq 0 ]; then
    pass "$P" chromium-tabs new
    assert_ok "$P" chromium-tabs select "{\"udid\":\"$DEV\",\"action\":\"select\",\"tab\":\"e2e-tab\"}"
    assert_ok "$P" chromium-tabs close  "{\"udid\":\"$DEV\",\"action\":\"close\",\"tab\":\"e2e-tab\"}"
  else
    case "$RT_OUT" in
      *"Not supported"*|*"not supported"*)
        skip "$P" chromium-tabs new "single-window Electron: tab creation not supported"
        skip "$P" chromium-tabs select "no extra tab to select"
        skip "$P" chromium-tabs close "no extra tab to close" ;;
      *) fail "$P" chromium-tabs new "$(printf '%s' "$RT_OUT"|tr '\n' ' '|cut -c1-140)" ;;
    esac
  fi

  # --- cookies --------------------------------------------------------------
  assert_ok "$P" chromium-cookies set   "{\"udid\":\"$DEV\",\"action\":\"set\",\"name\":\"e2e\",\"value\":\"1\",\"url\":\"https://example.com\"}"
  assert_ok "$P" chromium-cookies get   "{\"udid\":\"$DEV\",\"action\":\"get\"}"
  assert_ok "$P" chromium-cookies delete "{\"udid\":\"$DEV\",\"action\":\"delete\",\"name\":\"e2e\",\"url\":\"https://example.com\"}"
  assert_ok "$P" chromium-cookies clear "{\"udid\":\"$DEV\",\"action\":\"clear\"}"

  # --- storage (local + session) -------------------------------------------
  local store
  for store in local session; do
    assert_ok "$P" chromium-storage "set-$store"    "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"set\",\"key\":\"e2e\",\"value\":\"v\"}"
    assert_ok "$P" chromium-storage "get-$store"    "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"get\",\"key\":\"e2e\"}"
    assert_ok "$P" chromium-storage "remove-$store" "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"remove\",\"key\":\"e2e\"}"
    assert_ok "$P" chromium-storage "clear-$store"  "{\"udid\":\"$DEV\",\"store\":\"$store\",\"action\":\"clear\"}"
  done

  # --- teardown: kill the electron we spawned ------------------------------
  if [ -n "${E2E_ELECTRON_PID:-}" ] && kill -0 "$E2E_ELECTRON_PID" 2>/dev/null; then
    kill "$E2E_ELECTRON_PID" 2>/dev/null || true
  else
    # fall back: kill whatever holds the CDP port
    local pid; pid="$(python3 -c "import subprocess,sys
try:
    out=subprocess.check_output(['bash','-lc','ss -ltnp 2>/dev/null | grep :$port || true']).decode()
    import re; m=re.search(r'pid=(\d+)', out); print(m.group(1) if m else '')
except Exception: print('')" 2>/dev/null)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  fi
  [ -n "${E2E_HTTP_PID:-}" ] && kill "$E2E_HTTP_PID" 2>/dev/null || true
  pass "$P" teardown electron-stopped
}
