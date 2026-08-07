#!/usr/bin/env bash
# Phase 90 — Cleanup. Best-effort teardown of everything the run spun up.
# The sandbox dir itself is removed by run-e2e.sh (unless --keep).

run_phase() {
  local P=cleanup

  # Drain the run's own tool-server. The unscoped `{}` is the machine-wide sweep
  # across every device-owned namespace — simulator-servers, native devtools, AX,
  # TV-control daemons, Chromium CDP, screen recordings, native-profiler and
  # JS-runtime debugger sessions — not just "the simulator-servers this run
  # started", which is what this said while the tool only reached the transports.
  #
  # Unscoped is nonetheless right HERE, and only here: the run's HOME is the
  # sandbox, so the server it discovers is this run's own (see ensure_server's
  # note) and the sweep cannot reach another agent's devices. Anywhere an agent
  # is talking to the shared install, pass `devices` — that is what the tool's
  # own description and the skills tell agents to do.
  if [ -n "${ARGENT_TOOLS_URL:-}" ]; then
    run_tool stop-all-simulator-servers '{}' >/dev/null 2>&1 && pass "$P" stop-all-simulator-servers teardown || skip "$P" stop-all-simulator-servers teardown "no server/none running"
    run_tool stop-metro '{}' >/dev/null 2>&1 && pass "$P" stop-metro teardown || skip "$P" stop-metro teardown "no metro"
  fi

  # Kill any Electron we spawned (tracked by 40-chromium).
  if [ -n "${E2E_ELECTRON_PID:-}" ] && kill -0 "$E2E_ELECTRON_PID" 2>/dev/null; then
    kill "$E2E_ELECTRON_PID" 2>/dev/null || true
    info "killed electron pid $E2E_ELECTRON_PID"
  fi

  # Kill the local http server backing the Electron fixture.
  if [ -n "${E2E_HTTP_PID:-}" ] && kill -0 "$E2E_HTTP_PID" 2>/dev/null; then
    kill "$E2E_HTTP_PID" 2>/dev/null || true
  fi

  # Stop Metro we started for the RN tier.
  if [ -n "${E2E_METRO_PID:-}" ] && kill -0 "$E2E_METRO_PID" 2>/dev/null; then
    kill "$E2E_METRO_PID" 2>/dev/null || true
    info "killed metro pid $E2E_METRO_PID"
  fi

  # Stop our private tool-server.
  argent_cli server stop >/dev/null 2>&1 && info "stopped private tool-server" || true

  pass "$P" harness teardown-complete
}
