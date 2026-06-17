#!/usr/bin/env bash
# Build the iOS-profiling native capture binaries (macOS only — iOS Simulator
# profiling is darwin-only, like the rest of native-devtools-ios).
#
# Run from the workspace root:  bash packages/argent-ios-profiling/scripts/build.sh
# Or from this package:         bash scripts/build.sh
#
# Output: bin/darwin/ios-profiler-capture  (coreprofilesessiontap → kdebug stream)
#         bin/darwin/ios-profiler-mem      (sysmontap → per-process footprint/RSS)
#
# Environment:
#   PREBUILT_IOS_PROFILER_BIN_DIR - if set, copy binaries from here instead of
#                                   building (CI on non-macOS hosts).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/bin/darwin"
mkdir -p "$OUT"

if [[ -n "${PREBUILT_IOS_PROFILER_BIN_DIR:-}" ]]; then
  echo "copying prebuilt binaries from $PREBUILT_IOS_PROFILER_BIN_DIR"
  cp "$PREBUILT_IOS_PROFILER_BIN_DIR"/ios-profiler-* "$OUT/"
  exit 0
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "error: native build requires macOS (set PREBUILT_IOS_PROFILER_BIN_DIR on CI)" >&2
  exit 1
fi

CFLAGS=(-fno-objc-arc -fobjc-exceptions -O2 -I"$DIR/objc_src" -framework Foundation -framework Security)

echo "building ios-profiler-capture ..."
clang "${CFLAGS[@]}" -o "$OUT/ios-profiler-capture" "$DIR/objc_src/capture.m"

echo "building ios-profiler-mem ..."
clang "${CFLAGS[@]}" -o "$OUT/ios-profiler-mem" "$DIR/objc_src/simmem.m"

echo "done -> $OUT"
