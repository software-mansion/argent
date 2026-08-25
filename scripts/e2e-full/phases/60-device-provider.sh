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
# It also enforces the parity rule for free, this server serves exactly what
# argent's own build serves, so code reaching past the allowlist fails here on
# its own.
#
# The device is injected the same way the android tier takes one
# (E2E_ANDROID_SERIAL), or booted from E2E_ANDROID_AVD by the android tier
# before this one runs. Without a device the whole tier skips with a reason.
#
# What a green run here does not prove: the simulator watcher
# (`utils/simulator-watcher.ts`) arms devtools injection on every booted sim it
# finds, by raw UDID and with no tool call behind it. This tier cannot see it,
# every phase runs under the sandbox $E2E_HOME, which hides CoreSimulator's
# default set, so a provider-claimed simulator the watcher must leave alone
# cannot be staged here at all. That path is covered only by
# `packages/tool-server/test/simulator-watcher-external-claim.test.ts`.

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
  # The sim-server takes `paste` on stdin and treats EOF there as "my parent is
  # gone", exiting immediately. A plain `&` in a non-interactive shell hands it
  # `/dev/null` (EOF on the first read), so it would die right after printing
  # its ready lines. Feed it a FIFO instead and hold the write end open in the
  # harness shell. The server lives until the phase kills it (or this shell
  # exits, which closes the fd and lets it shut down on its own).
  local fifo="$E2E_WORK/provider-simserver.stdin"
  rm -f "$fifo" && mkfifo "$fifo"
  # Read-write so this open never blocks (and no rendezvous can deadlock on a
  # child that failed to start). Fixed fd: macOS ships bash 3.2, which has no
  # {var}<> automatic allocation.
  exec 9<>"$fifo"
  # Real `$HOME``: a real provider runs under the user's home, and CoreSimulator
  # resolves its default device set from it; under the sandbox home the
  # simulator we were pointed at does not exist.
  HOME="${HOME_REAL:-$HOME}" \
    argent-simulator-server "$subcommand" --id "$native" <"$fifo" >"$logf" 2>&1 &
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

# Modification time in seconds — BSD and GNU stat spell it differently.
_mtime() { # path
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# The descriptor document, on stdout. Shared by the hand-rolled write below and
# the `providers publish` round-trip at the end, so both publish the same bytes.
_descriptor_json() { # native-id platform kind capabilities-json
  local native="$1" platform="$2" kind="$3" capabilities="$4"
  jq -nc \
    --arg id "$PROVIDER_ID" --arg nativeId "$native" --arg platform "$platform" \
    --arg kind "$kind" --arg api "$PROV_API_URL" \
    --arg stream "${PROV_STREAM_URL:-$PROV_API_URL}" \
    --arg deviceSet "${PROV_DEVICE_SET:-}" \
    --argjson capabilities "$capabilities" \
    '{schemaVersion:1,id:$id,name:"E2E Provider",
      supportUrl:"https://example.invalid/issues",
      workspace:{name:"e2e",path:"/tmp/e2e"},
      devices:[{nativeId:$nativeId,platform:$platform,kind:$kind,
        name:"E2E provider device",
        state:(if $platform=="ios" then "Booted" else "device" end),
        capabilities:$capabilities,
        simulatorServer:{apiUrl:$api,streamUrl:$stream,version:"e2e"}}
        + (if $deviceSet != "" then {deviceSet:$deviceSet} else {} end)]}'
}

# Publish the descriptor naming the simulator-server we just spawned. This is
# the entire provider side of the contract; no server, no port, no auth.
#
# Hand-rolled rather than going through `argent providers publish`. Writing the
# file yourself is the contract of record and the only path open to a provider
# that cannot spawn a Node CLI. The CLI transport is exercised at the end.
# Sets: `PROV_DESCRIPTOR`.
_publish_descriptor() { # native-id platform kind capabilities-json
  local dir="$HOME/.argent/providers"
  mkdir -p "$dir"
  PROV_DESCRIPTOR="$dir/$PROVIDER_ID.json"

  # tmp + rename, exactly as the contract requires of a real provider. Argent
  # reads concurrently and must never see a half-written file.
  _descriptor_json "$@" >"$PROV_DESCRIPTOR.tmp"
  mv "$PROV_DESCRIPTOR.tmp" "$PROV_DESCRIPTOR"
}

