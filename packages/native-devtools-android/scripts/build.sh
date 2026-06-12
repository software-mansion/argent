#!/usr/bin/env bash
# Build native-devtools-android APK for Argent.
# Java sources live in the argent-private submodule at
#   packages/argent-private/packages/native-devtools-android/Sources/AndroidDevtools/
# Mirrors `packages/native-devtools-ios/scripts/build.sh` shape.
#
# Run from the workspace root: bash packages/native-devtools-android/scripts/build.sh
# Or from this package: bash scripts/build.sh
#
# `versionName` and `versionCode` are sourced from manifest.json — bump that
# file in git when releasing a new helper, then rebuild.
#
# Environment:
#   PREBUILT_ANDROID_DEVTOOLS_APK  if set, copy this path to bin/ instead of
#                                  building (used by CI / non-Android-SDK hosts)
#
# Required tools (resolved via $ANDROID_HOME):
#   - javac (system)
#   - $ANDROID_HOME/build-tools/$BUILD_TOOLS/{d8,aapt2,zipalign,apksigner}
#   - $ANDROID_HOME/platforms/android-$COMPILE_SDK/android.jar
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$(cd "${PKG_DIR}/../.." && pwd)"
SUBMODULE_DIR="${WORKSPACE_DIR}/packages/argent-private/packages/native-devtools-android"
SRC_DIR="${SUBMODULE_DIR}/Sources/AndroidDevtools"
BIN_DIR="${PKG_DIR}/bin"
BUILD_DIR="${PKG_DIR}/.build"

VERSION="$(node -p "require('${PKG_DIR}/assets/manifest.json').versionName")"
VERSION_CODE="$(node -p "require('${PKG_DIR}/assets/manifest.json').versionCode")"

APK_OUT="${BIN_DIR}/argent-android-devtools-${VERSION}.apk"
mkdir -p "${BIN_DIR}"

# If a prebuilt APK is provided (CI on a non-Android host, or local PREBUILT
# override), copy it and skip the build pipeline.
if [[ -n "${PREBUILT_ANDROID_DEVTOOLS_APK:-}" ]]; then
  echo "Using prebuilt APK from PREBUILT_ANDROID_DEVTOOLS_APK"
  cp "${PREBUILT_ANDROID_DEVTOOLS_APK}" "${APK_OUT}"
  echo "Done. APK at ${APK_OUT}"
  exit 0
fi

# Verify the submodule is initialised before trying to build.
if [[ ! -d "${SRC_DIR}" ]]; then
  echo "Error: Android source not found at ${SRC_DIR}" >&2
  echo "       Run: git submodule update --init packages/argent-private" >&2
  echo "       Or set PREBUILT_ANDROID_DEVTOOLS_APK=/path/to/argent-android-devtools.apk" >&2
  exit 1
fi

if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -d "${HOME}/Library/Android/sdk" ]]; then
    export ANDROID_HOME="${HOME}/Library/Android/sdk"
  elif [[ -d "${HOME}/Android/Sdk" ]]; then
    export ANDROID_HOME="${HOME}/Android/Sdk"
  else
    echo "ANDROID_HOME is not set and no default SDK location found." >&2
    echo "Set ANDROID_HOME or PREBUILT_ANDROID_DEVTOOLS_APK." >&2
    exit 1
  fi
fi

# Pick the highest-numbered build-tools directory that has d8 + aapt2 + zipalign + apksigner.
BUILD_TOOLS_DIR=""
for candidate in $(ls -1 "${ANDROID_HOME}/build-tools" 2>/dev/null | sort -V -r); do
  bt="${ANDROID_HOME}/build-tools/${candidate}"
  if [[ -x "${bt}/d8" && -x "${bt}/aapt2" && -x "${bt}/zipalign" && -x "${bt}/apksigner" ]]; then
    BUILD_TOOLS_DIR="${bt}"
    break
  fi
done

if [[ -z "${BUILD_TOOLS_DIR}" ]]; then
  echo "Could not locate a build-tools directory under ${ANDROID_HOME}/build-tools that contains d8 + aapt2 + zipalign + apksigner." >&2
  exit 1
fi

# Pick the highest android-XX platform that ships android.jar.
ANDROID_JAR=""
for candidate in $(ls -1 "${ANDROID_HOME}/platforms" 2>/dev/null | sed 's/android-//' | sort -nr); do
  jar="${ANDROID_HOME}/platforms/android-${candidate}/android.jar"
  if [[ -f "${jar}" ]]; then
    ANDROID_JAR="${jar}"
    break
  fi
done

if [[ -z "${ANDROID_JAR}" ]]; then
  echo "Could not locate android.jar under ${ANDROID_HOME}/platforms/android-*/." >&2
  exit 1
fi

# Keystore lives in the submodule. Rotating it requires a major version bump
# because `adb install -r` enforces signature match across upgrades.
KEYSTORE="${SRC_DIR}/debug.keystore"
if [[ ! -f "${KEYSTORE}" ]]; then
  echo "Error: keystore missing from submodule at ${KEYSTORE}" >&2
  exit 1
fi

echo "→ ANDROID_HOME=${ANDROID_HOME}"
echo "→ build-tools=${BUILD_TOOLS_DIR}"
echo "→ android.jar=${ANDROID_JAR}"
echo "→ submodule src=${SRC_DIR}"
echo "→ version=${VERSION} (code ${VERSION_CODE})"

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}/classes" "${BUILD_DIR}/dex"

echo "→ javac"
JAVA_SOURCES=$(find "${SRC_DIR}" -name '*.java')
javac --release 11 \
  -classpath "${ANDROID_JAR}" \
  -d "${BUILD_DIR}/classes" \
  ${JAVA_SOURCES}

echo "→ d8"
"${BUILD_TOOLS_DIR}/d8" \
  --min-api 23 \
  --classpath "${ANDROID_JAR}" \
  --output "${BUILD_DIR}/dex" \
  $(find "${BUILD_DIR}/classes" -name '*.class')

echo "→ aapt2 link"
"${BUILD_TOOLS_DIR}/aapt2" link \
  --manifest "${SRC_DIR}/AndroidManifest.xml" \
  -I "${ANDROID_JAR}" \
  --min-sdk-version 23 \
  --target-sdk-version 36 \
  --version-code "${VERSION_CODE}" \
  --version-name "${VERSION}" \
  -o "${BUILD_DIR}/unsigned.apk"

echo "→ zip classes.dex into APK"
(cd "${BUILD_DIR}/dex" && zip -j -q "${BUILD_DIR}/unsigned.apk" classes.dex)

echo "→ zipalign"
"${BUILD_TOOLS_DIR}/zipalign" -f 4 "${BUILD_DIR}/unsigned.apk" "${BUILD_DIR}/aligned.apk"

echo "→ apksigner"
"${BUILD_TOOLS_DIR}/apksigner" sign \
  --ks "${KEYSTORE}" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "${APK_OUT}" \
  "${BUILD_DIR}/aligned.apk"

echo "→ wrote ${APK_OUT} ($(stat -f%z "${APK_OUT}" 2>/dev/null || stat -c%s "${APK_OUT}") bytes)"

rm -rf "${BUILD_DIR}"
