#!/usr/bin/env bash
# Phase 7 — Foldable iOS simulator tier (macOS only, opt-in).
#
# Drives a booted iPhone Duo through every posture with the DuoProbe app as
# ground truth: the app logs the exact touch coordinates it receives, so a tap
# that landed on the wrong panel is a failure here, not a silent success. The
# device is injected already booted (E2E_IOS_DUO_UDID); with it unset the tier
# records one skip. DuoProbe (com.swmansion.duoprobe) must be installed on it.
# E2E_DUO_HINGE, optional, names a helper that moves the hinge behind argent's
# back (`<helper> <udid> hinge <angle> [from]`), for the out-of-band case.
#
# Needs an Xcode with the iPhone Duo device type (27.1 or later) selected.

_duo_present() { # udid
  run_tool list-devices '{}'
  printf '%s' "$RT_JSON" | jq -e --arg u "$1" 'any(.devices[]?; .udid==$u and .foldable==true)' >/dev/null 2>&1
}

# The probe's `probe.touch` label carries the normalized point the app
# received as `n=<x>,<y>`, in the app's WINDOW space; argent sends the panel's
# native (portrait) space. Unfolded, the UI is landscape on a portrait-native
# panel, so the two differ by a rotation: the probe's `probe.info` label names
# the interface orientation (`orient=`; 1 portrait, 3 landscapeLeft,
# 4 landscapeRight). A tap at the pad centre from `describe` must land within
# 0.02 of its image on whichever panel is live.
_probe_touch_close_to() { # udid expected-x expected-y
  local udid="$1" ex="$2" ey="$3"
  run_tool describe "{\"udid\":\"$udid\"}" || return 1
  local n orient
  n="$(printf '%s' "$RT_JSON" | jq -r '.description' | grep -o 'last=([^)]*n=[0-9.]*,[0-9.]*' | grep -o 'n=[0-9.]*,[0-9.]*' | head -1)"
  orient="$(printf '%s' "$RT_JSON" | jq -r '.description' | grep -o 'orient=[0-9]' | head -1 | cut -d= -f2)"
  [ -n "$n" ] || return 1
  python3 - "$n" "$ex" "$ey" "${orient:-1}" <<'PY'
import sys
n = [float(v) for v in sys.argv[1][2:].split(",")]
x, y, orient = float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
# Native (portrait) point -> window point, per interface orientation.
expected = {4: (1 - y, x), 3: (y, 1 - x)}.get(orient, (x, y))
sys.exit(0 if abs(n[0] - expected[0]) < 0.02 and abs(n[1] - expected[1]) < 0.02 else 1)
PY
}

# The probe counts the taps its pad recognized (`taps=<n>` on `probe.gesture`).
_probe_taps() { # udid
  run_tool describe "{\"udid\":\"$1\"}" || { printf '%s' "-1"; return; }
  printf '%s' "$RT_JSON" | jq -r '.description' | grep -o 'taps=[0-9]*' | head -1 | cut -d= -f2
}

# The centre of `probe.pad` as `describe` frames it, as "<x> <y>"; empty when absent.
_pad_centre() { # udid
  run_tool describe "{\"udid\":\"$1\"}" || return 1
  printf '%s' "$RT_JSON" | jq -r '.description' | grep 'probe.pad' | head -1 | python3 -c 'import re,sys; m=re.search(r"\(([0-9.]+), ?([0-9.]+), ?([0-9.]+), ?([0-9.]+)\)", sys.stdin.read()); print(round(float(m.group(1))+float(m.group(3))/2, 3), round(float(m.group(2))+float(m.group(4))/2, 3)) if m else print("")'
}

