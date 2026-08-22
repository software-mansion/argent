#!/usr/bin/env bash
# Full Argent E2E harness — top-level orchestrator.
#
# Starting from ONLY a `swmansion-argent-*.tgz`, this:
#   0. installs from the tarball (global + local), runs init/uninstall
#   1. introspects the CLI (help, a `tools describe` per published tool, flags,
#      telemetry, server, link)
#   2. validates every tool's argument schema (missing/enum/type rejection)
#   3. drives a happy-path of every applicable tool against real targets:
#        - Android emulator      (Linux + Mac)
#        - Chromium/Electron app (Linux + Mac)
#        - React-Native debugger/profiler chain against Bluesky (Android)
#
# Unless --system is given, everything runs under a sandbox HOME + npm prefix
# and leaves the real ~/.argent, MCP configs and global packages alone. Results
# land in scripts/e2e-full/results/ as a JSONL log + a markdown report; the
# process exits non-zero if any hard assertion failed.
#
# Usage:
#   run-e2e.sh [--tgz PATH] [--phase a,b,c] [--skip-install] [--system]
#              [--android-serial S | --android-avd NAME] [--keep] [-h]
#
# Phases: install introspection validation android chromium rn
#   (default: all that apply to this OS; iOS/tvOS/Vega are intentionally omitted)
set -uo pipefail

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$E2E_ROOT/../.." && pwd)"

TGZ=""
PHASES=""
SKIP_INSTALL=0
SYSTEM_INSTALL=0
KEEP=0
export E2E_ANDROID_SERIAL="${E2E_ANDROID_SERIAL:-}"
export E2E_ANDROID_AVD="${E2E_ANDROID_AVD:-}"

# Help text is the header block above. Stopping at the first non-comment line
# means it can never drift into printing code, the way a pinned range would.
usage() { sed -n '2,${/^#/!q; s/^# \{0,1\}//; p;}' "${BASH_SOURCE[0]}"; exit "${1:-0}"; }

# Without this, a value-taking flag given without its value reads an unset $2
# and dies on "unbound variable" instead of printing usage.
need_val() { [ "$1" -ge 2 ] || { echo "$2 needs a value" >&2; usage 1; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tgz) need_val $# "$1"; TGZ="$2"; shift 2;;
    --phase|--phases) need_val $# "$1"; PHASES="$2"; shift 2;;
    --skip-install) SKIP_INSTALL=1; shift;;
    --system) SYSTEM_INSTALL=1; shift;;
    --android-serial) need_val $# "$1"; E2E_ANDROID_SERIAL="$2"; shift 2;;
    --android-avd) need_val $# "$1"; E2E_ANDROID_AVD="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    -h|--help) usage 0;;
    *) echo "unknown arg: $1" >&2; usage 1;;
  esac
done

# A misspelled phase would otherwise select nothing, and a run that executes no
# phase records no failure: "pass:0 fail:0" and exit 0 for an untested release.
ALL_PHASES="install introspection validation android chromium rn"
for _p in ${PHASES//,/ }; do
  case " $ALL_PHASES " in
    *" $_p "*) ;;
    *) echo "unknown phase: $_p (known: $ALL_PHASES)" >&2; exit 2;;
  esac
done
unset _p

if [ -z "$TGZ" ]; then
  TGZ="$(ls -t "$REPO_ROOT"/swmansion-argent-*.tgz 2>/dev/null | head -1 || true)"
fi
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "No tgz found. Pass --tgz PATH or place swmansion-argent-*.tgz at $REPO_ROOT" >&2
  exit 2
fi
TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")"

export E2E_WORK="$(mktemp -d "${TMPDIR:-/tmp}/argent-e2e.XXXXXX")"
export E2E_HOME="$E2E_WORK/home"
export E2E_PREFIX="$E2E_WORK/prefix"
export E2E_UNPACKED="$E2E_WORK/unpacked/package"
mkdir -p "$E2E_HOME" "$E2E_PREFIX" "$E2E_WORK/unpacked" "$E2E_WORK/ws"
export E2E_TGZ="$TGZ"
export E2E_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

RESULTS_DIR="$E2E_ROOT/results"
mkdir -p "$RESULTS_DIR"
# The pid disambiguates two runs started in the same second: they would share
# one results file and each compute its exit code over the other's cases too.
TS="$(date +%Y%m%d-%H%M%S)-$$"
export E2E_JSONL="$RESULTS_DIR/e2e-$TS.jsonl"
REPORT_MD="$RESULTS_DIR/report-$TS.md"
: > "$E2E_JSONL"

