#!/usr/bin/env bash

# Build native-devtools-ios dylibs for Argent.
# ObjC source lives in the argent-private submodule at packages/argent-private.
# Run from the workspace root: bash packages/native-devtools-ios/scripts/build.sh [dev|release] [--transport unix|tcp]
# Or from this package: bash scripts/build.sh [dev|release] [--transport unix|tcp]
#
# Usage: build.sh [dev|release] [--transport unix|tcp]
#   mode: dev (fast) or release (optimized, optional signing). Default: release.
#   --transport: unix (default) builds against AF_UNIX sockets at /tmp/*.sock paths;
#                tcp builds with -DARGENT_USE_TCP=1 so the dylib/daemon use AF_INET
#                on 127.0.0.1 with a port. Artifacts go to dylibs/tcp/ and bin/tcp/
#                so both variants can coexist.
#
# Environment:
#   PREBUILT_NATIVE_DEVTOOLS_IOS  - if set, copy this path to dylibs/ instead of building (CI on non-macOS)
#   PREBUILT_KEYBOARD_PATCH       - same for keyboard patch dylib
#   PREBUILT_INJECTION_BOOTSTRAP  - same for bootstrap dylib
#   PREBUILT_NATIVE_DEVTOOLS_IOS_TVOS / PREBUILT_KEYBOARD_PATCH_TVOS /
#   PREBUILT_INJECTION_BOOTSTRAP_TVOS - tvOS-slice counterparts, copied to
#     dylibs/tvos/ on the prebuilt path (all three required together)
#   PREBUILT_TVOS_AX_SERVICE / PREBUILT_TVOS_HID_DAEMON - prebuilt tvOS daemon binaries
#   Release signing: set IDENTITY (or CODESIGN_IDENTITY), or for CI keychain import set
#     CERTIFICATE, PRIVATE_KEY_BASE64, PRIVATE_KEY_PASSWORD, KEYCHAIN_PASSWORD, IDENTITY.

set -euo pipefail

MODE="release"
TRANSPORT="unix"

while (($#)); do
  case "$1" in
    dev|release)
      MODE="$1"; shift ;;
    --transport)
      TRANSPORT="${2:-}"; shift 2 ;;
    --transport=*)
      TRANSPORT="${1#--transport=}"; shift ;;
    *)
      echo "Usage: build.sh [dev|release] [--transport unix|tcp]" >&2
      exit 1 ;;
  esac
done

if [[ "$TRANSPORT" != "unix" && "$TRANSPORT" != "tcp" ]]; then
  echo "Invalid --transport '$TRANSPORT'. Expected unix or tcp." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$(cd "${ROOT_DIR}/../.." && pwd)"
SUBMODULE_DIR="${WORKSPACE_DIR}/packages/argent-private/packages/native-devtools-ios"
SRC_DIR="${SUBMODULE_DIR}/Sources/NativeDevtoolsIos"

if [[ "$TRANSPORT" == "tcp" ]]; then
  DEST_DIR="${ROOT_DIR}/dylibs/tcp"
  BIN_DIR="${ROOT_DIR}/bin/darwin/tcp"
else
  DEST_DIR="${ROOT_DIR}/dylibs"
  BIN_DIR="${ROOT_DIR}/bin/darwin"
fi

# Verify the submodule is initialised before trying to build.
if [[ ! -d "${SRC_DIR}" ]]; then
  echo "Error: ObjC source not found at ${SRC_DIR}" >&2
  echo "       Run: git submodule update --init packages/argent-private" >&2
  exit 1
fi

DEST_FILE="${DEST_DIR}/libNativeDevtoolsIos.dylib"
DEST_FILE_KB="${DEST_DIR}/libKeyboardPatch.dylib"
DEST_FILE_BS="${DEST_DIR}/libArgentInjectionBootstrap.dylib"