# Rewrite the descriptor with an empty device list — how a provider withdraws a
# device (and how a narrowed grant reaches argent).
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
    # The harness sandboxes `$HOME``, but the simulator was booted under the
    # real one and CoreSimulator's default device set lives under `$HOME`.
    # Publish the real set in the descriptor (the contract's own mechanism for
    # "my devices are not in your default set") so the sandboxed tool-server's
    # `simctl` calls can find the device.
    PROV_DEVICE_SET="${HOME_REAL:-$HOME}/Library/Developer/CoreSimulator/Devices"
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

  # `providers list` is what support asks a user to run, so it has to see the
  # hand-rolled descriptor above. No CLI-published state in between.
  if argent_cli providers list --json &&
    printf '%s' "$CLI_OUT" | jq -e --arg id "$PROVIDER_ID" \
      'any(.providers[]?; .id==$id and (.devices|length)==1)' >/dev/null 2>&1; then
    pass "$P" providers-list "the hand-written descriptor is listed"
  else
    fail "$P" providers-list "descriptor listed" "$(printf '%s' "$CLI_OUT" | tr '\n' ' ' | cut -c1-200)"
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

  # paste is the guard for `/api/clipboard/text`, it is the only tool that calls
  # it, so a stale allowlist would show up here as a refusal.
  assert_ok "$P" paste type "{\"udid\":\"$DEV\",\"text\":\"argent\"}"

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
  # `bundleId` is required by the tool's schema; without it validation fails
  # (rc=2, usage text) before the capability gate ever runs and the denial this
  # case exists to prove never happens. Any value will do, the grant check fires
  # before the app is looked up.
  run_tool native-describe-screen "{\"udid\":\"$DEV\",\"bundleId\":\"com.e2e.denied\"}"
  if [ "$RT_RC" -ne 0 ] && printf '%s' "$RT_OUT" | grep -qi "did not grant"; then
    pass "$P" native-describe-screen "denied: native-devtools not granted"
  else
    fail "$P" native-describe-screen "denied" "rc=$RT_RC $(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-160)"
  fi

  # --- revocation -----------------------------------------------------------
  # Withdraw the device and assert the very next call is refused. There is no
  # TTL to wait out: argent re-reads the descriptor on every dispatch, so a
  # withdrawal (or a narrowed capability set, which is how a provider revokes
  # part of a grant) takes effect immediately.
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

  # --- the CLI transport ----------------------------------------------------
  # Everything above wrote the descriptor by hand. A provider that can spawn a
  # node CLI should go through `argent providers` instead, so its validator
  # ships with the tool-server that reads the result. Withdraw the hand-written
  # file, republish the same document through the CLI, and check argent sees the
  # device either way.
  if argent_cli providers withdraw "$PROVIDER_ID" && [ ! -f "$PROV_DESCRIPTOR" ]; then
    pass "$P" providers-withdraw "removed $PROV_DESCRIPTOR"
  else
    fail "$P" providers-withdraw removed "$(printf '%s' "$CLI_OUT" | tr '\n' ' ' | cut -c1-200)"
  fi

  run_tool list-devices '{}'
  if printf '%s' "$RT_JSON" | jq -e --arg id "$DEV" 'any(.devices[]?; .id==$id)' >/dev/null 2>&1; then
    fail "$P" providers-withdraw "device gone from list-devices" "$DEV is still listed"
  else
    pass "$P" providers-withdraw "device gone from list-devices"
  fi

  local DOC="$E2E_WORK/provider-descriptor.json"
  _descriptor_json "$NATIVE" "$PLATFORM" "$KIND" "$CAPS" >"$DOC"

  # `--pid` is the providers's, never the CLI's: the CLI exits immediately, so
  # its own pid would be dead on arrival. `$$` is this harness, standing in for
  # one.
  if argent_cli providers publish --stdin --pid "$$" <"$DOC" &&
    [ -f "$HOME/.argent/providers/$PROVIDER_ID.json" ]; then
    pass "$P" providers-publish "wrote the canonical <id>.json"
  else
    fail "$P" providers-publish "canonical path" "$(printf '%s' "$CLI_OUT" | tr '\n' ' ' | cut -c1-200)"
  fi

  run_tool list-devices '{}'
  if printf '%s' "$RT_JSON" | jq -e --arg id "$DEV" 'any(.devices[]?; .id==$id)' >/dev/null 2>&1; then
    pass "$P" providers-publish "the published device is discoverable"
  else
    fail "$P" providers-publish "device discoverable" "$(printf '%s' "$RT_JSON" | tr '\n' ' ' | cut -c1-200)"
  fi

  # An identical republish must not touch the file. What makes publishing on
  # every device change cheap enough to wire straight to session events.
  local MTIME_BEFORE MTIME_AFTER
  MTIME_BEFORE=$(_mtime "$HOME/.argent/providers/$PROVIDER_ID.json")
  argent_cli providers publish --stdin --pid "$$" <"$DOC" || true
  MTIME_AFTER=$(_mtime "$HOME/.argent/providers/$PROVIDER_ID.json")
  if [ "$MTIME_BEFORE" = "$MTIME_AFTER" ]; then
    pass "$P" providers-publish "an identical republish left the file alone"
  else
    fail "$P" providers-publish "identical republish is a no-op" "mtime moved $MTIME_BEFORE -> $MTIME_AFTER"
  fi

  # prune only removes descriptors whose declared pid is gone, and $$ is here.
  if argent_cli providers prune --json &&
    printf '%s' "$CLI_OUT" | jq -e '.pruned == []' >/dev/null 2>&1 &&
    [ -f "$HOME/.argent/providers/$PROVIDER_ID.json" ]; then
    pass "$P" providers-prune "left a live provider's descriptor in place"
  else
    fail "$P" providers-prune "live descriptor kept" "$(printf '%s' "$CLI_OUT" | tr '\n' ' ' | cut -c1-200)"
  fi

  # --- non-interference -----------------------------------------------------
  if kill -0 "$PROV_SIM_PID" 2>/dev/null; then
    pass "$P" simulator-server "provider's server still alive at end of session"
  else
    fail "$P" simulator-server "still alive at end of session" "pid $PROV_SIM_PID is gone"
  fi
}
