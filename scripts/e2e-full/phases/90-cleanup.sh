#!/usr/bin/env bash
# Phase 90 — Cleanup. Best-effort teardown of everything the run spun up.
# The sandbox dir itself is removed by run-e2e.sh (unless --keep).

run_phase() {
  local P=cleanup

  # An AVD the android tier booted is reaped here, not there: the RN tier drives
  # the same serial after that tier ends, so its per-device service and the
  # emulator both have to survive until now. Runs before the stop-all below so
  # the per-device call still has a service to stop and can be asserted on.
  if [ -n "${E2E_ANDROID_REAP_SERIAL:-}" ]; then
    if server_running; then
      assert_ok "$P" stop-simulator-server stop "{\"udid\":\"$E2E_ANDROID_REAP_SERIAL\"}"
    else
      skip "$P" stop-simulator-server stop "no reachable tool-server"
    fi
    # Nothing else shuts the emulator itself down: the tool-server only reaps
    # devices Lens booted through its preview path, not ones the boot-device
    # tool started. Best-effort — a device already gone must not fail teardown.
    if command -v adb >/dev/null 2>&1; then
      adb -s "$E2E_ANDROID_REAP_SERIAL" emu kill >/dev/null 2>&1 || true
      info "sent 'emu kill' to $E2E_ANDROID_REAP_SERIAL"
    else
      warn "adb not on PATH: emulator $E2E_ANDROID_REAP_SERIAL left running"
    fi
  fi

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
  #
  # That same sandbox discovery is why the gate is `server_running` rather than
  # ARGENT_TOOLS_URL: the harness never pins that variable, so keying off it
  # skips both teardowns and leaves a simulator-server and Metro alive.
  if server_running; then
    run_tool stop-all-simulator-servers '{}' >/dev/null 2>&1 && pass "$P" stop-all-simulator-servers teardown || skip "$P" stop-all-simulator-servers teardown "none running"
    run_tool stop-metro '{}' >/dev/null 2>&1 && pass "$P" stop-metro teardown || skip "$P" stop-metro teardown "no metro"
  else
    skip "$P" stop-all-simulator-servers teardown "no reachable tool-server"
    skip "$P" stop-metro teardown "no reachable tool-server"
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

  # Stop our private tool-server, and confirm it actually went down — this case
  # is the run's only record that nothing was left behind, so it has to check
  # rather than assert.
  argent_cli server stop >/dev/null 2>&1 && info "stopped private tool-server" || true
  if server_running; then
    fail "$P" harness teardown-complete "tool-server still answering after 'server stop'"
  else
    pass "$P" harness teardown-complete
  fi
}
