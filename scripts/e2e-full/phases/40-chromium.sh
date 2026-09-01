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
  # #clr is the `keyboard clear` fixture: it carries a marker value and NO
  # placeholder, so chromium `describe` reports that value as the node's label
  # (a placeholder would take precedence and hide it) — which makes "the field
  # is empty" observable from outside the tool. The page focuses it on load, so
  # a reload is all the block needs to restore a focused, non-empty field.
  # #dt, #ro and #rt are the counter-cases, one per refusal an agent must be
  # able to tell apart: a date input passes every editability signal the clear
  # script can read yet keeps its structured value; a readonly input is focused
  # and unclearable, so "tap the field first" is the wrong repair; and #rt is a
  # rich-text editor that restores the text after accepting the delete, which
  # only the post-delete read-back catches.
  cat > "$dir/index.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:auto}
  #c{position:fixed;inset:0;z-index:0}
  #b{position:absolute;left:45%;top:46%;width:10%;height:8%;font-size:20px;z-index:1}
  #i{position:absolute;left:40%;top:60%;width:20%;z-index:1}
  #clr{position:absolute;left:40%;top:68%;width:20%;z-index:1}
  #dt{position:absolute;left:40%;top:76%;width:20%;z-index:1}
  #ro{position:absolute;left:40%;top:83%;width:20%;height:5%;z-index:1}
  #rt{position:absolute;left:40%;top:90%;width:20%;height:5%;z-index:1;background:#fff}