# The probe's `probe.touch` label carries the window-space start and end of
# the last touch on the pad (`began=(... n=<x>,<y>)`, `ended=(... n=<x>,<y>)`).
# Run a one-step flow `swipe: { from: { id: probe.pad }, direction: down }` and
# check the finger travelled down the UI: window-space y grew, x held.
_flow_swipe_case() { # udid project-root flow-name case
  local udid="$1" root="$2" flow="$3" case="$4"
  mkdir -p "$root/.argent/flows"
  printf 'steps:\n  - swipe: { from: { id: probe.pad }, direction: down }\n' > "$root/.argent/flows/$flow.yaml"
  run_tool flow-execute "{\"name\":\"$flow\",\"project_root\":\"$root\",\"device\":\"$udid\"}"
  if [ "$RT_RC" -ne 0 ] || ! printf '%s' "$RT_JSON" | jq -e '.ok==true' >/dev/null 2>&1; then
    fail "$P" flow-execute "swipe-down-$case" "$(rt_detail 200)"; return 1
  fi
  sleep 1
  run_tool describe "{\"udid\":\"$udid\"}" || { fail "$P" describe "swipe-down-$case" "$(rt_detail 120)"; return 1; }
  local began ended
  began="$(printf '%s' "$RT_JSON" | jq -r '.description' | grep -o 'began=([^)]*n=[0-9.]*,[0-9.]*' | grep -o 'n=[0-9.]*,[0-9.]*' | head -1)"
  ended="$(printf '%s' "$RT_JSON" | jq -r '.description' | grep -o 'ended=([^)]*n=[0-9.]*,[0-9.]*' | grep -o 'n=[0-9.]*,[0-9.]*' | head -1)"
  if [ -z "$began" ] || [ -z "$ended" ]; then
    fail "$P" flow-execute "swipe-down-$case" "probe reported no swipe: $(rt_detail 120)"; return 1
  fi
  if python3 - "$began" "$ended" <<'PY'
import sys
b = [float(v) for v in sys.argv[1][2:].split(",")]
e = [float(v) for v in sys.argv[2][2:].split(",")]
sys.exit(0 if e[1] - b[1] > 0.2 and abs(e[0] - b[0]) < 0.05 else 1)
PY
  then
    pass "$P" flow-execute "swipe-down-$case" "window-space $began -> $ended"
  else
    fail "$P" flow-execute "swipe-down-$case" "the finger did not travel down the UI: $began -> $ended"
  fi
}

# Tap the centre of `probe.pad` as `describe` frames it, then check the probe
# received that point. One case per posture.
_tap_pad_case() { # udid case
  local udid="$1" case="$2" centre cx cy
  centre="$(_pad_centre "$udid")"
  cx="${centre%% *}"; cy="${centre##* }"
  if [ -z "$cx" ] || [ -z "$cy" ]; then
    fail "$P" describe "$case-pad-frame" "probe.pad not in describe: $(rt_detail 120)"; return 1
  fi
  run_tool gesture-tap "{\"udid\":\"$udid\",\"x\":$cx,\"y\":$cy}"
  if [ "$RT_RC" -ne 0 ]; then fail "$P" gesture-tap "$case" "$(rt_detail 160)"; return 1; fi
  sleep 1
  if _probe_touch_close_to "$udid" "$cx" "$cy"; then
    pass "$P" gesture-tap "$case" "probe received ($cx,$cy)"
  else
    fail "$P" gesture-tap "$case" "probe did not receive ($cx,$cy) — tap went to the wrong panel?"
  fi
}

