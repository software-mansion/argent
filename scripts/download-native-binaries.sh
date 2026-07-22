#!/usr/bin/env bash
set -euo pipefail

# Downloads signed native binaries from argent-private-releases:
#   - iOS dylibs + ax-service
#   - Android argent-android-devtools.apk (helper APK consumed by
#     packages/native-devtools-android)
#
# The host-side Perfetto trace processor is no longer a native binary: it ships
# as a single ~13 MB `trace_processor.wasm` vendored into the repo
# (packages/native-devtools-android/assets/trace-processor/), so there is nothing
# to download for it here.
#
# Usage: ./scripts/download-native-binaries.sh [release-tag]
#   release-tag  Tag to download from (e.g. argent-v0.5.3). Defaults to argent-main.
#
# Requires:
#   - gh CLI (no authentication needed — the repo is public)

REPO="software-mansion-labs/argent-private-releases"

TAG="${1:-argent-main}"

# Verify the release exists before attempting downloads.
if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  echo "Error: release '${TAG}' not found in ${REPO}." >&2
  echo "Build and publish the native binaries for this version first, then retry." >&2
  exit 1
fi

DYLIBS_DIR="packages/native-devtools-ios/dylibs"
BIN_DIR="packages/native-devtools-ios/bin"
# ax-service is macOS-only (it spawns inside an iOS Simulator), so it lives
# under the darwin/ host-platform subdirectory — matching what
# axServiceBinaryPath() resolves (bin/<platform>/ax-service) and what
# packages/argent/scripts/bundle-tools.cjs copies into the published package
# (bin/darwin/ax-service). Writing it to the flat bin/ root instead silently
# drops it from every release: bundle-tools looks under darwin/, finds nothing,
# and skips the copy, so describe's ax-service path is unusable (regressed in
# the Linux-support layout migration, #249).
IOS_BIN_DIR="${BIN_DIR}/darwin"
ANDROID_BIN_DIR="packages/native-devtools-android/bin"
ANDROID_MANIFEST_FILE="packages/native-devtools-android/assets/manifest.json"

echo "Downloading native binaries from ${REPO} (tag: ${TAG})..."

mkdir -p "${DYLIBS_DIR}" "${BIN_DIR}" "${IOS_BIN_DIR}" "${ANDROID_BIN_DIR}"

for DYLIB in libNativeDevtoolsIos.dylib libKeyboardPatch.dylib libArgentInjectionBootstrap.dylib; do
  echo "  Downloading ${DYLIB}..."
  gh release download "${TAG}" \
    --repo "${REPO}" \
    --pattern "${DYLIB}" \
    --dir "${DYLIBS_DIR}" \
    --clobber
done

echo "  Downloading ax-service..."
gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "ax-service" \
  --dir "${IOS_BIN_DIR}" \
  --clobber
chmod +x "${IOS_BIN_DIR}/ax-service"

# argent-device-auth is the macOS host helper that shows the branded admin
# prompt to start the physical-iOS CoreDevice tunnel as root. Like ax-service it
# is a darwin-only binary, resolved at bin/darwin/argent-device-auth.
# Optional: until the argent-private build publishes it, the release won't carry
# it — physical-iOS then falls back to the (unbranded) osascript admin prompt,
# so a missing asset must not fail the whole download.
echo "  Downloading argent-device-auth..."
if gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "argent-device-auth" \
  --dir "${IOS_BIN_DIR}" \
  --clobber 2>/dev/null; then
  chmod +x "${IOS_BIN_DIR}/argent-device-auth"
else
  echo "    (not in this release yet — physical iOS will use the osascript prompt fallback)"
fi

# tvOS binaries (Apple TV support). The three tvOS injection dylibs share their
# filenames with the iOS dylibs, so the release ships them as a tarball
# (native-devtools-ios-tvos-dylibs.tar.gz) that we extract into dylibs/tvos/ —
# the directory bootstrapDylibPathTvos() reads from. The two daemons
# (tvos-ax-service spawned in-sim, tvos-hid-daemon on the host) have unique
# names and download flat into bin/darwin/.
#
# These assets only exist on releases built with TV support. A pre-TV-support
# tag (the optional [release-tag] arg lets you pull older releases) simply has
# no tvOS artifacts, so a missing asset is skipped with a warning rather than
# aborting the whole download (`gh release download` exits non-zero on no match,
# which under `set -e` would otherwise leave a half-populated tree).
TVOS_DYLIBS_DIR="${DYLIBS_DIR}/tvos"
mkdir -p "${TVOS_DYLIBS_DIR}"