</style></head><body>
  <canvas id="c" width="1024" height="768"></canvas>
  <button id="b" onclick="this.textContent='tapped'">Tap me</button>
  <input id="i" placeholder="type here"/>
  <input id="clr" value="argentclearmark"/>
  <input id="dt" type="date" value="2020-01-02"/>
  <input id="ro" value="argentreadonlymark" readonly/>
  <div id="rt" contenteditable="true">argentrichmark</div>
  <div id="scrollpad" style="height:3000px"></div>
  <script>
    const cv = document.getElementById('c'), x = cv.getContext('2d');
    const img = x.createImageData(cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i]=Math.random()*255; d[i+1]=Math.random()*255; d[i+2]=Math.random()*255; d[i+3]=255; }
    x.putImageData(img, 0, 0);
    // The rich-text counter-case: an editor with its own document model accepts
    // execCommand's delete and then restores every character from that model, so
    // a clear that trusts the delete's return value reports success on a field
    // that never emptied. A MutationObserver is the same mechanism CKEditor 5
    // reconciles with, minus the editor.
    const rt = document.getElementById('rt'), rtModel = rt.textContent;
    new MutationObserver(() => { if (rt.textContent !== rtModel) rt.textContent = rtModel; })
      .observe(rt, {childList: true, subtree: true, characterData: true});
    document.getElementById('clr').focus();
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

  # `keyboard clear`. Chromium clears through the DOM rather than key events, so
  # the describe pair around it is what proves the field actually emptied.
  #
  # `open-url` is `Page.navigate`, which resolves on COMMIT rather than on load,
  # and the fixture focuses #clr only after filling a 3.1M-iteration canvas — so
  # every step below waits for the marker to be back in the tree first. Without
  # that wait, a loaded machine lands the clear on <body> and reds the tier on a
  # timing artefact.
  local CLEAR_MARK=argentclearmark
  await_ui "$DEV" "$CLEAR_MARK"
  assert_field "$P" describe clear-baseline "{\"udid\":\"$DEV\"}" \
    "(.description|contains(\"$CLEAR_MARK\"))" 'true'
  # `clearVerified` too, and only this tier can: it is the one structural way to
  # tell the two meanings of `cleared` apart, the tool description tells callers
  # to branch on it, and no tier on any platform asserted it. On Chromium it is
  # added only where the field was read back EMPTY, so a read-back that silently
  # stopped answering would drop it while `cleared` stayed true.
  assert_field "$P" keyboard clear "{\"udid\":\"$DEV\",\"clear\":true}" \
    '(.cleared == true and .clearVerified == true)' 'true'
  # The node must still BE there, holding nothing: asserting only that the marker
  # is gone also passes if #clr dropped out of the tree for an unrelated reason.
  assert_field "$P" describe clear-took-effect "{\"udid\":\"$DEV\"}" \
    "((.description|contains(\"id=\\\"clr\\\"\")) and ((.description|contains(\"$CLEAR_MARK\"))|not))" 'true'
  # A second clear on the now-empty field: Chrome answers `selectAll: false`
  # there, and reading that instead of `delete`'s `true` would turn every clear
  # of an already-empty field into a spurious failure.
  assert_field "$P" keyboard clear-already-empty "{\"udid\":\"$DEV\",\"clear\":true}" \
    '(.cleared == true and .clearVerified == true)' 'true'
  # One action per call, `clear` included — the same guard the android tier
  # exercises for text+key. Matched on the message like the four refusals below:
  # the rule is enforced in `execute` rather than by the schema, so it carries no
  # zod issue path and bare `assert_reject` passes on any non-zero exit.
  assert_reject_matching "$P" keyboard clear-and-text \
    "{\"udid\":\"$DEV\",\"clear\":true,\"text\":\"x\"}" \
    "keyboard takes one of"
  # The four refusals below are all InvalidToolInputErrors, so `assert_reject`
  # alone would pass on "the call failed" for every one of them — and a tap that
  # drifts off its field would silently degrade one into a duplicate of another.
  # Each is matched against a phrase only its own branch produces.
  #
  # With nothing editable focused the clear must 400 rather than delete from
  # whatever the page focuses by default. The background canvas is not
  # focusable, so tapping it moves focus off the input.
  run_tool gesture-tap "{\"udid\":\"$DEV\",\"x\":0.05,\"y\":0.05}" >/dev/null 2>&1
  assert_reject_matching "$P" keyboard clear-unfocused "{\"udid\":\"$DEV\",\"clear\":true}" \
    "nothing editable has keyboard focus"
  # A date input is editable by every signal the script can read, and
  # `execCommand` still cannot empty it. Reporting that as a success is the one
  # outcome the whole design rules out, so it must 400 — and, unlike the case
  # above, with the field correctly focused, under the OTHER code.
  run_tool gesture-tap "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.77}" >/dev/null 2>&1
  assert_reject_matching "$P" keyboard clear-date-input "{\"udid\":\"$DEV\",\"clear\":true}" \
    "date and time inputs"
  # A focused readonly input: the same code, because the repair is again "not
  # this field", never "tap it" — it is already focused.
  run_tool gesture-tap "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.855}" >/dev/null 2>&1
  assert_reject_matching "$P" keyboard clear-readonly "{\"udid\":\"$DEV\",\"clear\":true}" \
    "is \`readonly\`"
  # A rich-text editor that restores its own model: `execCommand` accepts the
  # delete, so only reading the field back afterwards catches it. Without that
  # read-back this call reports success and the next typed value is APPENDED.
  run_tool gesture-tap "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.92}" >/dev/null 2>&1
  # The needle has to be one only the RESTORED branch produces: "after the
  # delete" appears in the reformatted message too, so this case could not tell
  # apart the split it exists to check — a field the page REWROTE (its old value
  # already destroyed) from one that kept it.
  assert_reject_matching "$P" keyboard clear-restored "{\"udid\":\"$DEV\",\"clear\":true}" \
    "the value is the one it held before"
  assert_field "$P" describe clear-restored-intact "{\"udid\":\"$DEV\"}" \
    '(.description|contains("argentrichmark"))' 'true'
  # Replace-a-value, the form the tool description prescribes: one round-trip,
  # and the field ends up holding ONLY the new text.
  run_tool open-url "{\"udid\":\"$DEV\",\"url\":\"http://127.0.0.1:$httpport/index.html\"}" >/dev/null 2>&1
  await_ui "$DEV" "$CLEAR_MARK"
  assert_field "$P" run-sequence keyboard-clear-then-text \
    "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"keyboard\",\"args\":{\"clear\":true}},{\"tool\":\"keyboard\",\"args\":{\"text\":\"replaced\"}}]}" \
    '.completed' '2'
  assert_field "$P" describe clear-then-retype "{\"udid\":\"$DEV\"}" \
    "((.description|contains(\"replaced\")) and ((.description|contains(\"$CLEAR_MARK\"))|not))" 'true'

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
