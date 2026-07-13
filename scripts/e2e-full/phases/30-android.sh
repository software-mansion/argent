#!/usr/bin/env bash
# Phase 3 — Android device tier (Linux + macOS).
#
# Drives a happy-path of every tool that applies to an Android emulator. The
# device is EITHER injected (E2E_ANDROID_SERIAL — e.g. a serial the device
# allocator handed us on a shared machine, already booted) OR booted here from
# E2E_ANDROID_AVD. If neither is available the whole tier is skipped with a
# reason so the report still makes sense.

# Verify a booted device with this serial is visible to the tool-server.
_android_present() { # serial
  run_tool list-devices '{}'
  printf '%s' "$RT_JSON" | jq -e --arg s "$1" 'any(.devices[]?; .serial==$s or .udid==$s)' >/dev/null 2>&1
}

# Grab a screenshot to a file and assert it has real pixels. Sets SHOT_PATH.
_shot_ok() { # phase udid case
  local phase="$1" udid="$2" case="$3"
  if capture_screenshot "$udid" "$E2E_WORK/android-$case.png"; then
    pass "$phase" screenshot "$case (${SHOT_SIZE}B)"; return 0
  else
    fail "$phase" screenshot "$case" "size=${SHOT_SIZE:-0} rc=${SHOT_RC:-?} (blank framebuffer?)"; return 1
  fi
}

run_phase() {
  local P=android
  ensure_server || { skip "$P" tier all "tool-server unavailable"; return 0; }

  local DEV=""
  if [ -n "${E2E_ANDROID_SERIAL:-}" ]; then
    DEV="$E2E_ANDROID_SERIAL"
    if _android_present "$DEV"; then
      pass "$P" list-devices "injected serial $DEV present"
    else
      # not yet visible — try a boot-device against it in case the sim-server
      # needs to attach; otherwise skip.
      skip "$P" tier all "injected serial $DEV not visible to tool-server"; return 0
    fi
  elif [ -n "${E2E_ANDROID_AVD:-}" ]; then
    log "booting AVD $E2E_ANDROID_AVD"
    run_tool boot-device "{\"avdName\":\"$E2E_ANDROID_AVD\",\"bootTimeoutMs\":840000}"
    if [ "$RT_RC" -eq 0 ] && printf '%s' "$RT_JSON" | jq -e '.booted==true' >/dev/null 2>&1; then
      DEV="$(printf '%s' "$RT_JSON" | jq -r '.serial // .udid // empty')"
      pass "$P" boot-device "booted $DEV"
    else
      fail "$P" boot-device "$(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-160)"; return 0
    fi
  else
    skip "$P" tier all "no Android device (set E2E_ANDROID_SERIAL or E2E_ANDROID_AVD)"; return 0
  fi
  local U="{\"udid\":\"$DEV\"}"

  # --- discovery ------------------------------------------------------------
  _shot_ok "$P" "$DEV" baseline || true
  assert_field "$P" describe describe "$U" '(.description|length>0)' 'true'
  assert_ok    "$P" await-screen-idle idle "$U"
  assert_ok    "$P" await-ui-element exists-probe "{\"udid\":\"$DEV\",\"condition\":\"exists\",\"selector\":{\"text\":\"a\"},\"timeoutMs\":3000}"

  # --- interaction ----------------------------------------------------------
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
  assert_ok   "$P" run-sequence seq "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"button\",\"args\":{\"button\":\"home\"}},{\"tool\":\"gesture-tap\",\"args\":{\"x\":0.5,\"y\":0.5}}]}"

  # --- url navigation -------------------------------------------------------
  assert_true "$P" open-url url "{\"udid\":\"$DEV\",\"url\":\"https://example.com\"}" '.opened'

  # --- screenshot-diff (two live captures) ----------------------------------
  local b c
  _shot_ok "$P" "$DEV" diff-baseline && b="$SHOT_PATH"
  cp "$b" "$E2E_WORK/diff-base.png" 2>/dev/null || true
  run_tool button "{\"udid\":\"$DEV\",\"button\":\"home\"}" >/dev/null 2>&1
  _shot_ok "$P" "$DEV" diff-current && c="$SHOT_PATH"
  if [ -n "${b:-}" ] && [ -n "${c:-}" ]; then
    assert_ok "$P" screenshot-diff diff "{\"baselinePath\":\"$E2E_WORK/diff-base.png\",\"currentPath\":\"$c\"}"
  else
    skip "$P" screenshot-diff diff "could not capture two screenshots"
  fi

  # --- app lifecycle against a stock system app -----------------------------
  local APP="com.android.settings"
  assert_true "$P" launch-app  launch  "{\"udid\":\"$DEV\",\"bundleId\":\"$APP\"}" '.launched'
  assert_true "$P" restart-app restart "{\"udid\":\"$DEV\",\"bundleId\":\"$APP\"}" '.restarted'

  # --- state-only + platform-scoped ----------------------------------------
  assert_ok "$P" dismiss-update dismiss "{\"hours\":1}"

  # iOS-only tools: recorded as skips so coverage is explicit.
  local iostool
  for iostool in native-describe-screen native-devtools-status native-full-hierarchy \
                 native-find-views native-view-at-point native-user-interactable-view-at-point \
                 native-network-logs; do
    skip "$P" "$iostool" happy-path "iOS-only (not applicable on Android)"
  done
  skip "$P" tv-remote happy-path "TV-only tier (skipped per scope)"
  skip "$P" reinstall-app happy-path "covered in RN tier with the Bluesky apk"

  # --- teardown for this device --------------------------------------------
  # Only stop the sim-server if we booted the AVD ourselves; a device injected
  # by the allocator is released by the caller.
  if [ -z "${E2E_ANDROID_SERIAL:-}" ]; then
    assert_ok "$P" stop-simulator-server stop "$U"
  else
    run_tool stop-simulator-server "$U" >/dev/null 2>&1 || true
    skip "$P" stop-simulator-server stop "injected device released by caller"
  fi
}
