#!/usr/bin/env bash
# Phase 90 — Cleanup. Best-effort teardown of everything the run spun up.
# The sandbox dir itself is removed by run-e2e.sh (unless --keep).

run_phase() {
  local P=cleanup

  # Stop any simulator-servers this run started (Android/iOS backends).
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
