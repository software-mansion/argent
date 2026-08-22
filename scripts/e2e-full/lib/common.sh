#!/usr/bin/env bash
# Shared library for the full Argent E2E harness, sourced by run-e2e.sh:
# logging, the argent CLI wrapper, the tool driver, JSONL result recording and
# assertion helpers.
#
# The assertions rest on `argent run <tool>` exiting 0 on success (result on
# stdout) and non-zero on validation error, unknown tool or service failure.

# No `set -e`: assertions must keep running after an individual tool call fails.
set -uo pipefail

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

: "${E2E_JSONL:?E2E_JSONL must be set by run-e2e.sh}"
# run-e2e.sh sets ARGENT_BIN only after the install decision, so every call site
# below resolves it lazily.
TOOL_TIMEOUT="${TOOL_TIMEOUT:-120}"                       # seconds per tool call
E2E_OS="${E2E_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"

# argent_cli <args...> — run the CLI under timeout(1). Combined output lands in
# CLI_OUT; the CLI's exit code is the return value.
argent_cli() {
  local out rc cmd
  read -ra cmd <<< "${ARGENT_BIN:?ARGENT_BIN not set yet}"
  out=$(timeout "$TOOL_TIMEOUT" "${cmd[@]}" "$@" 2>&1); rc=$?
  CLI_OUT="$out"
  return "$rc"
}

# run_tool <tool> [json-args] — drive one tool via `argent run`.
# Sets: RT_RC (exit code), RT_JSON (stdout only), RT_ERR (stderr), RT_OUT (both).
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

# One JSON object per case appended to $E2E_JSONL: run-e2e.sh derives the totals
# and the exit code from it, so a phase that dies mid-way keeps what it recorded.

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
  printf '%s\n' "  ${C_GRN}✓${C_RST} ${C_DIM}$tool${C_RST} $case" >&2
}
fail() { # phase tool case detail
  local phase="${1:-}" tool="${2:-}" case="${3:-}" detail="${4:-}"
  _record "$phase" "$tool" "$case" "fail" "$detail"
  printf '%s\n' "  ${C_RED}✗${C_RST} $tool ${C_DIM}[$case]${C_RST} $detail" >&2
}
skip() { # phase tool case reason
  local phase="${1:-}" tool="${2:-}" case="${3:-}" detail="${4:-}"
  _record "$phase" "$tool" "$case" "skip" "$detail"
  printf '%s\n' "  ${C_YEL}∼${C_RST} ${C_DIM}$tool ($case): $detail${C_RST}" >&2
}

# One-line summary of the last run_tool call, for a failure detail. A timed-out
# call often leaves RT_OUT empty, and a blank detail is indistinguishable from a
# tool that reported nothing — name the timeout instead. timeout(1) reserves 124
# for a timeout, 125 for its own failure, 126 for a command it cannot invoke and
# 127 for one it cannot find.
rt_detail() { # [max-chars]
  local max="${1:-180}" body
  body="$(printf '%s' "$RT_OUT" | tr '\n' ' ' | sed 's/^ *//; s/ *$//' | cut -c1-"$max")"
  if [ -n "$body" ]; then
    printf 'rc=%s: %s' "$RT_RC" "$body"
    return
  fi
  case "$RT_RC" in
    124) printf 'timed out after %ss, no output' "$TOOL_TIMEOUT" ;;
    125|126|127) printf 'tool never ran (timeout rc=%s)' "$RT_RC" ;;
    *) printf 'rc=%s, no output' "$RT_RC" ;;
  esac
}

assert_ok() { # phase tool case json-args
  local phase="$1" tool="$2" case="$3" args="${4:-}"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -eq 0 ]; then
    pass "$phase" "$tool" "$case"
  else
    fail "$phase" "$tool" "$case" "$(rt_detail 200)"
  fi
}

# Succeeds, and a jq filter over stdout equals `expected`.
assert_field() { # phase tool case json-args jq-filter expected
  local phase="$1" tool="$2" case="$3" args="$4" filter="$5" expected="$6"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -ne 0 ]; then
    fail "$phase" "$tool" "$case" "$(rt_detail 160)"
    return
  fi
  local got; got=$(printf '%s' "$RT_JSON" | jq -r "$filter" 2>/dev/null)
  if [ "$got" = "$expected" ]; then
    pass "$phase" "$tool" "$case" "$filter=$got"
  else
    fail "$phase" "$tool" "$case" "expected $filter=$expected got '$got'"
  fi
}

