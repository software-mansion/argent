#!/usr/bin/env bash
# Phase 60 — External device provider tier.
#
# Exercises the provider contract end to end without installing any
# third-party software, by having the harness itself BE the provider:
#
#   1. spawn `argent-simulator-server` directly — argent's OWN bundled binary —
#      against an already-booted device, and capture its `api_ready` /
#      `stream_ready` lines,
#   2. publish a descriptor naming those URLs into the sandbox
#      `~/.argent/providers/` — which is the whole provider side of the
#      contract: no server, no port, no auth,
#   3. drive the resulting `ext:` device through the real tools.
#
# This is genuinely faithful rather than a mock: it is the same protocol, over
# the same binary, from the same release channel a real provider would spawn.
# It also enforces the parity rule for free — the forbidden endpoints
# (/api/video/*, /api/clipboard/text, /api/token/verify) do not exist in
# argent's own build, so any code reaching for one fails here on its own.
#
# The device is injected the same way the android tier takes one
# (E2E_ANDROID_SERIAL), or booted from E2E_ANDROID_AVD by the android tier
# before this one runs. Without a device the whole tier skips with a reason.

PROVIDER_ID="e2eprov"

# Spawn argent's simulator-server against $1 and wait for its ready lines.
# Sets: PROV_SIM_PID, PROV_API_URL, PROV_STREAM_URL.
_spawn_sim_server() { # native-id subcommand
  local native="$1" subcommand="$2"
  local logf="$E2E_WORK/provider-simserver.log"
  : >"$logf"

  if ! command -v argent-simulator-server >/dev/null 2>&1; then
    return 1
  fi
  argent-simulator-server "$subcommand" --id "$native" >"$logf" 2>&1 &
  PROV_SIM_PID=$!

  local i
  for i in $(seq 1 60); do
    kill -0 "$PROV_SIM_PID" 2>/dev/null || return 1
    PROV_API_URL=$(grep -m1 '^api_ready ' "$logf" 2>/dev/null | grep -o 'http://[^ ]*' || true)
    PROV_STREAM_URL=$(grep -m1 '^stream_ready ' "$logf" 2>/dev/null | grep -o 'http://[^ ]*' || true)
    [ -n "$PROV_API_URL" ] && return 0
    sleep 1
  done
  return 1
}

# Publish the descriptor naming the simulator-server we just spawned. This is
# the entire provider side of the contract — no server, no port, no auth.
# Sets: PROV_DESCRIPTOR.
_publish_descriptor() { # native-id platform kind capabilities-json
  local native="$1" platform="$2" kind="$3" capabilities="$4"
  local dir="$HOME/.argent/providers"
  mkdir -p "$dir"
  PROV_DESCRIPTOR="$dir/$PROVIDER_ID.json"

  # tmp + rename, exactly as the contract requires of a real provider: argent
  # reads concurrently and must never see a half-written file.
  jq -nc \
    --arg id "$PROVIDER_ID" --arg nativeId "$native" --arg platform "$platform" \
    --arg kind "$kind" --arg api "$PROV_API_URL" \
    --arg stream "${PROV_STREAM_URL:-$PROV_API_URL}" \
    --argjson capabilities "$capabilities" \
    '{schemaVersion:1,id:$id,name:"E2E Provider",
      supportUrl:"https://example.invalid/issues",
      workspace:{name:"e2e",path:"/tmp/e2e"},
      devices:[{nativeId:$nativeId,platform:$platform,kind:$kind,
        name:"E2E provider device",
        state:(if $platform=="ios" then "Booted" else "device" end),
        capabilities:$capabilities,
        simulatorServer:{apiUrl:$api,streamUrl:$stream,version:"e2e"}}]}' \
    >"$PROV_DESCRIPTOR.tmp"
  mv "$PROV_DESCRIPTOR.tmp" "$PROV_DESCRIPTOR"
}

# Rewrite the descriptor with an empty device list — how a provider withdraws a
# device (and how a licence revocation reaches argent).
_withdraw_device() {
  jq -nc --arg id "$PROVIDER_ID" \
    '{schemaVersion:1,id:$id,name:"E2E Provider",
      supportUrl:"https://example.invalid/issues",devices:[]}' \
    >"$PROV_DESCRIPTOR.tmp"
  mv "$PROV_DESCRIPTOR.tmp" "$PROV_DESCRIPTOR"
}

