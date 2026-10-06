#!/usr/bin/env bash
set -euo pipefail

# Downloads signed native binaries from argent-private-releases: the iOS, tvOS
# and TCP dylibs, the ax-service daemons, and the Android helper APK consumed by
# packages/native-devtools-android.
#
# Usage: ./scripts/download-native-binaries.sh [release-tag]
#   release-tag  Tag to download from (e.g. argent-v0.5.3). Defaults to argent-main.
#
# Requires:
#   - gh CLI (no authentication needed — the repo is public)

REPO="software-mansion-labs/argent-private-releases"

TAG="${1:-argent-main}"

if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  echo "Error: release '${TAG}' not found in ${REPO}." >&2
  echo "Build and publish the native binaries for this version first, then retry." >&2
  exit 1
fi

DYLIBS_DIR="packages/native-devtools-ios/dylibs"
BIN_DIR="packages/native-devtools-ios/bin"
# ax-service is macOS-only, and both axServiceBinaryPath() and
# packages/argent/scripts/bundle-tools.cjs read it from bin/darwin/. Written to
# the flat bin/ root it is silently dropped from every release: bundle-tools
# finds nothing under darwin/ and skips the copy (regressed in the Linux-support
# layout migration, #249).
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

# The three tvOS injection dylibs share filenames with the iOS ones, so they
# ship as a tarball extracted into dylibs/tvos/, the directory
# bootstrapDylibPathTvos() reads from; the two daemons have unique names and
# download flat into bin/darwin/.
#
# Pre-Apple-TV-support tags carry no tvOS assets, so a missing one is skipped
# with a warning: `gh release download` exits non-zero on no match, which under
# `set -e` would leave a half-populated tree.
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

# The ios-remote path talks to ax-service and the injected dylibs over AF_INET
# instead of the AF_UNIX sockets the local path uses, so it needs separate
# -DARGENT_USE_TCP=1 builds in bin/tcp/ and dylibs/tcp/
# (axServiceBinaryPathTcp()/bootstrapDylibPathTcp()). Both slots are
# platform-NEUTRAL: these are darwin artifacts run on the *remote* macOS
# orchestrator, so a Linux host must not look under bin/linux/. Like the tvOS
# dylibs they share basenames with the flat iOS ones and ship as a tarball;
# tcp-ax-service has a unique release name.
#
# Pre-sim-remote tags carry no TCP assets, so a missing one is skipped with a
# warning rather than aborting under `set -e`.
TCP_DYLIBS_DIR="${DYLIBS_DIR}/tcp"
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
  # Uniquely named to avoid colliding with the iOS ax-service in the flattened
  # release dir; restore the basename axServiceBinaryPathTcp() expects.
  mv -f "${TCP_BIN_DIR}/tcp-ax-service" "${TCP_BIN_DIR}/ax-service"
  chmod +x "${TCP_BIN_DIR}/ax-service"
else
  echo "  Skipping tcp-ax-service: not present on '${TAG}' (pre-sim-remote-support release)." >&2
fi

echo "  Downloading argent-android-devtools.apk..."
TMP_APK="$(mktemp -t argent-android-devtools.XXXXXX.apk)"
trap 'rm -f "$TMP_APK"' EXIT
gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "argent-android-devtools.apk" \
  --output "${TMP_APK}" \
  --clobber

# bundledHelperApkPath() looks for the manifest's versionName in the filename.
ANDROID_VERSION_NAME="$(node -p "require('$PWD/${ANDROID_MANIFEST_FILE}').versionName")"
ANDROID_TARGET="${ANDROID_BIN_DIR}/argent-android-devtools-${ANDROID_VERSION_NAME}.apk"
mv -f "${TMP_APK}" "${ANDROID_TARGET}"
trap - EXIT

echo "Downloaded native binaries to ${DYLIBS_DIR}/, ${IOS_BIN_DIR}/, and ${ANDROID_BIN_DIR}/"

# A mis-built release can land a tvOS-built dylib in the flat iOS slot. dyld
# silently skips a DYLD_INSERT_LIBRARIES library whose LC_BUILD_VERSION platform
# does not match the process, so injection never happens and nothing errors at
# download, sign or pack time; the native-* tools then report service_stale or
# restart_required and send the agent to fix something that is not broken.
# vtool is macOS-only, so the check is skipped on other hosts.
if command -v vtool &>/dev/null; then
  echo "Verifying dylib platforms..."
  dylib_verify_failed=0
  assert_dylib_platform() {
    local f="$1" want="$2" arch got
    [ -f "$f" ] || return 0  # tvOS/TCP dylibs are absent on older tags
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
    # TCP dylibs are iOS-simulator Mach-Os, so a tvOS slice leaking into
    # dylibs/tcp/ is the same dyld-silent-skip failure.
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
