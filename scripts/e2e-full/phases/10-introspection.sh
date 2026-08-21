#!/usr/bin/env bash
# Phase 1 — Introspection (offline, no device).
#
# Exercises the CLI surface itself and proves `argent tools describe` works for
# EVERY tool in the published set (this is where each one first gets a recorded
# case; the set is read from `argent tools`, never pinned to a count). Also
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
  # A floor, not an exact count — the roster changes between releases. It is
  # here to catch a registry that failed to load, so it sits just under the
  # shipped set rather than 20% below it.
  local MIN_TOOLS="${E2E_MIN_TOOLS:-70}"
  if [ "$n" -ge "$MIN_TOOLS" ]; then
    pass "$P" tools list "$n tools"
  else
    fail "$P" tools list "$n tools, expected at least $MIN_TOOLS"
  fi

  # --- describe EVERY tool (records a case per tool) ------------------------
  # A tool with no params is legitimate, so the describe call's own exit code is
  # the verdict. Every outcome has to be recorded: an unrecorded failure is
  # indistinguishable downstream from a tool that genuinely has no flags, which
  # is how the one failure this loop exists to catch would go unreported.
  local t model
  while read -r t; do
    [ -z "$t" ] && continue
    if argent_cli tools describe "$t"; then
      model="$(parse_tool_model "$t")"
      pass "$P" "$t" describe "$(model_flag_count "$model") flags"
    else
      fail "$P" "$t" describe "describe exited non-zero: $(printf '%s' "$CLI_OUT" | head -1)"
    fi
  done <<< "$names"

  # --- feature flags round-trip (uses a predefined flag name) --------------
  argent_cli flags; [ $? -eq 0 ] && pass "$P" flags list || fail "$P" flags list "$CLI_OUT"
  local PROBE_FLAG="disable-auto-screenshot"
  # `argent flags` is registry-driven: it lists every known flag with its state
  # whether or not anything was ever stored. The state token beside the name is
  # the only part that moves, so asserting the name appears would pass against a
  # store that was never written.
  _flag_state() { # flag -> "enabled" | "disabled" | ""
    printf '%s\n' "$CLI_OUT" | awk -v f="$1" '$1==f {print $2; exit}'
  }
  if argent_cli enable "$PROBE_FLAG" --scope global; then
    argent_cli flags
    if [ "$(_flag_state "$PROBE_FLAG")" = "enabled" ]; then
      pass "$P" flags enable
    else
      fail "$P" flags enable "still '$(_flag_state "$PROBE_FLAG")' after enable"
    fi
    if argent_cli disable "$PROBE_FLAG" --scope global; then
      argent_cli flags
      if [ "$(_flag_state "$PROBE_FLAG")" = "disabled" ]; then
        pass "$P" flags disable
      else
        fail "$P" flags disable "still '$(_flag_state "$PROBE_FLAG")' after disable"
      fi
    else
      fail "$P" flags disable "$(printf '%s' "$CLI_OUT" | head -1)"
    fi
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
  # NB: a link overrides discovery, and this one points at a port no server
  # listens on, so unset it immediately or every downstream phase talks to
  # nothing instead of to the server recorded in the sandbox ~/.argent.
  if argent_cli link "http://127.0.0.1:${E2E_TOOLS_PORT}"; then
    pass "$P" link set
    if [ -f "$E2E_HOME/.argent/link.json" ]; then pass "$P" link persisted; else skip "$P" link persisted "no link.json"; fi
    argent_cli unlink && pass "$P" link unset || fail "$P" link unset "$CLI_OUT"
  else
    fail "$P" link set "link exited non-zero: $(printf '%s' "$CLI_OUT" | head -1)"
  fi

  # leave the server running for downstream phases (validation reuses it)
}
