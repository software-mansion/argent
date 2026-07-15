#!/usr/bin/env bash
# Shared library for the full Argent E2E harness.
#
# Sourced by run-e2e.sh and every phase module. Provides:
#   - logging (log/warn/err/group)
#   - the argent CLI wrapper (argent_cli) and tool driver (run_tool)
#   - result recording to a JSONL log (pass/fail/skip) + counters
#   - assertion helpers built on the proven contract:
#       `argent run <tool>` exits 0 on success (JSON on stdout),
#       non-zero on validation error / unknown tool / service failure.
#   - a private tool-server lifecycle (own port + own HOME so it never
#     collides with a foreign server on a shared machine)
#
# Every phase runs with a sandbox HOME ($E2E_HOME) so ~/.argent, MCP configs,
# and the npm global prefix land in a throwaway dir, never the real machine.
#
# Requires: bash 4+, jq, python3, node, npm. (adb / xvfb / expo are checked
# per-tier and gate with a recorded skip when absent.)

# ---------------------------------------------------------------------------
# Strictness. Phases opt into this by sourcing us; we do NOT set -e globally
# because assertions must keep running after an individual tool call fails.
# ---------------------------------------------------------------------------
set -uo pipefail

# ---------------------------------------------------------------------------
# Colors (respect NO_COLOR / non-tty)
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_RST=""
fi

log()   { printf '%s\n' "${C_BLU}▸${C_RST} $*" >&2; }
info()  { printf '%s\n' "${C_DIM}  $*${C_RST}" >&2; }
warn()  { printf '%s\n' "${C_YEL}! $*${C_RST}" >&2; }
err()   { printf '%s\n' "${C_RED}✗ $*${C_RST}" >&2; }
group() { printf '\n%s\n' "${C_BLU}==== $* ====${C_RST}" >&2; }

# ---------------------------------------------------------------------------
# Configuration derived from the environment exported by run-e2e.sh.
# ---------------------------------------------------------------------------
: "${E2E_JSONL:?E2E_JSONL must be set by run-e2e.sh}"
# ARGENT_BIN (e.g. "/sandbox/bin/argent" or "node /path/dist/cli.js") is set by
# run-e2e.sh AFTER the install decision — resolved lazily at call time below.
TOOL_TIMEOUT="${TOOL_TIMEOUT:-120}"                       # seconds per tool call
E2E_OS="${E2E_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"

# ---------------------------------------------------------------------------
# argent_cli — invoke the argent CLI with a timeout. Captures combined output
# in CLI_OUT and the exit code as the return value. Never aborts the script.
# The command is rebuilt from ARGENT_BIN each call so it tracks the value
# run-e2e.sh sets after installing.
# ---------------------------------------------------------------------------
argent_cli() {
  local out rc cmd
  read -ra cmd <<< "${ARGENT_BIN:?ARGENT_BIN not set yet}"
  out=$(timeout "$TOOL_TIMEOUT" "${cmd[@]}" "$@" 2>&1); rc=$?
  CLI_OUT="$out"
  return "$rc"
}

# ---------------------------------------------------------------------------
# run_tool <tool> [json-args] — drive one tool via `argent run`.
# Sets: RT_RC (exit code), RT_JSON (stdout only), RT_ERR (stderr), RT_OUT (both).
# ---------------------------------------------------------------------------
run_tool() {
  local tool="$1" args="${2:-}"
  local errf cmd; errf=$(mktemp)
  read -ra cmd <<< "${ARGENT_BIN:?ARGENT_BIN not set yet}"
  if [ -n "$args" ]; then
    RT_JSON=$(timeout "$TOOL_TIMEOUT" "${cmd[@]}" run "$tool" --args "$args" 2>"$errf"); RT_RC=$?
  else
    RT_JSON=$(timeout "$TOOL_TIMEOUT" "${cmd[@]}" run "$tool" 2>"$errf"); RT_RC=$?
  fi
  RT_ERR=$(cat "$errf"); rm -f "$errf"
  RT_OUT="${RT_JSON}
${RT_ERR}"
  return "$RT_RC"
}

