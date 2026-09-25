#!/usr/bin/env bash
# Phase 7 — Foldable iOS simulator tier (macOS only, opt-in).
#
# Drives a booted iPhone Duo through every posture with the DuoProbe app as
# ground truth: the app logs the exact touch coordinates it receives, so a tap
# that landed on the wrong panel is a failure here, not a silent success. The
# device is injected already booted (E2E_IOS_DUO_UDID); with it unset the tier
# records one skip. DuoProbe (com.swmansion.duoprobe) must be installed on it.
#
# Needs an Xcode with the iPhone Duo device type (27.1 or later) selected.

_duo_present() { # udid
  run_tool list-devices '{}'
  printf '%s' "$RT_JSON" | jq -e --arg u "$1" 'any(.devices[]?; .udid==$u and .foldable==true)' >/dev/null 2>&1
}

# The probe's `probe.touch` label carries the normalized point the app
# received as `n=<x>,<y>`; a tap at the pad centre from `describe` must land
# within 0.02 of it on whichever panel is live.
_probe_touch_close_to() { # udid expected-x expected-y
  local udid="$1" ex="$2" ey="$3"
  run_tool describe "{\"udid\":\"$udid\"}" || return 1
  local n
  n="$(printf '%s' "$RT_JSON" | jq -r '.description' | grep -o 'n=[0-9.]*,[0-9.]*' | head -1)"
  [ -n "$n" ] || return 1
  python3 - "$n" "$ex" "$ey" <<'PY'
import sys
n = sys.argv[1][2:].split(",")
dx = abs(float(n[0]) - float(sys.argv[2])); dy = abs(float(n[1]) - float(sys.argv[3]))
sys.exit(0 if dx < 0.02 and dy < 0.02 else 1)
PY
}

# Tap the centre of `probe.pad` as `describe` frames it, then check the probe
# received the same normalized point. One case per posture.
_tap_pad_case() { # udid case
  local udid="$1" case="$2" frame cx cy
  run_tool describe "{\"udid\":\"$udid\"}"
  frame="$(printf '%s' "$RT_JSON" | jq -r '.description' | grep 'probe.pad' | head -1)"
  cx="$(printf '%s' "$frame" | python3 -c 'import re,sys; m=re.search(r"\(([0-9.]+), ?([0-9.]+), ?([0-9.]+), ?([0-9.]+)\)", sys.stdin.read()); print(round(float(m.group(1))+float(m.group(3))/2, 3) if m else "")')"
  cy="$(printf '%s' "$frame" | python3 -c 'import re,sys; m=re.search(r"\(([0-9.]+), ?([0-9.]+), ?([0-9.]+), ?([0-9.]+)\)", sys.stdin.read()); print(round(float(m.group(2))+float(m.group(4))/2, 3) if m else "")')"
  if [ -z "$cx" ] || [ -z "$cy" ]; then
    fail "$P" describe "$case-pad-frame" "probe.pad not in describe: $(printf '%s' "$frame" | cut -c1-120)"; return 1
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

  # Fold inside a sequence, then a tap on the new panel in the same call.
  assert_field "$P" run-sequence fold-then-tap \
    "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"fold\",\"args\":{\"posture\":\"closed\"}},{\"tool\":\"gesture-tap\",\"args\":{\"x\":0.5,\"y\":0.5}}]}" \
    '.completed' '2'

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
