#!/usr/bin/env bash

# Build native-devtools-ios dylibs for Argent.
# ObjC source lives in the argent-private submodule at packages/argent-private.
# Run from the workspace root: bash packages/native-devtools-ios/scripts/build.sh [dev|release]
# Or from this package: bash scripts/build.sh [dev|release]
#
# Usage: build.sh [dev|release]
#   mode: dev (fast) or release (optimized, optional signing). Default: release.
#
# Environment:
#   PREBUILT_NATIVE_DEVTOOLS_IOS  - if set, copy this path to dylibs/ instead of building (CI on non-macOS)
#   PREBUILT_KEYBOARD_PATCH       - same for keyboard patch dylib
#   PREBUILT_INJECTION_BOOTSTRAP  - same for bootstrap dylib
#   Release signing: set IDENTITY (or CODESIGN_IDENTITY), or for CI keychain import set
#     CERTIFICATE, PRIVATE_KEY_BASE64, PRIVATE_KEY_PASSWORD, KEYCHAIN_PASSWORD, IDENTITY.

set -euo pipefail

MODE="${1:-release}"

if [[ "$MODE" != "dev" && "$MODE" != "release" ]]; then
  echo "Usage: build.sh [dev|release]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$(cd "${ROOT_DIR}/../.." && pwd)"
SUBMODULE_DIR="${WORKSPACE_DIR}/packages/argent-private/packages/native-devtools-ios"
SRC_DIR="${SUBMODULE_DIR}/Sources/NativeDevtoolsIos"
DEST_DIR="${ROOT_DIR}/dylibs"

# Verify the submodule is initialised before trying to build.
if [[ ! -d "${SRC_DIR}" ]]; then
  echo "Error: ObjC source not found at ${SRC_DIR}" >&2
  echo "       Run: git submodule update --init packages/argent-private" >&2
  exit 1
fi

DEST_FILE="${DEST_DIR}/libNativeDevtoolsIos.dylib"
DEST_FILE_KB="${DEST_DIR}/libKeyboardPatch.dylib"
DEST_FILE_BS="${DEST_DIR}/libInjectionBootstrap.dylib"

# If pre-built dylibs are provided, copy them and exit.
if [[ -n "${PREBUILT_NATIVE_DEVTOOLS_IOS:-}" ]] && [[ -n "${PREBUILT_KEYBOARD_PATCH:-}" ]] && [[ -n "${PREBUILT_INJECTION_BOOTSTRAP:-}" ]]; then
  echo "Using pre-built dylibs"
  mkdir -p "$DEST_DIR"
  cp "$PREBUILT_NATIVE_DEVTOOLS_IOS" "$DEST_FILE"
  cp "$PREBUILT_KEYBOARD_PATCH" "$DEST_FILE_KB"
  cp "$PREBUILT_INJECTION_BOOTSTRAP" "$DEST_FILE_BS"
  exit 0
fi

# On non-macOS we cannot build.
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "Skipping native-devtools-ios build on non-macOS host ($OSTYPE)"
  exit 0
fi

# In release mode, set up keychain for CI signing when secrets are present.
if [[ "$MODE" == "release" && -n "${CERTIFICATE:-}" && -n "${PRIVATE_KEY_BASE64:-}" ]]; then
  KEYCHAIN_PATH="${KEYCHAIN_PATH:-${TMPDIR:-/tmp}/codesign.keychain-db}"
  security create-keychain -p "${KEYCHAIN_PASSWORD:?}" "$KEYCHAIN_PATH"
  security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
  security unlock-keychain -p "${KEYCHAIN_PASSWORD:?}" "$KEYCHAIN_PATH"
  CERTIFICATE_PATH="${TMPDIR:-/tmp}/certificate.pem"
  PRIVATE_KEY_PATH="${TMPDIR:-/tmp}/private_key.p12"
  echo -n "$CERTIFICATE" >"$CERTIFICATE_PATH"
  echo -n "$PRIVATE_KEY_BASE64" | base64 --decode -o "$PRIVATE_KEY_PATH"
  security import "$CERTIFICATE_PATH" -A -t cert -f pemseq -k "$KEYCHAIN_PATH"
  security import "$PRIVATE_KEY_PATH" -A -t priv -f pkcs12 -P "${PRIVATE_KEY_PASSWORD:?}" -k "$KEYCHAIN_PATH"
  security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
  security list-keychain -d user -s "$KEYCHAIN_PATH"
  export IDENTITY="${IDENTITY:?}"
fi

mkdir -p "$DEST_DIR"
SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"

EXTRA_CFLAGS=()
if [[ "$MODE" == "release" ]]; then
  EXTRA_CFLAGS=(-Os -DNDEBUG)
fi

echo "Building libNativeDevtoolsIos.dylib..."
xcrun --sdk iphonesimulator clang \
  -dynamiclib \
  -fobjc-arc \
  -fmodules \
  ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
  -isysroot "${SDK_PATH}" \
  -mios-simulator-version-min=13.0 \
  -arch arm64 \
  -arch x86_64 \
  -framework Foundation \
  -framework UIKit \
  "${SRC_DIR}/InjectionEntry.m" \
  "${SRC_DIR}/DevtoolsConnection.m" \
  "${SRC_DIR}/NetworkInspector.m" \
  "${SRC_DIR}/BodyStreamForwarder.m" \
  "${SRC_DIR}/NativeDevtoolsURLProtocol.m" \
  "${SRC_DIR}/ViewHierarchy/ViewHierarchyUtils.m" \
  "${SRC_DIR}/ViewHierarchy/GetFullHierarchy.m" \
  "${SRC_DIR}/ViewHierarchy/FindViews.m" \
  "${SRC_DIR}/ViewHierarchy/ViewAtPoint.m" \
  "${SRC_DIR}/ViewHierarchy/UserInteractableViewAtPoint.m" \
  "${SRC_DIR}/ViewHierarchy/DescribeScreen.m" \
  -o "${DEST_FILE}"

echo "Building libKeyboardPatch.dylib..."
xcrun --sdk iphonesimulator clang \
  -dynamiclib \
  -fobjc-arc \
  -fmodules \
  ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
  -isysroot "${SDK_PATH}" \
  -mios-simulator-version-min=13.0 \
  -arch arm64 \
  -arch x86_64 \
  -framework Foundation \
  "${SRC_DIR}/KeyboardPatch.m" \
  -o "${DEST_FILE_KB}"

echo "Building libInjectionBootstrap.dylib..."
xcrun --sdk iphonesimulator clang \
  -dynamiclib \
  ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
  -isysroot "${SDK_PATH}" \
  -mios-simulator-version-min=13.0 \
  -arch arm64 \
  -arch x86_64 \
  "${SRC_DIR}/InjectionBootstrap.c" \
  -o "${DEST_FILE_BS}"

if [[ "$MODE" == "release" ]]; then
  IDENTITY="${CODESIGN_IDENTITY:-${IDENTITY:-}}"
  if [[ -n "$IDENTITY" ]]; then
    codesign --force --options runtime --sign "$IDENTITY" "${DEST_FILE}"
    codesign --verify --verbose "${DEST_FILE}"
    codesign --force --options runtime --sign "$IDENTITY" "${DEST_FILE_KB}"
    codesign --verify --verbose "${DEST_FILE_KB}"
    codesign --force --options runtime --sign "$IDENTITY" "${DEST_FILE_BS}"
    codesign --verify --verbose "${DEST_FILE_BS}"
  fi
fi

echo "Done. Dylibs written to ${DEST_DIR}/"