run_phase() {
  local P=ios-duo
  [ "$E2E_OS" = darwin ] || { skip "$P" tier all "macOS only"; return 0; }
  ensure_server || { skip "$P" tier all "tool-server unavailable"; return 0; }

  local DEV="${E2E_IOS_DUO_UDID:-}"
  if [ -z "$DEV" ]; then
    skip "$P" tier all "no foldable simulator (set E2E_IOS_DUO_UDID to a booted iPhone Duo)"; return 0
  fi
  if _duo_present "$DEV"; then
    pass "$P" list-devices foldable "udid $DEV is listed foldable"
  else
    skip "$P" tier all "udid $DEV is not a booted foldable simulator in list-devices"; return 0
  fi
  local U="{\"udid\":\"$DEV\"}"
  local APP="com.swmansion.duoprobe"

  # Start closed, whatever posture the device was left in.
  assert_field "$P" fold closed "{\"udid\":\"$DEV\",\"posture\":\"closed\"}" '.activeScreen' '1'
  assert_true "$P" restart-app launch "{\"udid\":\"$DEV\",\"bundleId\":\"$APP\"}" '.restarted'
  assert_ok "$P" await-ui-element pad-visible "{\"udid\":\"$DEV\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"probe.pad\"},\"timeoutMs\":8000}"

  # Closed: the cover panel.
  if capture_screenshot "$DEV" "$E2E_WORK/duo-closed.png"; then
    pass "$P" screenshot closed "${SHOT_SIZE}B"
  else
    fail "$P" screenshot closed "size=${SHOT_SIZE:-0} rc=${SHOT_RC:-?}"
  fi
  _tap_pad_case "$DEV" closed

  # Open: the inner panel, larger capture, taps still land.
  assert_field "$P" fold open "{\"udid\":\"$DEV\",\"posture\":\"open\"}" '.activeScreen' '3'
  assert_field "$P" list-devices active-screen '{}' \
    "first(.devices[]? | select(.udid==\"$DEV\")) | .activeScreen" '3'
  if capture_screenshot "$DEV" "$E2E_WORK/duo-open.png"; then
    pass "$P" screenshot open "${SHOT_SIZE}B"
  else
    fail "$P" screenshot open "size=${SHOT_SIZE:-0} rc=${SHOT_RC:-?}"
  fi
  _tap_pad_case "$DEV" open
  # The two panels differ in size: a diff across the fold is a posture
  # mismatch, and the summary must say so.
  if [ -f "$E2E_WORK/duo-closed.png" ] && [ -f "$E2E_WORK/duo-open.png" ]; then
    run_tool screenshot-diff "{\"udid\":\"$DEV\",\"baselinePath\":\"$E2E_WORK/duo-closed.png\",\"currentPath\":\"$E2E_WORK/duo-open.png\"}"
    if [ "$RT_RC" -eq 0 ] && printf '%s' "$RT_JSON" | jq -e '.summary | test("posture")' >/dev/null 2>&1; then
      pass "$P" screenshot-diff posture-wording
    else
      fail "$P" screenshot-diff posture-wording "$(rt_detail 200)"
    fi
  fi

  # Half-open: still the inner panel.
  assert_field "$P" fold half-open "{\"udid\":\"$DEV\",\"posture\":\"half-open\"}" '.activeScreen' '3'
  _tap_pad_case "$DEV" half-open

  # A sweep between two angles short of closed and open does not make the
  # guest switch panels (75° -> 90° stays on the cover panel). The tool must
  # report the panel the device kept rather than time out, and the tap after
  # it must land on that panel.
  assert_field "$P" fold closed-before-short-sweep "{\"udid\":\"$DEV\",\"posture\":\"closed\"}" '.activeScreen' '1'
  assert_field "$P" fold angle-75 "{\"udid\":\"$DEV\",\"angle\":75}" '.activeScreen' '1'
  assert_ok "$P" fold short-sweep-75-to-90 "{\"udid\":\"$DEV\",\"angle\":90}"
  _tap_pad_case "$DEV" short-sweep-75-to-90
  # From closed to just past the cover panel's range the guest shows the inner
  # panel for about a second and returns to the cover. The tool must not latch
  # that transient: it answers the cover panel, and the tap after it lands.
  assert_field "$P" fold closed-before-transient "{\"udid\":\"$DEV\",\"posture\":\"closed\"}" '.activeScreen' '1'
  assert_field "$P" fold transient-78 "{\"udid\":\"$DEV\",\"angle\":78}" '.activeScreen' '1'
  _tap_pad_case "$DEV" transient-78

  # Flow directions are the UI's. Unfolded, the UI is landscape on the
  # portrait-native inner panel, so a `swipe: down` anchored on the pad must
  # travel down the UI (window-space +y), not along the panel's own y.
  _flow_swipe_case "$DEV" "$E2E_WORK/duo-flows" pad-down open
  assert_field "$P" fold closed-for-flow "{\"udid\":\"$DEV\",\"posture\":\"closed\"}" '.activeScreen' '1'
  _flow_swipe_case "$DEV" "$E2E_WORK/duo-flows" pad-down closed
  assert_field "$P" fold half-open-again "{\"udid\":\"$DEV\",\"posture\":\"half-open\"}" '.activeScreen' '3'

  # A recording across a fold: one file, and the switch counted.
  run_tool screen-recording-start "{\"udid\":\"$DEV\",\"timeLimitSeconds\":30,\"trimStatic\":false}"
  if [ "$RT_RC" -eq 0 ]; then
    run_tool fold "{\"udid\":\"$DEV\",\"posture\":\"closed\"}"
    sleep 2
    run_tool fold "{\"udid\":\"$DEV\",\"posture\":\"open\"}"
    sleep 2
    run_tool screen-recording-stop "$U"
    if [ "$RT_RC" -eq 0 ] && printf '%s' "$RT_JSON" | jq -e '(.panelSwitches // 0) >= 2' >/dev/null 2>&1; then
      pass "$P" screen-recording follows-fold "$(printf '%s' "$RT_JSON" | jq -c '{panelSwitches,durationMs}')"
    else
      fail "$P" screen-recording follows-fold "$(rt_detail 200)"
    fi
  else
    fail "$P" screen-recording-start start "$(rt_detail 160)"
  fi

  # Fold inside a sequence, then a tap on the new panel in the same call, with
  # the default inter-step delay. The sequence completing proves nothing: a tap
  # sent before the guest takes input on the new panel is acknowledged and
  # dropped. The probe's tap counter is what has to move — in both directions.
  local taps_before taps_after centre
  centre="$(_pad_centre "$DEV")"  # half-open: the inner panel's pad
  taps_before="$(_probe_taps "$DEV")"
  run_tool run-sequence "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"fold\",\"args\":{\"posture\":\"closed\"}},{\"tool\":\"gesture-tap\",\"args\":{\"x\":0.41,\"y\":0.53}}]}"
  if [ "$RT_RC" -ne 0 ] || ! printf '%s' "$RT_JSON" | jq -e '.completed==2' >/dev/null 2>&1; then
    fail "$P" run-sequence fold-closed-then-tap "$(rt_detail 200)"
  else
    sleep 1
    taps_after="$(_probe_taps "$DEV")"
    if [ "$taps_after" -gt "$taps_before" ] 2>/dev/null; then
      pass "$P" run-sequence fold-closed-then-tap "taps $taps_before -> $taps_after"
    else
      fail "$P" run-sequence fold-closed-then-tap "the tap after the fold was dropped (taps $taps_before -> $taps_after)"
    fi
  fi
  taps_before="$(_probe_taps "$DEV")"
  run_tool run-sequence "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"fold\",\"args\":{\"posture\":\"open\"}},{\"tool\":\"gesture-tap\",\"args\":{\"x\":${centre%% *},\"y\":${centre##* }}}]}"
  if [ "$RT_RC" -ne 0 ] || ! printf '%s' "$RT_JSON" | jq -e '.completed==2' >/dev/null 2>&1; then
    fail "$P" run-sequence fold-open-then-tap "$(rt_detail 200)"
  else
    sleep 1
    taps_after="$(_probe_taps "$DEV")"
    if [ "$taps_after" -gt "$taps_before" ] 2>/dev/null; then
      pass "$P" run-sequence fold-open-then-tap "taps $taps_before -> $taps_after"
    else
      fail "$P" run-sequence fold-open-then-tap "the tap after the fold was dropped (taps $taps_before -> $taps_after)"
    fi
  fi

  # A fold made outside argent leaves the hinge where the server did not put
  # it. The next fold must still end on the right panel, with no `from`, and the
  # tap after it must land. The helper moves the hinge the way Device Hub does.
  local HINGE="${E2E_DUO_HINGE:-}"
  if [ -n "$HINGE" ] && [ -x "$HINGE" ]; then
    "$HINGE" "$DEV" hinge 0 180 >/dev/null 2>&1; sleep 2   # closed, behind argent's back
    taps_before="$(_probe_taps "$DEV")"
    run_tool run-sequence "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"fold\",\"args\":{\"posture\":\"closed\"}},{\"tool\":\"gesture-tap\",\"args\":{\"x\":0.41,\"y\":0.53}}]}"
    sleep 1
    taps_after="$(_probe_taps "$DEV")"
    if [ "$RT_RC" -eq 0 ] && printf '%s' "$RT_JSON" | jq -e '.steps[0].result.activeScreen==1' >/dev/null 2>&1 && [ "$taps_after" -gt "$taps_before" ] 2>/dev/null; then
      pass "$P" fold after-external-fold "closed -> screen 1, taps $taps_before -> $taps_after"
    else
      fail "$P" fold after-external-fold "$(rt_detail 200) taps $taps_before -> $taps_after"
    fi
  else
    skip "$P" fold after-external-fold "set E2E_DUO_HINGE to a hinge helper (duo-hinge) to fold behind argent's back"
  fi

  # Back where the tier started, and the app survived every fold.
  assert_field "$P" fold closed-again "{\"udid\":\"$DEV\",\"posture\":\"closed\"}" '.activeScreen' '1'
  assert_ok "$P" await-ui-element pad-still-there "{\"udid\":\"$DEV\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"probe.pad\"},\"timeoutMs\":8000}"

  # A fold is refused on a device that is not foldable, with the server's reason.
  if [ -n "${E2E_IOS_FLAT_UDID:-}" ]; then
    run_tool fold "{\"udid\":\"$E2E_IOS_FLAT_UDID\",\"posture\":\"open\"}"
    if [ "$RT_RC" -ne 0 ] && printf '%s' "$RT_OUT" | grep -qi "foldable"; then
      pass "$P" fold rejected-on-flat
    else
      fail "$P" fold rejected-on-flat "$(rt_detail 160)"
    fi
  else
    skip "$P" fold rejected-on-flat "set E2E_IOS_FLAT_UDID to a booted non-foldable iOS simulator"
  fi

  run_tool stop-all-simulator-servers "{\"devices\":[\"$DEV\"${E2E_IOS_FLAT_UDID:+,\"$E2E_IOS_FLAT_UDID\"}]}" >/dev/null 2>&1 || true
  return 0
}
