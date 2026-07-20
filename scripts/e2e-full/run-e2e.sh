#!/usr/bin/env bash
# Full Argent E2E harness — top-level orchestrator.
#
# Starting from ONLY a `swmansion-argent-*.tgz`, this:
#   0. installs from the tarball (global + local), runs init/uninstall/telemetry
#   1. introspects the CLI (help, all 70 `tools describe`, flags, server, link)
#   2. validates every tool's argument schema (missing/enum/type rejection)
#   3. drives a happy-path of every applicable tool against real targets:
#        - Android emulator      (Linux + Mac)
#        - Chromium/Electron app (Linux + Mac)
#        - React-Native debugger/profiler chain against Bluesky (Android)
#
# Everything runs under a sandbox HOME + npm prefix, so it never touches the
# real machine's ~/.argent, MCP configs, or global packages. Results land in
# scripts/e2e-full/results/ as a JSONL log + a markdown report; the process
# exits non-zero if any hard assertion failed.
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

# --------------------------------------------------------------------------
# Defaults / arg parsing
# --------------------------------------------------------------------------
TGZ=""
PHASES=""
SKIP_INSTALL=0
SYSTEM_INSTALL=0
KEEP=0
export E2E_ANDROID_SERIAL="${E2E_ANDROID_SERIAL:-}"
export E2E_ANDROID_AVD="${E2E_ANDROID_AVD:-}"

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tgz) TGZ="$2"; shift 2;;
    --phase|--phases) PHASES="$2"; shift 2;;
    --skip-install) SKIP_INSTALL=1; shift;;
    --system) SYSTEM_INSTALL=1; shift;;
    --android-serial) E2E_ANDROID_SERIAL="$2"; shift 2;;
    --android-avd) E2E_ANDROID_AVD="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    -h|--help) usage 0;;
    *) echo "unknown arg: $1" >&2; usage 1;;
  esac
done

# --------------------------------------------------------------------------
# Locate the tgz (default: newest swmansion-argent-*.tgz at the repo root)
# --------------------------------------------------------------------------
if [ -z "$TGZ" ]; then
  TGZ="$(ls -t "$REPO_ROOT"/swmansion-argent-*.tgz 2>/dev/null | head -1 || true)"
fi
if [ -z "$TGZ" ] || [ ! -f "$TGZ" ]; then
  echo "No tgz found. Pass --tgz PATH or place swmansion-argent-*.tgz at $REPO_ROOT" >&2
  exit 2
fi
TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")"

# --------------------------------------------------------------------------
# Sandbox: private HOME, npm prefix, work dir. Nothing escapes here.
# --------------------------------------------------------------------------
export E2E_WORK="$(mktemp -d "${TMPDIR:-/tmp}/argent-e2e.XXXXXX")"
export E2E_HOME="$E2E_WORK/home"
export E2E_PREFIX="$E2E_WORK/prefix"
export E2E_UNPACKED="$E2E_WORK/unpacked/package"
mkdir -p "$E2E_HOME" "$E2E_PREFIX" "$E2E_WORK/unpacked" "$E2E_WORK/ws"
export E2E_TGZ="$TGZ"
export E2E_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

# Results
RESULTS_DIR="$E2E_ROOT/results"
mkdir -p "$RESULTS_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
export E2E_JSONL="$RESULTS_DIR/e2e-$TS.jsonl"
REPORT_MD="$RESULTS_DIR/report-$TS.md"
: > "$E2E_JSONL"

# Free port for our private tool-server
export E2E_TOOLS_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"

# Remember the real HOME (the RN tier looks for ~/dev/bluesky there) before we
# repoint HOME at the sandbox.
export HOME_REAL="$HOME"
# Redirect argent state/config into the sandbox for the whole run.
export HOME="$E2E_HOME"
# Device state must stay visible through the sandbox HOME, or the android tier
# false-fails on every gesture/screenshot: adb auth keys live in ~/.android, and
# on macOS the emulator writes its gRPC discovery files (avd/running/pid_*.ini)
# under ~/Library/Caches/TemporaryItems, which simulator-server resolves via
# $HOME ("emulator not found among running emulators" otherwise). On Linux that
# discovery uses XDG_RUNTIME_DIR, unaffected by the redirect. Both paths are
# device state, not the argent/editor config this sandbox exists to isolate —
# deliberately NOT ~/Library wholesale, which would expose real editor configs.
[ -d "$HOME_REAL/.android" ] && ln -s "$HOME_REAL/.android" "$E2E_HOME/.android"
if [ "$E2E_OS" = darwin ] && [ -d "$HOME_REAL/Library/Caches/TemporaryItems" ]; then
  mkdir -p "$E2E_HOME/Library/Caches"
  ln -s "$HOME_REAL/Library/Caches/TemporaryItems" "$E2E_HOME/Library/Caches/TemporaryItems"