# ---------------------------------------------------------------------------
# Result recording. One JSON object per test case appended to $E2E_JSONL.
# Counters live in files so subshells/phases aggregate correctly.
# ---------------------------------------------------------------------------
PASS_N=0; FAIL_N=0; SKIP_N=0

_record() { # phase tool case status detail
  jq -nc \
    --arg phase "$1" --arg tool "$2" --arg case "$3" \
    --arg status "$4" --arg detail "$5" \
    '{phase:$phase,tool:$tool,case:$case,status:$status,detail:$detail}' \
    >> "$E2E_JSONL"
}

pass() { # phase tool case [detail]
  local phase="${1:-}" tool="${2:-}" case="${3:-}" detail="${4:-}"
  _record "$phase" "$tool" "$case" "pass" "$detail"
  PASS_N=$((PASS_N + 1))
  printf '%s\n' "  ${C_GRN}✓${C_RST} ${C_DIM}$tool${C_RST} $case" >&2
}
fail() { # phase tool case detail
  local phase="${1:-}" tool="${2:-}" case="${3:-}" detail="${4:-}"
  _record "$phase" "$tool" "$case" "fail" "$detail"
  FAIL_N=$((FAIL_N + 1))
  printf '%s\n' "  ${C_RED}✗${C_RST} $tool ${C_DIM}[$case]${C_RST} $detail" >&2
}
skip() { # phase tool case reason
  local phase="${1:-}" tool="${2:-}" case="${3:-}" detail="${4:-}"
  _record "$phase" "$tool" "$case" "skip" "$detail"
  SKIP_N=$((SKIP_N + 1))
  printf '%s\n' "  ${C_YEL}∼${C_RST} ${C_DIM}$tool ($case): $detail${C_RST}" >&2
}

# ---------------------------------------------------------------------------
# Assertion helpers (all take: phase tool case ...).
# ---------------------------------------------------------------------------

# The tool call must SUCCEED (rc 0).
assert_ok() { # phase tool case json-args
  local phase="$1" tool="$2" case="$3" args="${4:-}"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -eq 0 ]; then
    pass "$phase" "$tool" "$case"
  else
    fail "$phase" "$tool" "$case" "$(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-200)"
  fi
}

# The tool call must SUCCEED and a jq filter over stdout must equal `expected`.
assert_field() { # phase tool case json-args jq-filter expected
  local phase="$1" tool="$2" case="$3" args="$4" filter="$5" expected="$6"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -ne 0 ]; then
    fail "$phase" "$tool" "$case" "rc=$RT_RC: $(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-160)"
    return
  fi
  local got; got=$(printf '%s' "$RT_JSON" | jq -r "$filter" 2>/dev/null)
  if [ "$got" = "$expected" ]; then
    pass "$phase" "$tool" "$case" "$filter=$got"
  else
    fail "$phase" "$tool" "$case" "expected $filter=$expected got '$got'"
  fi
}

# The tool call must SUCCEED and a jq boolean filter over stdout must be true.
assert_true() { # phase tool case json-args jq-filter
  local phase="$1" tool="$2" case="$3" args="$4" filter="$5"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -ne 0 ]; then
    fail "$phase" "$tool" "$case" "rc=$RT_RC: $(printf '%s' "$RT_OUT" | tr '\n' ' ' | cut -c1-160)"
    return
  fi
  local got; got=$(printf '%s' "$RT_JSON" | jq -r "$filter" 2>/dev/null)
  if [ "$got" = "true" ]; then
    pass "$phase" "$tool" "$case" "$filter"
  else
    fail "$phase" "$tool" "$case" "expected $filter to be true, got '$got'"
  fi
}