run_phase() {
  local P=device-provider
  ensure_server || { skip "$P" tier all "tool-server unavailable"; return 0; }

  local NATIVE="" PLATFORM="" KIND="" SUBCOMMAND="" CAPS=""
  if [ -n "${E2E_ANDROID_SERIAL:-}" ]; then
    NATIVE="$E2E_ANDROID_SERIAL"; PLATFORM=android; KIND=emulator
    SUBCOMMAND=android; CAPS='["simulator-server","adb"]'
  elif [ -n "${E2E_PROVIDER_IOS_UDID:-}" ]; then
    NATIVE="$E2E_PROVIDER_IOS_UDID"; PLATFORM=ios; KIND=simulator
    SUBCOMMAND=ios; CAPS='["simulator-server","simctl","ax-service"]'
  else
    skip "$P" tier all "no device (set E2E_ANDROID_SERIAL or E2E_PROVIDER_IOS_UDID)"; return 0
  fi

  # The device must NOT already be driven by a tool-server-owned session, or the
  # two would contend for the same backend.
  run_tool stop-simulator-server "{\"udid\":\"$NATIVE\"}" >/dev/null 2>&1 || true

  if ! _spawn_sim_server "$NATIVE" "$SUBCOMMAND"; then
    skip "$P" tier all "could not start argent-simulator-server for $NATIVE"
    [ -n "${PROV_SIM_PID:-}" ] && kill "$PROV_SIM_PID" 2>/dev/null
    return 0
  fi
  pass "$P" simulator-server "provider spawned its own server (pid $PROV_SIM_PID)"

  if ! _publish_descriptor "$NATIVE" "$PLATFORM" "$KIND" "$CAPS"; then
    fail "$P" provider-descriptor publish "could not write $HOME/.argent/providers"
    kill "$PROV_SIM_PID" 2>/dev/null
    return 0
  fi
  pass "$P" provider-descriptor "published $PROV_DESCRIPTOR"
  # Export so 90-cleanup reaps them even if this phase bails out early.
  export E2E_PROVIDER_SIM_PID="$PROV_SIM_PID"
  export E2E_PROVIDER_DESCRIPTOR="$PROV_DESCRIPTOR"

  local DEV="ext:$PROVIDER_ID:$NATIVE"
  local U="{\"udid\":\"$DEV\"}"

  # --- the contract itself --------------------------------------------------
  if argent_cli providers check --json; then
    pass "$P" providers-check conformant
  else
    fail "$P" providers-check conformant "$(printf '%s' "$CLI_OUT" | tr '\n' ' ' | cut -c1-200)"
  fi

  # --- discovery ------------------------------------------------------------
  run_tool list-devices '{}'
  if printf '%s' "$RT_JSON" | jq -e --arg id "$DEV" \
      'any(.devices[]?; .id==$id and .external==true and .provider.name=="E2E Provider")' >/dev/null 2>&1; then
    pass "$P" list-devices "external device listed with provider attribution"
  else
    fail "$P" list-devices "external device listed" "$(printf '%s' "$RT_JSON" | tr '\n' ' ' | cut -c1-200)"
  fi

  # The provider claimed this serial, so the plain adb row must be gone — a
  # duplicate would let an agent target the same device by two ids, one of which
  # would spawn a SECOND simulator-server against a device already being driven.
  if [ "$PLATFORM" = android ]; then
    run_tool list-devices '{}'
    local dupes
    dupes=$(printf '%s' "$RT_JSON" | jq --arg s "$NATIVE" '[.devices[]? | select(.serial==$s)] | length')
    if [ "${dupes:-1}" = "0" ]; then
      pass "$P" list-devices "no adb shadow row for the claimed serial"
    else
      fail "$P" list-devices "no adb shadow row" "found $dupes plain row(s) for $NATIVE"
    fi
  fi

  # --- tier 0 tools ---------------------------------------------------------
  if capture_screenshot "$DEV" "$E2E_WORK/provider-shot.png"; then
    pass "$P" screenshot "attached capture (${SHOT_SIZE}B)"
  else
    fail "$P" screenshot attached "size=${SHOT_SIZE:-0} rc=${SHOT_RC:-?}"
  fi
  assert_ok "$P" gesture-tap tap "{\"udid\":\"$DEV\",\"x\":100,\"y\":200}"
  assert_ok "$P" await-screen-idle idle "$U"
  # keyboard is the regression guard for pressKey: the local path writes to the
  # child's stdin, which an attached server does not have, so without the
  # websocket route this silently no-ops while still reporting success.
  assert_ok "$P" keyboard type "{\"udid\":\"$DEV\",\"text\":\"argent\"}"

  # --- what argent must NOT do ----------------------------------------------
  run_tool boot-device "$U"
  if [ "$RT_RC" -ne 0 ] && printf '%s' "$RT_OUT" | grep -qi "owns its lifecycle"; then
    pass "$P" boot-device "refused for a provider-owned device"
  else
    fail "$P" boot-device "refused" "rc=$RT_RC $(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-160)"
  fi

  run_tool stop-simulator-server "$U"
  if [ "$RT_RC" -eq 0 ] && printf '%s' "$RT_JSON" | jq -e '.stopped==false' >/dev/null 2>&1; then
    pass "$P" stop-simulator-server "no-op success for a provider-owned device"
  else
    fail "$P" stop-simulator-server "no-op success" "rc=$RT_RC $(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-160)"
  fi

  # The whole point of the no-op dispose: the provider's process is still there.
  if kill -0 "$PROV_SIM_PID" 2>/dev/null; then
    pass "$P" simulator-server "provider's server survived argent's teardown"
  else
    fail "$P" simulator-server "provider's server survived" "pid $PROV_SIM_PID is gone"
  fi

  # --- capability denial ----------------------------------------------------
  # Neither declared capability grants CDP or dylib injection, so both must fail
  # with the capability-denied message rather than crashing or half-working.
  run_tool native-describe-screen "$U"
  if [ "$RT_RC" -ne 0 ] && printf '%s' "$RT_OUT" | grep -qi "did not grant"; then
    pass "$P" native-describe-screen "denied: native-devtools not granted"
  else
    fail "$P" native-describe-screen "denied" "rc=$RT_RC $(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-160)"
  fi

  # --- revocation -----------------------------------------------------------
  # Withdraw the device and assert the very next call is refused. There is no
  # TTL to wait out: argent re-reads the descriptor on every dispatch, so a
  # withdrawal (or a narrowed capability set, which is how a licence revocation
  # would reach argent) takes effect immediately.
  _withdraw_device
  run_tool gesture-tap "{\"udid\":\"$DEV\",\"x\":100,\"y\":200}"
  if [ "$RT_RC" -ne 0 ]; then
    pass "$P" gesture-tap "refused immediately after the provider withdrew the device"
  else
    fail "$P" gesture-tap "refused after withdrawal" "call still succeeded"
  fi

  # And it must come back when the provider re-offers it — revocation is a
  # reaction to the file, not a latch.
  _publish_descriptor "$NATIVE" "$PLATFORM" "$KIND" "$CAPS"
  run_tool gesture-tap "{\"udid\":\"$DEV\",\"x\":100,\"y\":200}"
  if [ "$RT_RC" -eq 0 ]; then
    pass "$P" gesture-tap "works again once the provider re-offers the device"
  else
    fail "$P" gesture-tap "works again after re-offer" "rc=$RT_RC"
  fi

  # --- non-interference -----------------------------------------------------
  if kill -0 "$PROV_SIM_PID" 2>/dev/null; then
    pass "$P" simulator-server "provider's server still alive at end of session"
  else
    fail "$P" simulator-server "still alive at end of session" "pid $PROV_SIM_PID is gone"
  fi

  # No argent call may ever have touched a licensed/paid endpoint. Argent's own
  # build does not serve them, so a request would appear as a 404 in the
  # simulator-server log.
  if grep -qiE '/api/(video|clipboard|token)' "$E2E_WORK/provider-simserver.log" 2>/dev/null; then
    fail "$P" parity "no paid endpoints touched" "found a video/clipboard/token request in the log"
  else
    pass "$P" parity "no video/clipboard/token endpoint was ever requested"
  fi
}