# Succeeds, and a jq filter over stdout is true.
assert_true() { # phase tool case json-args jq-filter
  local phase="$1" tool="$2" case="$3" args="$4" filter="$5"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -ne 0 ]; then
    fail "$phase" "$tool" "$case" "$(rt_detail 160)"
    return
  fi
  local got; got=$(printf '%s' "$RT_JSON" | jq -r "$filter" 2>/dev/null)
  if [ "$got" = "true" ]; then
    pass "$phase" "$tool" "$case" "$filter"
  else
    fail "$phase" "$tool" "$case" "expected $filter to be true, got '$got'"
  fi
}

# Print the last call's zod issue array, searching stderr then stdout; returns 1
# when neither stream carries one.
zod_issues() {
  local s
  for s in "$RT_ERR" "$RT_JSON"; do
    if printf '%s' "$s" | jq -e 'type=="array" and length>0 and all(.[]; has("path") and has("code"))' >/dev/null 2>&1; then
      printf '%s' "$s"
      return 0
    fi
  done
  return 1
}

# The tool call must FAIL (rc != 0). With `zod-path`, a structured rejection has
# to name that path — one blamed on a different field proves nothing about the
# field the case was built to exercise.
assert_reject() { # phase tool case json-args [zod-path] [zod-code]
  local phase="$1" tool="$2" case="$3" args="$4" zpath="${5:-}" zcode="${6:-}"
  run_tool "$tool" "$args"
  if [ "$RT_RC" -eq 0 ]; then
    fail "$phase" "$tool" "$case" "expected rejection but tool SUCCEEDED"
    return
  fi
  # A timeout, or a timeout(1) failure (125-127), means the schema never judged
  # the input, so it is not a rejection — counting it as one lets a hung server
  # or a broken ARGENT_BIN report a fully green validation tier.
  case "$RT_RC" in
    124) fail "$phase" "$tool" "$case" "timed out after ${TOOL_TIMEOUT}s — no verdict on the input"; return;;
    125|126|127) fail "$phase" "$tool" "$case" "tool never ran (timeout rc=$RT_RC) — no verdict on the input"; return;;
  esac
  if [ -z "$zpath" ]; then
    pass "$phase" "$tool" "$case" "rc=$RT_RC"
    return
  fi
  local issues
  if ! issues="$(zod_issues)"; then
    # A plain service error carries no field attribution; the non-zero exit
    # alone has to stand in for it.
    pass "$phase" "$tool" "$case" "rc=$RT_RC (unstructured)"
    return
  fi
  if printf '%s' "$issues" | jq -e --arg p "$zpath" --arg c "$zcode" \
       'any(.[]; (.path[0] == $p) and ($c=="" or .code==$c))' >/dev/null 2>&1; then
    pass "$phase" "$tool" "$case" "rejected $zpath${zcode:+/$zcode}"
  else
    fail "$phase" "$tool" "$case" "rejected, but no issue names $zpath${zcode:+/$zcode}: $(printf '%s' "$issues" | jq -c '[.[]|{path:.path[0],code}]' 2>/dev/null | cut -c1-140)"
  fi
}

# Private tool-server lifecycle. Isolation is the sandbox HOME alone: the state
# file lands in $E2E_HOME/.argent, so every `argent` call in this run discovers
# our server and no foreign one.

# Is a healthy tool-server discoverable for this install (via ~/.argent state)?
server_running() {
  argent_cli server status --json || return 1
  printf '%s' "$CLI_OUT" | jq -e '.running==true and (.healthy==true or .alive==true)' >/dev/null 2>&1
}

# Ensure a tool-server is up. Neither a port nor ARGENT_TOOLS_URL is pinned: the
# CLI auto-spawns on demand and records the port in the sandbox ~/.argent state,
# so every later `argent` call finds the same server.
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

# Screenshot size floor — an all-zero framebuffer PNG is only ~3-7 KB. Same
# default as scripts/e2e/drive-device.sh.
MIN_SHOT_BYTES="${MIN_SHOT_BYTES:-20000}"

# Capture a screenshot to a file. The CLI renders an image result as a
# "Saved screenshot: <path>" line rather than JSON, so --out is the only
# deterministic path. Returns 0 and sets SHOT_PATH when the file clears the floor.
capture_screenshot() { # udid outfile
  local udid="$1" out="$2" cmd
  read -ra cmd <<< "${ARGENT_BIN:?}"
  # Globals persist: without this a capture that produces no file at all would
  # report the previous success's path and size.
  SHOT_PATH=""; SHOT_SIZE=0; SHOT_RC=0
  rm -f "$out"
  timeout "$TOOL_TIMEOUT" "${cmd[@]}" run screenshot --udid "$udid" --out "$out" >/dev/null 2>&1
  SHOT_RC=$?
  [ -f "$out" ] || return 1
  SHOT_SIZE="$(wc -c <"$out" | tr -d ' ')"
  SHOT_PATH="$out"
  [ "$SHOT_SIZE" -gt "$MIN_SHOT_BYTES" ]
}
