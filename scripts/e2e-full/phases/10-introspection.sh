#!/usr/bin/env bash
# Phase 1 — Introspection (offline, no device).
#
# Describes every tool `argent tools` reports (each tool's first recorded case),
# and round-trips flags, the server lifecycle and remote-link config against the
# sandbox HOME.

run_phase() {
  local P=introspection

  if argent_cli --version && [ "$CLI_OUT" = "$TGZ_VERSION" ]; then
    pass "$P" cli version
  else
    fail "$P" cli version "got '$CLI_OUT' want '$TGZ_VERSION'"
  fi

  argent_cli --help
  case "$CLI_OUT" in *"Usage: argent"*) pass "$P" cli help;; *) fail "$P" cli help "no usage banner";; esac

  argent_cli definitely-not-a-command
  if [ $? -ne 0 ]; then pass "$P" cli unknown-command-exits-nonzero; else fail "$P" cli unknown-command-exits-nonzero "exited 0"; fi

  local names n
  names="$(list_tool_names)"
  n="$(printf '%s\n' "$names" | grep -c .)"
  # A floor, not an exact count — the roster changes between releases. It only
  # has to catch a registry that failed to load, so it sits just under the
  # shipped set.
  local MIN_TOOLS="${E2E_MIN_TOOLS:-70}"
  if [ "$n" -ge "$MIN_TOOLS" ]; then
    pass "$P" tools list "$n tools"
  else
    fail "$P" tools list "$n tools, expected at least $MIN_TOOLS"
  fi

  # A tool with no params is legitimate, so the describe call's exit code — not
  # its flag count — is the verdict.
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

  argent_cli flags; [ $? -eq 0 ] && pass "$P" flags list || fail "$P" flags list "$CLI_OUT"
  # Must be a registry-known name: `argent enable` rejects anything else.
  local PROBE_FLAG="disable-auto-screenshot"
  # `argent flags` lists every registry flag whether or not one was ever stored,
  # so only the state token beside the name proves the write happened.
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

  argent_cli telemetry status; [ $? -eq 0 ] && pass "$P" telemetry status || fail "$P" telemetry status "$CLI_OUT"

  # Kill any server the calls above auto-spawned, so this exercises an explicit
  # `server start`.
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

  # Bring a server back after the stop test: downstream phases reuse it.
  if argent_cli server stop; then pass "$P" server stop; else fail "$P" server stop "$(printf '%s' "$CLI_OUT" | head -1)"; fi
  ensure_server || warn "could not restart server after stop test"

  # A link overrides discovery and this one points at a port nothing listens on,
  # so unset it immediately or every downstream phase talks to nothing.
  if argent_cli link "http://127.0.0.1:${E2E_TOOLS_PORT}"; then
    pass "$P" link set
    if [ -f "$E2E_HOME/.argent/link.json" ]; then pass "$P" link persisted; else skip "$P" link persisted "no link.json"; fi
    argent_cli unlink && pass "$P" link unset || fail "$P" link unset "$CLI_OUT"
  else
    fail "$P" link set "link exited non-zero: $(printf '%s' "$CLI_OUT" | head -1)"
  fi
}