# Sourced before the EXIT trap below, so finish() has group/warn/err if it fires.
source "$E2E_ROOT/lib/common.sh"
source "$E2E_ROOT/lib/discover-tools.sh"

# Teardown. Installed as soon as the sandbox and the results log exist, because
# every exit path other than the happy one has to reach it: an unbound variable
# inside a phase, a Ctrl-C, or the early `exit 3` below would otherwise leave the
# sandbox behind with the run's results never rendered.
# ARGENT_BIN and TGZ_VERSION are read defensively — an abort can happen before
# either is assigned.
E2E_COMPLETED=0
CLEANUP_RAN=0
finish() {
  local rc=$?
  trap - EXIT INT TERM

  # Processes first, sandbox second. The tool-server's state file lives in
  # $E2E_HOME and ensure_server starts it with no idle timeout, so removing the
  # sandbox first strands a server `argent server stop` can no longer find,
  # along with any Electron, Metro and fixture server the tiers spawned.
  # ARGENT_BIN has to be set before cleanup can run: argent_cli resolves it with
  # ${ARGENT_BIN:?}, which exits the shell outright — from in here that would
  # abandon the rest of this handler and leak the sandbox it exists to remove.
  if [ "$CLEANUP_RAN" -eq 0 ] && [ -n "${ARGENT_BIN:-}" ] && declare -F run_one >/dev/null 2>&1; then
    CLEANUP_RAN=1
    run_one cleanup "$E2E_ROOT/phases/90-cleanup.sh" || true
  fi

  group "Generating report"
  E2E_JSONL="$E2E_JSONL" TGZ_VERSION="${TGZ_VERSION:-unknown}" E2E_OS="$E2E_OS" \
    ARGENT_BIN="${ARGENT_BIN:-}" \
    python3 "$E2E_ROOT/lib/report.py" "$E2E_JSONL" > "$REPORT_MD" || warn "report generation failed"
  cat "$REPORT_MD" >&2 || true

  local tp tf ts
  tp=$(jq -s '[.[]|select(.status=="pass")]|length' "$E2E_JSONL" 2>/dev/null || echo 0)
  tf=$(jq -s '[.[]|select(.status=="fail")]|length' "$E2E_JSONL" 2>/dev/null || echo 0)
  ts=$(jq -s '[.[]|select(.status=="skip")]|length' "$E2E_JSONL" 2>/dev/null || echo 0)

  if [ "$KEEP" -eq 1 ]; then
    warn "--keep: leaving sandbox at $E2E_WORK"
  else
    rm -rf "$E2E_WORK"
  fi

  group "DONE — pass:$tp fail:$tf skip:$ts"
  echo "report: $REPORT_MD" >&2

  # A run that stopped early is not a pass: the phases it never reached cannot
  # have failed.
  if [ "$E2E_COMPLETED" -eq 0 ]; then
    err "harness stopped before finishing its phase list — these results are PARTIAL"
    [ "$rc" -ne 0 ] && exit "$rc"
    exit 1
  fi
  [ "$tf" -eq 0 ] || exit 1
  exit 0
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export E2E_TOOLS_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"

# The RN tier looks for the Bluesky checkout under the real HOME.
export HOME_REAL="$HOME"
export HOME="$E2E_HOME"
# Device state must stay visible through the sandbox HOME or the android tier
# false-fails on every gesture/screenshot: adb auth keys live in ~/.android, and
# on macOS the emulator writes its gRPC discovery files under
# ~/Library/Caches/TemporaryItems, which simulator-server resolves via $HOME.
# Linux uses XDG_RUNTIME_DIR for that discovery and is unaffected. Deliberately
# not ~/Library wholesale, which would expose the real editor configs.
[ -d "$HOME_REAL/.android" ] && ln -s "$HOME_REAL/.android" "$E2E_HOME/.android"
if [ "$E2E_OS" = darwin ] && [ -d "$HOME_REAL/Library/Caches/TemporaryItems" ]; then
  mkdir -p "$E2E_HOME/Library/Caches"
  ln -s "$HOME_REAL/Library/Caches/TemporaryItems" "$E2E_HOME/Library/Caches/TemporaryItems"
fi
export PATH="$E2E_PREFIX/bin:$PATH"
# Confine every `npm install -g` — ours and the ones `argent init/update` runs
# internally — to the sandbox prefix.
if [ "$SYSTEM_INSTALL" -eq 0 ]; then export npm_config_prefix="$E2E_PREFIX"; fi
export DO_NOT_TRACK=1
export CI=1

# The file-level install assertions and --skip-install run off the unpacked copy.
tar xzf "$E2E_TGZ" -C "$E2E_WORK/unpacked"
TGZ_VERSION="$(jq -r .version "$E2E_UNPACKED/package.json")"
export TGZ_VERSION

if [ -z "$PHASES" ]; then
  case "$E2E_OS" in
    linux)  PHASES="install,introspection,validation,android,chromium,rn";;
    darwin) PHASES="install,introspection,validation,android,chromium,rn";;
    *)      PHASES="install,introspection,validation";;
  esac