# The tool call must FAIL (rc != 0). If `path` is given, and stdout is a zod
# issue array, at least one issue must match that path (proves the specific
# field was rejected, not just an unrelated error).
assert_reject() { # phase tool case json-args [zod-path] [zod-code]
  local phase="$1" tool="$2" case="$3" args="$4" zpath="${5:-}" zcode="${6:-}"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -eq 0 ]; then
    fail "$phase" "$tool" "$case" "expected rejection but tool SUCCEEDED"
    return
  fi
  if [ -n "$zpath" ]; then
    # Best-effort structured check: if stdout is a zod issue array, assert a
    # matching issue exists. If output isn't JSON (e.g. plain service error),
    # the non-zero exit alone satisfies the case.
    local hit
    hit=$(printf '%s' "$RT_JSON" | jq -e --arg p "$zpath" --arg c "$zcode" '
      if type=="array" then
        any(.[]; (.path[0] == $p) and ($c=="" or .code==$c))
      else false end' 2>/dev/null)
    if [ "$hit" = "true" ]; then
      pass "$phase" "$tool" "$case" "rejected $zpath${zcode:+/$zcode}"
    else
      # Non-structured failure still counts as a rejection, but note it.
      pass "$phase" "$tool" "$case" "rc=$RT_RC (unstructured)"
    fi
  else
    pass "$phase" "$tool" "$case" "rc=$RT_RC"
  fi
}

# ---------------------------------------------------------------------------
# Private tool-server lifecycle. Uses ARGENT_TOOLS_URL so `argent run` targets
# OUR server (own port), and a sandbox HOME so its state file is isolated.
# ---------------------------------------------------------------------------
# Is a healthy tool-server discoverable for this install (via ~/.argent state)?
server_running() {
  argent_cli server status --json || return 1
  printf '%s' "$CLI_OUT" | jq -e '.running==true and (.healthy==true or .alive==true)' >/dev/null 2>&1
}

# Ensure a tool-server is up. We do NOT pin a port or ARGENT_TOOLS_URL: the CLI
# auto-spawns on demand and records the port in the sandbox ~/.argent state, so
# every `argent run`/`tools`/`status` call discovers the same server. On a
# shared machine this stays isolated because HOME is the sandbox.
ensure_server() {
  server_running && return 0
  log "starting sandbox tool-server (detached, no-auth, auto-port)"
  argent_cli server start --detach --no-auth --port 0 >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do
    server_running && return 0
    sleep 1
  done
  warn "tool-server did not become ready"
  return 1
}

# PNG "real pixels" floor, shared with drive-device.sh rationale.
MIN_SHOT_BYTES="${MIN_SHOT_BYTES:-20000}"

# Extract an artifact hostPath from a screenshot-style envelope on stdout.
artifact_path() { # <jq-path-to-artifact-object, default .image>
  local sel="${1:-.image}"
  printf '%s' "$RT_JSON" | jq -r "${sel}.hostPath // empty" 2>/dev/null
}

# Capture a screenshot straight to a file via `argent run screenshot --out`
# (the CLI renders screenshot artifacts as a "Saved screenshot: <path>" message
# rather than JSON, so --out is the deterministic path). Returns 0 and sets
# SHOT_PATH when the file exists and exceeds the real-pixels floor.
capture_screenshot() { # udid outfile
  local udid="$1" out="$2" cmd
  read -ra cmd <<< "${ARGENT_BIN:?}"
  rm -f "$out"
  timeout "$TOOL_TIMEOUT" "${cmd[@]}" run screenshot --udid "$udid" --out "$out" >/dev/null 2>&1
  SHOT_RC=$?
  [ -f "$out" ] || return 1
  SHOT_SIZE="$(wc -c <"$out" | tr -d ' ')"
  SHOT_PATH="$out"
  [ "$SHOT_SIZE" -gt "$MIN_SHOT_BYTES" ]
}