echo "  Downloading tvOS dylibs..."
TMP_TVOS_DYLIBS="$(mktemp -t native-devtools-ios-tvos-dylibs.XXXXXX.tar.gz)"
if gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "native-devtools-ios-tvos-dylibs.tar.gz" \
  --output "${TMP_TVOS_DYLIBS}" \
  --clobber; then
  tar -xzf "${TMP_TVOS_DYLIBS}" -C "${TVOS_DYLIBS_DIR}"
else
  echo "  Skipping tvOS dylibs: not present on '${TAG}' (pre-Apple-TV-support release)." >&2
fi
rm -f "${TMP_TVOS_DYLIBS}"

echo "  Downloading tvos-ax-service..."
if gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "tvos-ax-service" \
  --dir "${IOS_BIN_DIR}" \
  --clobber; then
  chmod +x "${IOS_BIN_DIR}/tvos-ax-service"
else
  echo "  Skipping tvos-ax-service: not present on '${TAG}' (pre-Apple-TV-support release)." >&2
fi

echo "  Downloading tvos-hid-daemon..."
if gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "tvos-hid-daemon" \
  --dir "${IOS_BIN_DIR}" \
  --clobber; then
  chmod +x "${IOS_BIN_DIR}/tvos-hid-daemon"
else
  echo "  Skipping tvos-hid-daemon: not present on '${TAG}' (pre-Apple-TV-support release)." >&2
fi

# TCP-transport iOS binaries (sim-remote / ios-remote support). The remote
# (ios-remote) code path spawns the ax-service and injects the native-devtools
# dylibs over a TCP socket tunnelled by sim-remote, rather than the AF_UNIX
# sockets the local path uses — so it needs -DARGENT_USE_TCP=1 builds kept in a
# separate tcp/ slot (axServiceBinaryPathTcp()/bootstrapDylibPathTcp() read from
# bin/tcp/ and dylibs/tcp/). Both are platform-NEUTRAL: these are darwin/iOS-sim
# artifacts uploaded to and run on the *remote* macOS orchestrator, so they must
# resolve from any host platform (a Linux host must not look under bin/linux/).
# Like the tvOS dylibs, the three TCP dylibs share basenames with the flat iOS
# dylibs, so they ship as a tarball extracted into dylibs/tcp/; tcp-ax-service
# has a unique release name and lands flat as bin/tcp/ax-service.
#
# These assets only exist on releases built with TCP support. A pre-sim-remote
# tag simply has no TCP artifacts, so a missing asset is skipped with a warning
# rather than aborting the whole download (`gh release download` exits non-zero
# on no match, which under `set -e` would otherwise leave a half-populated tree).
TCP_DYLIBS_DIR="${DYLIBS_DIR}/tcp"
# Platform-neutral (bin/tcp, not bin/darwin/tcp): see the comment above.
TCP_BIN_DIR="${BIN_DIR}/tcp"
mkdir -p "${TCP_DYLIBS_DIR}" "${TCP_BIN_DIR}"

echo "  Downloading TCP dylibs..."
TMP_TCP_DYLIBS="$(mktemp -t native-devtools-ios-tcp-dylibs.XXXXXX.tar.gz)"
if gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "native-devtools-ios-tcp-dylibs.tar.gz" \
  --output "${TMP_TCP_DYLIBS}" \
  --clobber; then
  tar -xzf "${TMP_TCP_DYLIBS}" -C "${TCP_DYLIBS_DIR}"
else
  echo "  Skipping TCP dylibs: not present on '${TAG}' (pre-sim-remote-support release)." >&2
fi
rm -f "${TMP_TCP_DYLIBS}"

echo "  Downloading tcp-ax-service..."
if gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "tcp-ax-service" \
  --dir "${TCP_BIN_DIR}" \
  --clobber; then
  # Uploaded under a unique name to avoid colliding with the iOS ax-service in
  # the flattened release dir; restore the basename the runtime resolver expects.
  mv -f "${TCP_BIN_DIR}/tcp-ax-service" "${TCP_BIN_DIR}/ax-service"
  chmod +x "${TCP_BIN_DIR}/ax-service"
else
  echo "  Skipping tcp-ax-service: not present on '${TAG}' (pre-sim-remote-support release)." >&2
fi

