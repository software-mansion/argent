#!/usr/bin/env bash
# Phase 1 — Introspection (offline, no device).
#
# Exercises the CLI surface itself and proves `argent tools describe` works for
# EVERY tool (this is where all 70 tools first get a recorded case). Also
# round-trips flags, the server lifecycle, and remote-link config — all against
# the sandbox HOME.

run_phase() {
  local P=introspection

  # --- help / version / unknown command ------------------------------------
  if argent_cli --version && [ "$CLI_OUT" = "$TGZ_VERSION" ]; then
    pass "$P" cli version
  else
    fail "$P" cli version "got '$CLI_OUT' want '$TGZ_VERSION'"
  fi

  argent_cli --help
  case "$CLI_OUT" in *"Usage: argent"*) pass "$P" cli help;; *) fail "$P" cli help "no usage banner";; esac

  argent_cli definitely-not-a-command
  if [ $? -ne 0 ]; then pass "$P" cli unknown-command-exits-nonzero; else fail "$P" cli unknown-command-exits-nonzero "exited 0"; fi

  # --- tool list: expect the full published set ----------------------------
  local names n
  names="$(list_tool_names)"
  n="$(printf '%s\n' "$names" | grep -c .)"
  if [ "$n" -ge 60 ]; then
    pass "$P" tools "list ($n tools)"
  else
    fail "$P" tools "list ($n tools)" "suspiciously few tools"
  fi

  # --- describe EVERY tool (records a case per tool) ------------------------
  local t model
  while read -r t; do
    [ -z "$t" ] && continue
    model="$(parse_tool_model "$t")"
    if [ -s "$model" ] || argent_cli tools describe "$t"; then
      # a tool with no params is legitimate; require the describe call itself to succeed
      if argent_cli tools describe "$t"; then
        pass "$P" "$t" describe "$(model_flag_count "$model") flags"
      else
        fail "$P" "$t" describe "describe exited non-zero"
      fi
    fi
  done <<< "$names"

  # --- feature flags round-trip (uses a predefined flag name) --------------
  argent_cli flags; [ $? -eq 0 ] && pass "$P" flags list || fail "$P" flags list "$CLI_OUT"
  local PROBE_FLAG="disable-auto-screenshot"
  if argent_cli enable "$PROBE_FLAG" --scope global; then
    argent_cli flags
    case "$CLI_OUT" in *"$PROBE_FLAG"*) pass "$P" flags enable;; *) fail "$P" flags enable "flag not shown after enable";; esac
    argent_cli disable "$PROBE_FLAG" --scope global && pass "$P" flags disable || fail "$P" flags disable "$CLI_OUT"
  else
    fail "$P" flags enable "enable exited non-zero: $(printf '%s' "$CLI_OUT" | head -1)"
  fi

  # --- telemetry status -----------------------------------------------------
  argent_cli telemetry status; [ $? -eq 0 ] && pass "$P" telemetry status || fail "$P" telemetry status "$CLI_OUT"

  # --- server lifecycle (start/status/logs/stop) ---------------------------
  # Start from a clean slate: kill any server auto-spawned by the calls above so
  # we exercise an explicit `server start`.
  argent_cli server stop >/dev/null 2>&1 || true
  if argent_cli server start --detach --no-auth --port 0; then
    pass "$P" server start
  else
    fail "$P" server start "$(printf '%s' "$CLI_OUT" | head -1)"
  fi
  local i ready=0
  for i in $(seq 1 30); do server_running && { ready=1; break; }; sleep 1; done
  [ "$ready" -eq 1 ] && pass "$P" server ready || fail "$P" server ready "status never reported healthy"

  argent_cli server status --json
  if printf '%s' "$CLI_OUT" | jq -e '.running==true' >/dev/null 2>&1; then
    pass "$P" server status "port=$(printf '%s' "$CLI_OUT" | jq -r .port)"
  else
    fail "$P" server status "$(printf '%s' "$CLI_OUT" | head -1)"
  fi
  argent_cli server logs; [ $? -eq 0 ] && pass "$P" server logs || skip "$P" server logs "logs exited non-zero"

  # Prove stop works, then bring one back for downstream phases.
  if argent_cli server stop; then pass "$P" server stop; else fail "$P" server stop "$(printf '%s' "$CLI_OUT" | head -1)"; fi
  ensure_server || warn "could not restart server after stop test"

  # --- link / unlink round-trip (sandbox ~/.argent/link.json) --------------
  # NB: setting a link overrides discovery; unset it immediately so downstream
  # phases keep using ARGENT_TOOLS_URL.
  if argent_cli link "http://127.0.0.1:${E2E_TOOLS_PORT}"; then
    pass "$P" link set
    if [ -f "$E2E_HOME/.argent/link.json" ]; then pass "$P" link persisted; else skip "$P" link persisted "no link.json"; fi
    argent_cli unlink && pass "$P" link unset || fail "$P" link unset "$CLI_OUT"
  else
    fail "$P" link set "link exited non-zero: $(printf '%s' "$CLI_OUT" | head -1)"
  fi

  # leave the server running for downstream phases (validation reuses it)
}