# If pre-built dylibs are provided, copy them and exit.
if [[ -n "${PREBUILT_NATIVE_DEVTOOLS_IOS:-}" ]] && [[ -n "${PREBUILT_KEYBOARD_PATCH:-}" ]] && [[ -n "${PREBUILT_INJECTION_BOOTSTRAP:-}" ]]; then
  echo "Using pre-built dylibs"
  mkdir -p "$DEST_DIR"
  cp "$PREBUILT_NATIVE_DEVTOOLS_IOS" "$DEST_FILE"
  cp "$PREBUILT_KEYBOARD_PATCH" "$DEST_FILE_KB"
  cp "$PREBUILT_INJECTION_BOOTSTRAP" "$DEST_FILE_BS"
  # tvOS slice (dylibs/tvos/). Only on the unix transport — the tvOS dylibs have
  # no TCP variant — and only when all three are supplied, since
  # InjectionBootstrap dlopen()s the other two from its own directory.
  if [[ "$TRANSPORT" == "unix" \
    && -n "${PREBUILT_NATIVE_DEVTOOLS_IOS_TVOS:-}" \
    && -n "${PREBUILT_KEYBOARD_PATCH_TVOS:-}" \
    && -n "${PREBUILT_INJECTION_BOOTSTRAP_TVOS:-}" ]]; then
    echo "Using pre-built tvOS dylibs"
    mkdir -p "${ROOT_DIR}/dylibs/tvos"
    cp "$PREBUILT_NATIVE_DEVTOOLS_IOS_TVOS" "${ROOT_DIR}/dylibs/tvos/libNativeDevtoolsIos.dylib"
    cp "$PREBUILT_KEYBOARD_PATCH_TVOS" "${ROOT_DIR}/dylibs/tvos/libKeyboardPatch.dylib"
    cp "$PREBUILT_INJECTION_BOOTSTRAP_TVOS" "${ROOT_DIR}/dylibs/tvos/libArgentInjectionBootstrap.dylib"
  fi
  # tvOS daemon binaries (bin/<dir>/). These are the tvos-ax-service (runs inside
  # the sim) and tvos-hid-daemon (runs on the host) — without them the Apple TV
  # control service has nothing to spawn. They're advertised as prebuilt inputs
  # in the header, but the build path below sits after this early exit, so on the
  # prebuilt (non-macOS CI) route they must be copied here too. Unix transport
  # only, matching the build path's guard.
  if [[ "$TRANSPORT" == "unix" ]]; then
    if [[ -n "${PREBUILT_TVOS_AX_SERVICE:-}" ]]; then
      echo "Using pre-built tvos-ax-service"
      mkdir -p "$BIN_DIR"
      cp "$PREBUILT_TVOS_AX_SERVICE" "${BIN_DIR}/tvos-ax-service"
    fi
    if [[ -n "${PREBUILT_TVOS_HID_DAEMON:-}" ]]; then
      echo "Using pre-built tvos-hid-daemon"
      mkdir -p "$BIN_DIR"
      cp "$PREBUILT_TVOS_HID_DAEMON" "${BIN_DIR}/tvos-hid-daemon"
    fi
  fi
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
if [[ "$TRANSPORT" == "tcp" ]]; then
  EXTRA_CFLAGS+=(-DARGENT_USE_TCP=1)
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

echo "Building libArgentInjectionBootstrap.dylib..."
xcrun --sdk iphonesimulator clang \
  -dynamiclib \
  ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
  -isysroot "${SDK_PATH}" \
  -mios-simulator-version-min=13.0 \
  -arch arm64 \
  -arch x86_64 \
  "${SRC_DIR}/InjectionBootstrap.c" \
  -o "${DEST_FILE_BS}"

echo "Building ax-service..."
AX_SRC_DIR="${SUBMODULE_DIR}/Sources/AXService"
AX_DEST="${BIN_DIR}/ax-service"
mkdir -p "$(dirname "$AX_DEST")"

if [[ -n "${PREBUILT_AX_SERVICE:-}" ]]; then
  cp "$PREBUILT_AX_SERVICE" "$AX_DEST"
else
  xcrun --sdk iphonesimulator clang \
    -fobjc-arc \
    ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
    -isysroot "${SDK_PATH}" \
    -target arm64-apple-ios17.0-simulator \
    -framework Foundation -framework UIKit -framework CoreGraphics \
    -lobjc \
    -o "${AX_DEST}" "${AX_SRC_DIR}/ax_service.m"
fi