fi
selected() { case ",$PHASES," in *",$1,"*) return 0;; *) return 1;; esac; }

# The check above walks the words a phase list splits into, so a list that splits
# into none — `--phase ,` or `--phase ' '` — passes it while selecting nothing.
# Count what `selected` actually matches instead.
_selected=0
for _p in $ALL_PHASES; do selected "$_p" && _selected=$((_selected + 1)); done
if [ "$_selected" -eq 0 ]; then
  echo "no phases selected from '$PHASES' (known: $ALL_PHASES)" >&2
  exit 2
fi
unset _p _selected

if [ "$SKIP_INSTALL" -eq 1 ]; then
  export ARGENT_BIN="node $E2E_UNPACKED/dist/cli.js"
  read -ra ARGENT_CMD <<< "$ARGENT_BIN"
  warn "skip-install: driving unpacked bundle; phase 'install' will be skipped"
else
  group "Sandbox install: npm i -g $(basename "$E2E_TGZ") --prefix \$E2E_PREFIX"
  # The optional deps (electron, node-pty) are a slow network download and only
  # the device tiers need them.
  OMIT="--omit=optional"
  if selected chromium || selected rn; then OMIT=""; fi
  # The install phase restores the driver with these after its uninstall test;
  # different flags would silently change what the rest of the run tests.
  export E2E_NPM_OMIT="$OMIT"
  if [ "$SYSTEM_INSTALL" -eq 1 ]; then
    warn "--system: installing to the REAL global prefix (release-machine mode)"
    export E2E_NPM_PREFIX_ARGS=""
    npm install -g "$E2E_TGZ" $OMIT 2>&1 | tail -20 >&2 || true
    export ARGENT_BIN="$(command -v argent || echo "$E2E_PREFIX/bin/argent")"
  else
    export E2E_NPM_PREFIX_ARGS="--prefix $E2E_PREFIX"
    npm install -g "$E2E_TGZ" --prefix "$E2E_PREFIX" $OMIT 2>&1 | tail -20 >&2 || true
    export ARGENT_BIN="$E2E_PREFIX/bin/argent"
  fi
  read -ra ARGENT_CMD <<< "$ARGENT_BIN"
  if [ ! -x "${ARGENT_CMD[0]}" ] && [ "${ARGENT_CMD[0]}" != "node" ]; then
    err "argent binary not found at $ARGENT_BIN after install"
    exit 3
  fi
fi
log "Driving with: $ARGENT_BIN  (v${TGZ_VERSION})"
log "Sandbox: $E2E_WORK"
log "Results: $E2E_JSONL"

# Each phase file defines run_phase() and is sourced in-process, so counters and
# env accumulate across phases.
run_one() { # phase-name file
  local name="$1" file="$2"
  group "PHASE: $name"
  if [ ! -f "$file" ]; then fail "$name" harness phase-file "missing $file"; return; fi
  # `source` on a file with a syntax error leaves the previous run_phase bound,
  # and that phase would run again with its results recorded under this name.
  unset -f run_phase
  # shellcheck disable=SC1090
  source "$file"
  if ! declare -F run_phase >/dev/null; then
    fail "$name" harness phase-load "$file defined no run_phase (syntax error?)"
    return
  fi
  run_phase || warn "phase $name returned non-zero (continuing)"
}

if [ "$SKIP_INSTALL" -eq 0 ] && selected install;      then run_one install       "$E2E_ROOT/phases/00-install.sh"; fi
if selected introspection; then run_one introspection "$E2E_ROOT/phases/10-introspection.sh"; fi
if selected validation;    then run_one validation    "$E2E_ROOT/phases/20-validation.sh"; fi
if selected android;       then run_one android       "$E2E_ROOT/phases/30-android.sh"; fi
if selected chromium;      then run_one chromium      "$E2E_ROOT/phases/40-chromium.sh"; fi
if selected rn;            then run_one rn            "$E2E_ROOT/phases/50-rn-bluesky.sh"; fi

# Every selected phase ran. The EXIT trap does cleanup, report and exit code —
# the same path an aborted run takes, so teardown cannot depend on getting here.
E2E_COMPLETED=1
