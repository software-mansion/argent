#!/usr/bin/env bash
# Phase 3 — Android device tier (Linux + macOS).
#
# Happy-path over every tool that applies to an Android device. The device is
# either injected already booted (E2E_ANDROID_SERIAL) or booted here from
# E2E_ANDROID_AVD; with neither, the tier records one skip with the reason.

_android_present() { # serial
  run_tool list-devices '{}'
  printf '%s' "$RT_JSON" | jq -e --arg s "$1" 'any(.devices[]?; .serial==$s or .udid==$s)' >/dev/null 2>&1
}

# Screenshot recorded as a pass/fail case; SHOT_PATH holds the file.
_shot_ok() { # phase udid case
  local phase="$1" udid="$2" case="$3"
  if capture_screenshot "$udid" "$E2E_WORK/android-$case.png"; then
    pass "$phase" screenshot "$case" "${SHOT_SIZE}B"; return 0
  else
    fail "$phase" screenshot "$case" "size=${SHOT_SIZE:-0} rc=${SHOT_RC:-?} (blank framebuffer?)"; return 1
  fi
}

run_phase() {
  local P=android
  ensure_server || { skip "$P" tier all "tool-server unavailable"; return 0; }

  local DEV="" BOOTED_HERE=0
  if [ -n "${E2E_ANDROID_SERIAL:-}" ]; then
    DEV="$E2E_ANDROID_SERIAL"
    if _android_present "$DEV"; then
      pass "$P" list-devices present "injected serial $DEV"
    else
      skip "$P" tier all "injected serial $DEV not visible to tool-server"; return 0
    fi
  elif [ -n "${E2E_ANDROID_AVD:-}" ]; then
    log "booting AVD $E2E_ANDROID_AVD"
    # run_tool caps every call at TOOL_TIMEOUT (120s by default), which would
    # kill the CLI long before an 840s AVD boot the tool-server keeps running
    # unattended — so `--android-avd` could never succeed. Give the call a
    # margin over the budget handed to the tool.
    local BOOT_MS=840000 prev_timeout="$TOOL_TIMEOUT"
    TOOL_TIMEOUT=$(( BOOT_MS / 1000 + 60 ))
    run_tool boot-device "{\"avdName\":\"$E2E_ANDROID_AVD\",\"bootTimeoutMs\":$BOOT_MS}"
    TOOL_TIMEOUT="$prev_timeout"
    if [ "$RT_RC" -eq 0 ] && printf '%s' "$RT_JSON" | jq -e '.booted==true' >/dev/null 2>&1; then
      DEV="$(printf '%s' "$RT_JSON" | jq -r '.serial // .udid // empty')"
      BOOTED_HERE=1
      # The RN tier resolves its device from E2E_ANDROID_SERIAL, so without this
      # `--android-avd` drives this tier fully and then blanket-skips every
      # debugger/profiler tool for want of the device it just booted.
      export E2E_ANDROID_SERIAL="$DEV"
      pass "$P" boot-device boot "booted $DEV"
    else
      fail "$P" boot-device boot "$(rt_detail 160)"; return 0
    fi
  else
    skip "$P" tier all "no Android device (set E2E_ANDROID_SERIAL or E2E_ANDROID_AVD)"; return 0
  fi
  local U="{\"udid\":\"$DEV\"}"

  _shot_ok "$P" "$DEV" baseline || true
  assert_field "$P" describe describe "$U" '(.description|length>0)' 'true'
  assert_ok    "$P" await-screen-idle idle "$U"
  assert_ok    "$P" await-ui-element exists-probe "{\"udid\":\"$DEV\",\"condition\":\"exists\",\"selector\":{\"text\":\"a\"},\"timeoutMs\":3000}"

  assert_true "$P" gesture-tap tap    "{\"udid\":\"$DEV\",\"x\":0.5,\"y\":0.5}" '.tapped'
  assert_true "$P" gesture-swipe swipe "{\"udid\":\"$DEV\",\"fromX\":0.5,\"fromY\":0.8,\"toX\":0.5,\"toY\":0.2}" '.swiped'
  assert_ok   "$P" gesture-custom custom "{\"udid\":\"$DEV\",\"events\":[{\"type\":\"Down\",\"x\":0.5,\"y\":0.6},{\"type\":\"Move\",\"x\":0.5,\"y\":0.4},{\"type\":\"Up\",\"x\":0.5,\"y\":0.4}]}"
  assert_true "$P" gesture-pinch pinch  "{\"udid\":\"$DEV\",\"centerX\":0.5,\"centerY\":0.5,\"startDistance\":0.1,\"endDistance\":0.4}" '.pinched'
  assert_true "$P" gesture-rotate rotate2 "{\"udid\":\"$DEV\",\"centerX\":0.5,\"centerY\":0.5,\"radius\":0.2,\"startAngle\":0,\"endAngle\":90}" '.rotated'
  assert_ok   "$P" button home   "{\"udid\":\"$DEV\",\"button\":\"home\"}"
  assert_ok   "$P" button back   "{\"udid\":\"$DEV\",\"button\":\"back\"}"
  assert_ok   "$P" rotate landscape "{\"udid\":\"$DEV\",\"orientation\":\"LandscapeLeft\"}"
  assert_ok   "$P" rotate portrait  "{\"udid\":\"$DEV\",\"orientation\":\"Portrait\"}"
  assert_ok   "$P" keyboard text "{\"udid\":\"$DEV\",\"text\":\"hello e2e\"}"
  assert_ok   "$P" keyboard key  "{\"udid\":\"$DEV\",\"key\":\"enter\"}"
  # Both halves in ONE call is rejected — a guard the two legal calls above
  # cannot exercise. The 400 comes from `execute`, not from schema validation:
  # the constraint is cross-field and the advertised JSON Schema cannot say so.
  assert_reject "$P" keyboard text-and-key \
    "{\"udid\":\"$DEV\",\"text\":\"hello e2e\",\"key\":\"enter\"}"
  # The remedy that rejection prescribes. Each step dispatches through the same
  # keyboard tool, so `.completed` = 2 proves the guard did not fire on a step
  # carrying only one of the two.
  assert_field "$P" run-sequence keyboard-text-then-key \
    "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"keyboard\",\"args\":{\"text\":\"hello e2e\"}},{\"tool\":\"keyboard\",\"args\":{\"key\":\"enter\"}}]}" \
    '.completed' '2'
  assert_ok   "$P" run-sequence seq "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"button\",\"args\":{\"button\":\"home\"}},{\"tool\":\"gesture-tap\",\"args\":{\"x\":0.5,\"y\":0.5}}]}"

  assert_true "$P" open-url url "{\"udid\":\"$DEV\",\"url\":\"https://example.com\"}" '.opened'

  # Declared empty: a failed capture leaves its variable unassigned, and reading
  # one under `set -u` would abort the run.
  local b="" c=""
  _shot_ok "$P" "$DEV" diff-baseline && b="$SHOT_PATH"
  run_tool button "{\"udid\":\"$DEV\",\"button\":\"home\"}" >/dev/null 2>&1
  _shot_ok "$P" "$DEV" diff-current && c="$SHOT_PATH"
  if [ -n "$b" ] && [ -n "$c" ]; then
    assert_ok "$P" screenshot-diff diff "{\"udid\":\"$DEV\",\"baselinePath\":\"$b\",\"currentPath\":\"$c\"}"
  else
    skip "$P" screenshot-diff diff "could not capture two screenshots"
  fi

  local APP="com.android.settings"
  assert_true "$P" launch-app  launch  "{\"udid\":\"$DEV\",\"bundleId\":\"$APP\"}" '.launched'
  assert_true "$P" restart-app restart "{\"udid\":\"$DEV\",\"bundleId\":\"$APP\"}" '.restarted'

  assert_ok "$P" dismiss-update dismiss "{\"hours\":1}"

  # Recorded as skips so the coverage matrix accounts for them.
  local iostool
  for iostool in native-describe-screen native-devtools-status native-full-hierarchy \
                 native-find-views native-view-at-point native-user-interactable-view-at-point \
                 native-network-logs; do
    skip "$P" "$iostool" happy-path "iOS-only (not applicable on Android)"
  done
  skip "$P" tv-remote happy-path "TV-only tier (skipped per scope)"
  skip "$P" reinstall-app happy-path "covered in RN tier with the Bluesky apk"

  # Neither branch reaps: an injected device is the caller's, and one booted
  # here is still driven by the RN tier, which needs both the per-device service
  # and the emulator. 90-cleanup does that reap from run-e2e.sh's EXIT trap, so
  # an aborted run reaps the AVD too — ending it here would not.
  if [ "$BOOTED_HERE" -eq 1 ]; then
    export E2E_ANDROID_REAP_SERIAL="$DEV"
    skip "$P" stop-simulator-server stop "$DEV still in use by later phases; reaped in cleanup"
  else
    skip "$P" stop-simulator-server stop "injected device left running for the caller"
  fi
}