fi
export PATH="$E2E_PREFIX/bin:$PATH"
# Confine EVERY `npm install -g` (ours AND the ones `argent init/update` runs
# internally) to the sandbox prefix — never the real system global.
if [ "$SYSTEM_INSTALL" -eq 0 ]; then export npm_config_prefix="$E2E_PREFIX"; fi
# Keep telemetry silent/off, and force non-interactive so @clack/prompts in
# `argent init` never blocks on a spinner/TTY probe.
export DO_NOT_TRACK=1
export CI=1

source "$E2E_ROOT/lib/common.sh"
source "$E2E_ROOT/lib/discover-tools.sh"

# --------------------------------------------------------------------------
# Unpack the tarball (used for file-level install assertions + skip-install)
# --------------------------------------------------------------------------
tar xzf "$E2E_TGZ" -C "$E2E_WORK/unpacked"
TGZ_VERSION="$(jq -r .version "$E2E_UNPACKED/package.json")"
export TGZ_VERSION

# --------------------------------------------------------------------------
# Decide the default phase set for this OS if not specified.
# --------------------------------------------------------------------------
if [ -z "$PHASES" ]; then
  case "$E2E_OS" in
    linux)  PHASES="install,introspection,validation,android,chromium,rn";;
    darwin) PHASES="install,introspection,validation,android,chromium,rn";;
    *)      PHASES="install,introspection,validation";;
  esac
fi
selected() { case ",$PHASES," in *",$1,"*) return 0;; *) return 1;; esac; }

# --------------------------------------------------------------------------
# Establish the argent CLI we drive with.
#   default: real sandbox global install (also what phase 0 asserts)
#   --skip-install: run the unpacked bundle directly (fast, offline phases only)
# --------------------------------------------------------------------------
if [ "$SKIP_INSTALL" -eq 1 ]; then
  export ARGENT_BIN="node $E2E_UNPACKED/dist/cli.js"
  read -ra ARGENT_CMD <<< "$ARGENT_BIN"
  warn "skip-install: driving unpacked bundle; phase 'install' will be skipped"
else
  group "Sandbox install: npm i -g $(basename "$E2E_TGZ") --prefix \$E2E_PREFIX"
  # Install optional deps (electron) only if a tier needs them; they add a slow
  # network download and are irrelevant to the offline phases.
  OMIT="--omit=optional"
  if selected chromium || selected rn; then OMIT=""; fi
  if [ "$SYSTEM_INSTALL" -eq 1 ]; then
    warn "--system: installing to the REAL global prefix (release-machine mode)"
    npm install -g "$E2E_TGZ" $OMIT 2>&1 | tail -20 >&2 || true
    export ARGENT_BIN="$(command -v argent || echo "$E2E_PREFIX/bin/argent")"
  else
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

# --------------------------------------------------------------------------
# Run phases. Each phase file defines run_phase() and is executed in-process
# so counters + env accumulate.
# --------------------------------------------------------------------------
run_one() { # phase-name file
  local name="$1" file="$2"
  group "PHASE: $name"
  if [ ! -f "$file" ]; then warn "missing $file"; return; fi
  # shellcheck disable=SC1090
  source "$file"
  run_phase || warn "phase $name returned non-zero (continuing)"
}

if [ "$SKIP_INSTALL" -eq 0 ] && selected install;      then run_one install       "$E2E_ROOT/phases/00-install.sh"; fi
if selected introspection; then run_one introspection "$E2E_ROOT/phases/10-introspection.sh"; fi
if selected validation;    then run_one validation    "$E2E_ROOT/phases/20-validation.sh"; fi
if selected android;       then run_one android       "$E2E_ROOT/phases/30-android.sh"; fi
if selected chromium;      then run_one chromium      "$E2E_ROOT/phases/40-chromium.sh"; fi
if selected rn;            then run_one rn            "$E2E_ROOT/phases/50-rn-bluesky.sh"; fi

run_one cleanup "$E2E_ROOT/phases/90-cleanup.sh"

# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------
group "Generating report"
E2E_JSONL="$E2E_JSONL" TGZ_VERSION="$TGZ_VERSION" E2E_OS="$E2E_OS" ARGENT_BIN="$ARGENT_BIN" \
  python3 "$E2E_ROOT/lib/report.py" "$E2E_JSONL" > "$REPORT_MD" || warn "report generation failed"
cat "$REPORT_MD" >&2 || true

TOTAL_FAIL=$(jq -s '[.[]|select(.status=="fail")]|length' "$E2E_JSONL")
TOTAL_PASS=$(jq -s '[.[]|select(.status=="pass")]|length' "$E2E_JSONL")
TOTAL_SKIP=$(jq -s '[.[]|select(.status=="skip")]|length' "$E2E_JSONL")

if [ "$KEEP" -eq 1 ]; then
  warn "--keep: leaving sandbox at $E2E_WORK"
else
  rm -rf "$E2E_WORK"
fi

group "DONE — pass:$TOTAL_PASS fail:$TOTAL_FAIL skip:$TOTAL_SKIP"
echo "report: $REPORT_MD" >&2
[ "$TOTAL_FAIL" -eq 0 ]
