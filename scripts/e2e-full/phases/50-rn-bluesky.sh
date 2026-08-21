#!/usr/bin/env bash
# Phase 5 — React-Native debugger / profiler / network tier.
#
# The deepest tier: drives the ~20 tools that only do anything against a running
# React-Native app with a live Metro debugger. Target is the real Bluesky app
# (Expo dev-client, Metro :8081, Android package xyz.blueskyweb.app).
#
# Heavily gated — needs (1) the Bluesky checkout, (2) an Android device, and
# (3) the dev-client already built+installed on it. Anything missing → the whole
# tier (or the failing sub-step) records a skip with a reason, so the report
# still accounts for every tool.
#
# Env overrides:
#   E2E_RN_DIR       default ~/dev/bluesky
#   E2E_RN_PKG       default xyz.blueskyweb.app
#   E2E_RN_BUILD     =1 to build the dev-client with `expo run:android` when it
#                    is not installed. Off by default: the build is too heavy to
#                    run unasked, so the tier skips itself instead.
#   E2E_METRO_PORT   default 8081

_metro_ready() { curl -fsS -m 3 "http://127.0.0.1:${1}/status" 2>/dev/null | grep -q 'packager-status:running'; }

run_phase() {
  local P=rn
  local RN_DIR="${E2E_RN_DIR:-$HOME_REAL/dev/bluesky}"
  # HOME is sandboxed; resolve the real bluesky path from the invoking user.
  [ -d "$RN_DIR" ] || RN_DIR="${E2E_RN_DIR:-/home/user/dev/bluesky}"
  local PKG="${E2E_RN_PKG:-xyz.blueskyweb.app}"
  local MPORT="${E2E_METRO_PORT:-8081}"

  # All the RN-only tools, so we can blanket-skip them with one reason if gated.
  local RN_TOOLS="debugger-connect debugger-status debugger-evaluate debugger-log-registry \
    debugger-component-tree debugger-inspect-element debugger-reload-metro \
    view-network-logs view-network-request-details \
    react-profiler-start react-profiler-stop react-profiler-status react-profiler-analyze \
    react-profiler-renders react-profiler-fiber-tree react-profiler-cpu-summary react-profiler-component-source \
    profiler-load profiler-cpu-query profiler-commit-query profiler-stack-query profiler-combined-report \
    native-profiler-start native-profiler-stop native-profiler-analyze"
  _skip_all() { local t; for t in $RN_TOOLS; do skip "$P" "$t" happy-path "$1"; done; }

  if [ ! -d "$RN_DIR" ]; then _skip_all "no RN app at $RN_DIR (set E2E_RN_DIR)"; return 0; fi
  ensure_server || { _skip_all "tool-server unavailable"; return 0; }

  local DEV="${E2E_ANDROID_SERIAL:-}"
  if [ -z "$DEV" ]; then _skip_all "no Android device (set E2E_ANDROID_SERIAL)"; return 0; fi

  # dev-client installed?
  if ! adb -s "$DEV" shell pm list packages 2>/dev/null | grep -q "$PKG"; then
    if [ "${E2E_RN_BUILD:-0}" = "1" ]; then
      log "building Bluesky dev-client (expo run:android) — this is slow"
      ( cd "$RN_DIR" && TOOL_TIMEOUT=0 ANDROID_SERIAL="$DEV" node_modules/.bin/expo run:android --device "$DEV" ) >/dev/null 2>&1 \
        || { _skip_all "dev-client build failed"; return 0; }
    else
      _skip_all "$PKG not installed on $DEV (prebuild it, or set E2E_RN_BUILD=1)"; return 0
    fi
  fi

  # --- start Metro ----------------------------------------------------------
  local STARTED_METRO=0
  if ! _metro_ready "$MPORT"; then
    log "starting Metro in $RN_DIR"
    local expo="$RN_DIR/node_modules/.bin/expo"
    [ -x "$expo" ] || expo="npx --prefix $RN_DIR expo"
    ( cd "$RN_DIR" && exec $expo start --dev-client --port "$MPORT" ) >/tmp/e2e-metro.log 2>&1 &
    export E2E_METRO_PID=$!
    STARTED_METRO=1
    local i
    for i in $(seq 1 45); do _metro_ready "$MPORT" && break; sleep 2; done
  fi
  # Stop only a Metro this phase started. A developer's own Metro on :8081 is
  # not ours to kill, and every early return past this point has to run it or
  # the one we did start outlives the run.
  _rn_stop_metro() {
    if [ "$STARTED_METRO" -ne 1 ]; then
      skip "$P" stop-metro stop "Metro was already running on :$MPORT; left as found"
    elif _metro_ready "$MPORT"; then
      assert_ok "$P" stop-metro stop "{}"
    else
      # We spawned it, but nothing is serving the port, so stop-metro has
      # nothing to find and failing the run on that says nothing true. The pid
      # is still held in E2E_METRO_PID, which 90-cleanup kills.
      skip "$P" stop-metro stop "the Metro this tier started is not serving :$MPORT; pid reaped in cleanup"
    fi
  }
  if _metro_ready "$MPORT"; then
    pass "$P" metro ready
  else
    fail "$P" metro ready "Metro not up on :$MPORT"
    _skip_all "Metro unavailable"; _rn_stop_metro; return 0
  fi

  # --- launch app + connect the debugger -----------------------------------
  assert_true "$P" launch-app launch "{\"udid\":\"$DEV\",\"bundleId\":\"$PKG\"}" '.launched'
  sleep 5  # let the JS runtime register with Metro

  run_tool debugger-connect "{\"device_id\":\"$DEV\",\"port\":$MPORT}"
  if [ "$RT_RC" -ne 0 ]; then
    fail "$P" debugger-connect connect "$(rt_detail 160)"
    _skip_all "debugger-connect failed"; _rn_stop_metro; return 0
  fi
  local LID; LID="$(printf '%s' "$RT_JSON" | jq -r '.logicalDeviceId // empty')"
  pass "$P" debugger-connect connect "logicalDeviceId=${LID:-none}"
  # Keep driving the list-devices id. debugger-connect's own contract: "Pass this
  # SAME id as device_id to every subsequent debugger-* call… The returned
  # logicalDeviceId is informational… you do not switch to it." Forwarding the
  # logical id still resolves for the debugger tools via the alias, but the
  # profiler tools cache their paths under the id they are handed, so a session
  # recorded under one id would be looked up under the other and come back "No
  # profiling data stored".
  local D="\"device_id\":\"$DEV\",\"port\":$MPORT"

  # --- debugger chain -------------------------------------------------------
  # Both of these answer 200 even when the debugger is not connected, so the
  # exit code alone says only that the server replied. debugger-status is the
  # dead-session gate: its `.connected` fails even over a half-closed socket.
  # debugger-log-registry does not gate on socket state, so its `status` only
  # turns "not_connected" when the runtime itself is unreachable ("connected"
  # on a healthy call); the `// "connected"` default below covers the pre-#610
  # shape where that field was absent, so on this base the log-registry line is
  # a no-op that only bites once #610 is in the tree.
  assert_true  "$P" debugger-status status "{$D}" '.connected'
  assert_field "$P" debugger-evaluate eval "{$D,\"expression\":\"1+1\"}" '(.result|tostring)' '2'
  assert_field "$P" debugger-log-registry logs "{$D}" '(.status // "connected")' 'connected'
  assert_ok    "$P" debugger-component-tree tree "{$D}"
  assert_ok    "$P" debugger-inspect-element inspect "{$D,\"x\":0.5,\"y\":0.5}"
  assert_ok    "$P" debugger-reload-metro reload "{$D}"
  sleep 4  # reload drops the runtime; let it re-register

  # --- network: trigger a fetch, then read the logs ------------------------
  run_tool debugger-evaluate "{$D,\"expression\":\"fetch('https://example.com').then(()=>0)\"}" >/dev/null 2>&1
  sleep 2
  assert_ok "$P" view-network-logs netlogs "{$D,\"pageIndex\":\"latest\"}"
  local RID; RID="$(printf '%s' "$RT_JSON" | jq -r '(.requests // .entries // [])[0].requestId // empty' 2>/dev/null)"
  if [ -n "$RID" ]; then
    assert_ok "$P" view-network-request-details netdetails "{$D,\"requestId\":\"$RID\"}"
  else
    skip "$P" view-network-request-details netdetails "no captured request id"
  fi

  # --- react profiler round-trip -------------------------------------------
  run_tool react-profiler-start "{$D}"
  if [ "$RT_RC" -eq 0 ]; then
    pass "$P" react-profiler-start start
    run_tool gesture-tap "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.5}" >/dev/null 2>&1; sleep 1
    run_tool gesture-swipe "{\"udid\":\"$DEV\",\"fromX\":0.5,\"fromY\":0.7,\"toX\":0.5,\"toY\":0.3}" >/dev/null 2>&1; sleep 1
    assert_ok "$P" react-profiler-status  rp-status "{$D}"
    assert_ok "$P" react-profiler-stop    rp-stop   "{$D}"
    assert_ok "$P" react-profiler-analyze rp-analyze "{$D,\"project_root\":\"$RN_DIR\",\"platform\":\"android\"}"
    assert_ok "$P" react-profiler-renders rp-renders "{$D}"
    assert_ok "$P" react-profiler-fiber-tree rp-fiber "{$D}"
    assert_ok "$P" react-profiler-cpu-summary rp-cpu "{$D}"
    # profiler query tools operate on the loaded react session
    assert_ok "$P" profiler-load load-list "{\"mode\":\"list\",\"device_id\":\"$DEV\"}"
    assert_ok "$P" profiler-cpu-query cpu-top "{$D,\"mode\":\"top_functions\",\"top_n\":10}"
    # by_time_range requires time_range_ms; without it the tool throws before it
    # reads any data. The window is the whole performance.now timeline, so the
    # case exercises the query rather than a filter that matches nothing.
    assert_ok "$P" profiler-commit-query commits \
      "{$D,\"mode\":\"by_time_range\",\"time_range_ms\":{\"start\":0,\"end\":99999999}}"
    # component-source needs a component name from the render list — best-effort
    skip "$P" react-profiler-component-source rp-src "needs a specific component name (manual)"
  else
    for t in react-profiler-start react-profiler-status react-profiler-stop react-profiler-analyze \
             react-profiler-renders react-profiler-fiber-tree react-profiler-cpu-summary react-profiler-component-source \
             profiler-load profiler-cpu-query profiler-commit-query; do
      skip "$P" "$t" happy-path "react-profiler-start failed: $(rt_detail 80)"
    done
  fi

  # --- native profiler (Android perfetto) ----------------------------------
  # profiler-stack-query and profiler-combined-report belong here, not in the
  # react block: both read the native trace and throw "No Android trace loaded.
  # Run native-profiler-stop → native-profiler-analyze first." until analyze has
  # run, so calling them earlier fails on every healthy build.
  run_tool native-profiler-start "{\"device_id\":\"$DEV\",\"app_process\":\"$PKG\"}"
  if [ "$RT_RC" -eq 0 ]; then
    pass "$P" native-profiler-start np-start
    run_tool gesture-swipe "{\"udid\":\"$DEV\",\"fromX\":0.5,\"fromY\":0.7,\"toX\":0.5,\"toY\":0.3}" >/dev/null 2>&1; sleep 3
    assert_ok "$P" native-profiler-stop    np-stop   "{\"device_id\":\"$DEV\"}"
    assert_ok "$P" native-profiler-analyze np-analyze "{\"device_id\":\"$DEV\"}"
    assert_ok "$P" profiler-stack-query stacks "{$D,\"mode\":\"thread_breakdown\"}"
    assert_ok "$P" profiler-combined-report combined "{$D}"
    # load_native needs the session_id that `list` mode prints; sessions are
    # stamped YYYYMMDD-HHMMSS. Without one the tool throws before loading, so
    # take the newest and skip rather than fail when list shows none.
    run_tool profiler-load "{\"mode\":\"list\",\"device_id\":\"$DEV\"}"
    local SID; SID="$(printf '%s' "$RT_OUT" | grep -oE '[0-9]{8}-[0-9]{6}' | sort -u | tail -1)"
    if [ -n "$SID" ]; then
      assert_ok "$P" profiler-load load-native "{\"mode\":\"load_native\",\"device_id\":\"$DEV\",\"app_process\":\"$PKG\",\"session_id\":\"$SID\"}"
    else
      skip "$P" profiler-load load-native "no session id in profiler-load list output"
    fi
  else
    skip "$P" native-profiler-start  np-start   "start failed: $(rt_detail 80)"
    skip "$P" native-profiler-stop   np-stop    "native profiler not started"
    skip "$P" native-profiler-analyze np-analyze "native profiler not started"
    skip "$P" profiler-stack-query stacks "native profiler not started"
    skip "$P" profiler-combined-report combined "native profiler not started"
    skip "$P" profiler-load load-native "native profiler not started"
  fi
  skip "$P" native-network-logs happy-path "iOS-only (not applicable on Android)"

  # --- reinstall-app with the built Bluesky apk ----------------------------
  local apk; apk="$(find "$RN_DIR/android/app/build/outputs/apk" -name '*.apk' 2>/dev/null | head -1)"
  if [ -n "$apk" ]; then
    assert_true "$P" reinstall-app reinstall "{\"udid\":\"$DEV\",\"bundleId\":\"$PKG\",\"appPath\":\"$apk\"}" '.reinstalled'
  else
    skip "$P" reinstall-app reinstall "no built apk under android/app/build/outputs/apk"
  fi

  # --- teardown -------------------------------------------------------------
  _rn_stop_metro
}