# tvOS control binaries + injection dylibs. Unix-socket only (no TCP variant),
# so only built for the default transport. tvos-ax-service runs inside an
# appletvsimulator; tvos-hid-daemon runs on the macOS host and injects HID via
# SimulatorKit.
if [[ "$TRANSPORT" == "unix" ]]; then
  # tvOS injection dylibs. Same ObjC/C sources as the iOS dylibs, recompiled
  # against the appletvsimulator SDK (platform TVOSSIMULATOR) — injecting the
  # iOS slice into an Apple TV sim makes dyld silently skip the library, so
  # native-devtools never connects (see ensureEnv's isTvos branch). They live
  # next to their iOS counterparts under dylibs/tvos/ because
  # bootstrapDylibPathTvos() reads from there regardless of transport, and
  # InjectionBootstrap dlopen()s the other two from its own directory, so all
  # three must ship together.
  TVOS_DYLIB_DIR="${ROOT_DIR}/dylibs/tvos"
  TVOS_DEST_FILE="${TVOS_DYLIB_DIR}/libNativeDevtoolsIos.dylib"
  TVOS_DEST_FILE_KB="${TVOS_DYLIB_DIR}/libKeyboardPatch.dylib"
  TVOS_DEST_FILE_BS="${TVOS_DYLIB_DIR}/libArgentInjectionBootstrap.dylib"
  mkdir -p "$TVOS_DYLIB_DIR"
  TVOS_SDK_PATH="$(xcrun --sdk appletvsimulator --show-sdk-path)"

  echo "Building libNativeDevtoolsIos.dylib (tvOS)..."
  if [[ -n "${PREBUILT_NATIVE_DEVTOOLS_IOS_TVOS:-}" ]]; then
    cp "$PREBUILT_NATIVE_DEVTOOLS_IOS_TVOS" "$TVOS_DEST_FILE"
  else
    xcrun --sdk appletvsimulator clang \
      -dynamiclib \
      -fobjc-arc \
      -fmodules \
      ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
      -isysroot "${TVOS_SDK_PATH}" \
      -mtvos-simulator-version-min=17.0 \
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
      -o "${TVOS_DEST_FILE}"
  fi

  echo "Building libKeyboardPatch.dylib (tvOS)..."
  if [[ -n "${PREBUILT_KEYBOARD_PATCH_TVOS:-}" ]]; then
    cp "$PREBUILT_KEYBOARD_PATCH_TVOS" "$TVOS_DEST_FILE_KB"
  else
    xcrun --sdk appletvsimulator clang \
      -dynamiclib \
      -fobjc-arc \
      -fmodules \
      ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
      -isysroot "${TVOS_SDK_PATH}" \
      -mtvos-simulator-version-min=17.0 \
      -arch arm64 \
      -arch x86_64 \
      -framework Foundation \
      "${SRC_DIR}/KeyboardPatch.m" \
      -o "${TVOS_DEST_FILE_KB}"
  fi

  echo "Building libArgentInjectionBootstrap.dylib (tvOS)..."
  if [[ -n "${PREBUILT_INJECTION_BOOTSTRAP_TVOS:-}" ]]; then
    cp "$PREBUILT_INJECTION_BOOTSTRAP_TVOS" "$TVOS_DEST_FILE_BS"
  else
    xcrun --sdk appletvsimulator clang \
      -dynamiclib \
      ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
      -isysroot "${TVOS_SDK_PATH}" \
      -mtvos-simulator-version-min=17.0 \
      -arch arm64 \
      -arch x86_64 \
      "${SRC_DIR}/InjectionBootstrap.c" \
      -o "${TVOS_DEST_FILE_BS}"
  fi

  echo "Building tvos-ax-service..."
  TVOS_SRC_DIR="${SUBMODULE_DIR}/Sources/TvosServices"
  TVOS_AX_DEST="${BIN_DIR}/tvos-ax-service"
  TVOS_HID_DEST="${BIN_DIR}/tvos-hid-daemon"

  if [[ -n "${PREBUILT_TVOS_AX_SERVICE:-}" ]]; then
    cp "$PREBUILT_TVOS_AX_SERVICE" "$TVOS_AX_DEST"
  else
    xcrun --sdk appletvsimulator clang \
      -fobjc-arc \
      ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
      -isysroot "${TVOS_SDK_PATH}" \
      -target arm64-apple-tvos17.0-simulator \
      -framework Foundation -framework UIKit -framework CoreGraphics \
      -lobjc \
      -o "${TVOS_AX_DEST}" "${TVOS_SRC_DIR}/tvos_ax_service.m"
  fi

  echo "Building tvos-hid-daemon..."
  if [[ -n "${PREBUILT_TVOS_HID_DAEMON:-}" ]]; then
    cp "$PREBUILT_TVOS_HID_DAEMON" "$TVOS_HID_DEST"
  else
    clang \
      -fobjc-arc \
      ${EXTRA_CFLAGS[@]+"${EXTRA_CFLAGS[@]}"} \
      -framework Foundation -framework AppKit -framework CoreGraphics \
      -o "${TVOS_HID_DEST}" "${TVOS_SRC_DIR}/tvos_hid_daemon.m"
  fi
fi

if [[ "$MODE" == "release" ]]; then
  IDENTITY="${CODESIGN_IDENTITY:-${IDENTITY:-}}"
  if [[ -n "$IDENTITY" ]]; then
    codesign --force --options runtime --sign "$IDENTITY" "${DEST_FILE}"
    codesign --verify --verbose "${DEST_FILE}"
    codesign --force --options runtime --sign "$IDENTITY" "${DEST_FILE_KB}"
    codesign --verify --verbose "${DEST_FILE_KB}"
    codesign --force --options runtime --sign "$IDENTITY" "${DEST_FILE_BS}"
    codesign --verify --verbose "${DEST_FILE_BS}"
    if [[ "$TRANSPORT" == "unix" ]]; then
      codesign --force --options runtime --sign "$IDENTITY" "${TVOS_DEST_FILE}"
      codesign --verify --verbose "${TVOS_DEST_FILE}"
      codesign --force --options runtime --sign "$IDENTITY" "${TVOS_DEST_FILE_KB}"
      codesign --verify --verbose "${TVOS_DEST_FILE_KB}"
      codesign --force --options runtime --sign "$IDENTITY" "${TVOS_DEST_FILE_BS}"
      codesign --verify --verbose "${TVOS_DEST_FILE_BS}"
      codesign --force --options runtime --sign "$IDENTITY" "${TVOS_AX_DEST}"
      codesign --verify --verbose "${TVOS_AX_DEST}"
      codesign --force --options runtime --sign "$IDENTITY" "${TVOS_HID_DEST}"
      codesign --verify --verbose "${TVOS_HID_DEST}"
    fi
  fi
fi

echo "Done. Dylibs written to ${DEST_DIR}/ (transport=${TRANSPORT})"