echo "  Downloading argent-android-devtools.apk..."
# The release publishes the APK under a stable name (no versioning in the
# filename) so this script doesn't have to know the version ahead of time;
# the local copy is renamed to match what manifest.json expects.
TMP_APK="$(mktemp -t argent-android-devtools.XXXXXX.apk)"
trap 'rm -f "$TMP_APK"' EXIT
gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "argent-android-devtools.apk" \
  --output "${TMP_APK}" \
  --clobber

# Read the versionName from the local manifest so the filename matches
# bundledHelperApkPath()'s expectation.
ANDROID_VERSION_NAME="$(node -p "require('$PWD/${ANDROID_MANIFEST_FILE}').versionName")"
ANDROID_TARGET="${ANDROID_BIN_DIR}/argent-android-devtools-${ANDROID_VERSION_NAME}.apk"
mv -f "${TMP_APK}" "${ANDROID_TARGET}"
trap - EXIT

echo "Downloaded native binaries to ${DYLIBS_DIR}/, ${IOS_BIN_DIR}/, and ${ANDROID_BIN_DIR}/"

# Verify the downloaded injection dylibs carry the expected Mach-O platform.
# This is the exact failure a mis-built release can reintroduce: a tvOS-built
# libArgentInjectionBootstrap.dylib landing in the flat iOS slot. dyld silently
# skips a DYLD_INSERT_LIBRARIES library whose LC_BUILD_VERSION platform does not
# match the process, so native-devtools never injects on an iOS simulator and
# every native-* tool returns restart_required — with no error at download,
# sign, or pack time. Fail loudly here rather than bundle a dead dylib.
# vtool is macOS-only; on hosts without it (non-macOS) the check is skipped.
if command -v vtool &>/dev/null; then
  echo "Verifying dylib platforms..."
  dylib_verify_failed=0
  assert_dylib_platform() { # <file> <expected-platform>
    local f="$1" want="$2" arch got
    [ -f "$f" ] || return 0  # tvOS dylibs are absent on pre-Apple-TV tags
    for arch in arm64 x86_64; do
      got="$(vtool -arch "$arch" -show-build "$f" 2>/dev/null | awk '/platform/{print $2}')"
      if [ "$got" != "$want" ]; then
        echo "  ERROR: ${f} (${arch}) is '${got:-<none>}', expected ${want}" >&2
        dylib_verify_failed=1
      fi
    done
  }
  for d in libNativeDevtoolsIos libKeyboardPatch libArgentInjectionBootstrap; do
    assert_dylib_platform "${DYLIBS_DIR}/${d}.dylib" IOSSIMULATOR
    assert_dylib_platform "${TVOS_DYLIBS_DIR}/${d}.dylib" TVOSSIMULATOR
    # TCP dylibs are iOS-simulator Mach-Os (same SDK, -DARGENT_USE_TCP=1), so a
    # tvOS slice leaking into dylibs/tcp/ is the same dyld-silent-skip failure.
    assert_dylib_platform "${TCP_DYLIBS_DIR}/${d}.dylib" IOSSIMULATOR
  done
  if [ "${dylib_verify_failed}" -ne 0 ]; then
    echo "Dylib platform verification failed for release '${TAG}'. The release" >&2
    echo "shipped a mis-platformed dylib (see above) — refusing to use it. Fix" >&2
    echo "the build-native-binaries workflow / re-publish the release, then retry." >&2
    exit 1
  fi
  echo "Dylib platforms OK (iOS/TCP=IOSSIMULATOR, tvOS=TVOSSIMULATOR where present)."
fi

if command -v codesign &>/dev/null; then
  for f in \
    "${DYLIBS_DIR}"/*.dylib \
    "${TVOS_DYLIBS_DIR}"/*.dylib \
    "${TCP_DYLIBS_DIR}"/*.dylib \
    "${IOS_BIN_DIR}/ax-service" \
    "${IOS_BIN_DIR}/argent-device-auth" \
    "${IOS_BIN_DIR}/tvos-ax-service" \
    "${IOS_BIN_DIR}/tvos-hid-daemon" \
    "${TCP_BIN_DIR}/ax-service"; do
    [ -f "$f" ] || continue
    codesign -dvv "$f" 2>&1 || echo "Warning: signature verification failed for $f"
  done
fi

if command -v "${ANDROID_HOME:-${HOME}/Library/Android/sdk}/build-tools/36.0.0/apksigner" &>/dev/null; then
  "${ANDROID_HOME:-${HOME}/Library/Android/sdk}/build-tools/36.0.0/apksigner" verify --verbose "${ANDROID_TARGET}" 2>&1 \
    || echo "Warning: APK signature verification failed"
fi
