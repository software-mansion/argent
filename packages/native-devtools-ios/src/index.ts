import * as path from "node:path";
import * as fs from "node:fs";

// When bundled by esbuild, __dirname points into dist/.
// ARGENT_NATIVE_DEVTOOLS_DIR overrides the dylib base directory.
// ARGENT_SIMULATOR_SERVER_DIR overrides the binary base directory; it must
// point at the *root* of the per-platform tree (i.e. the parent of
// bin/<platform>/), not directly at the directory containing the binary.
const DYLIB_DIR = process.env.ARGENT_NATIVE_DEVTOOLS_DIR ?? path.join(__dirname, "..", "dylibs");
const BIN_DIR = process.env.ARGENT_SIMULATOR_SERVER_DIR ?? path.join(__dirname, "..", "bin");
const DYLIB_TCP_DIR = process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR ?? path.join(DYLIB_DIR, "tcp");
const DYLIB_TVOS_DIR = path.join(DYLIB_DIR, "tvos");

// iOS Simulator only runs on macOS, so the dylibs that get injected into it
// and the ax-service that gets `simctl spawn`d into it are only ever usable
// on darwin hosts. Throw with a clear, root-cause message so a Linux user
// invoking these accidentally doesn't get a confusing "file not found".
function requireDarwin(what: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `${what} requires a macOS host (iOS Simulator is unavailable on ${process.platform})`
    );
  }
}

function requireDylibIn(dir: string, name: string): string {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    throw new Error(`Native devtools dylib not found: ${p}`);
  }
  return p;
}

export const bootstrapDylibPath = () => {
  requireDarwin("bootstrapDylibPath");
  return requireDylibIn(DYLIB_DIR, "libArgentInjectionBootstrap.dylib");
};
export const nativeDevtoolsDylibPath = () => {
  requireDarwin("nativeDevtoolsDylibPath");
  return requireDylibIn(DYLIB_DIR, "libNativeDevtoolsIos.dylib");
};
export const keyboardPatchDylibPath = () => {
  requireDarwin("keyboardPatchDylibPath");
  return requireDylibIn(DYLIB_DIR, "libKeyboardPatch.dylib");
};

export const bootstrapDylibPathTcp = () => {
  requireDarwin("bootstrapDylibPathTcp");
  return requireDylibIn(DYLIB_TCP_DIR, "libArgentInjectionBootstrap.dylib");
};

export const bootstrapDylibPathTvos = () => {
  requireDarwin("bootstrapDylibPathTvos");
  return requireDylibIn(DYLIB_TVOS_DIR, "libArgentInjectionBootstrap.dylib");
};
export const nativeDevtoolsDylibPathTvos = () => {
  requireDarwin("nativeDevtoolsDylibPathTvos");
  return requireDylibIn(DYLIB_TVOS_DIR, "libNativeDevtoolsIos.dylib");
};
export const nativeDevtoolsDylibPathTcp = () => {
  requireDarwin("nativeDevtoolsDylibPathTcp");
  return requireDylibIn(DYLIB_TCP_DIR, "libNativeDevtoolsIos.dylib");
};

// simulator-server is a host-side binary that talks to both iOS Simulators
// (macOS) and Android emulators (any host with `adb`). Each platform's
// binary lives in its own subdirectory of bin/ — keyed by the host platform
// key below — so a single npm package can ship all of them without colliding
// filenames.
//
// The key is `process.platform`, except on arm64 Linux where it is
// "linux-arm64": darwin ships a universal (lipo) binary so one "darwin" dir
// serves both arches, but Linux binaries are single-arch ELFs, so arm64 gets
// its own directory next to the x86_64 one ("linux", the pre-arm64 name kept
// for backward compatibility).
export function hostPlatformKey(): string {
  if (process.platform === "linux" && process.arch === "arm64") {
    return "linux-arm64";
  }
  return process.platform;
}
function platformBinDir(): string {
  return path.join(BIN_DIR, hostPlatformKey());
}
// TCP dir: <platform>/tcp by default; ARGENT_SIMULATOR_SERVER_TCP_DIR overrides the whole path.
function platformTcpBinDir(): string {
  return process.env.ARGENT_SIMULATOR_SERVER_TCP_DIR ?? path.join(platformBinDir(), "tcp");
}

export function simulatorServerBinaryPath(): string {
  const p = path.join(platformBinDir(), "simulator-server");
  if (!fs.existsSync(p)) {
    // Help callers who set ARGENT_SIMULATOR_SERVER_DIR to a flat dir (the old
    // pre-Linux-support layout where simulator-server lived at the root).
    const flat = path.join(BIN_DIR, "simulator-server");
    const migrationHint = fs.existsSync(flat)
      ? ` Found a binary at the old flat path ${flat}; move it to ${p} or update ARGENT_SIMULATOR_SERVER_DIR to point at the parent of the platform subdirectory.`
      : "";
    throw new Error(
      `simulator-server binary not found for platform "${hostPlatformKey()}" at ${p}. ` +
        `Supported hosts today: darwin, linux (x86_64 and arm64).${migrationHint}`
    );
  }
  return p;
}

export function simulatorServerBinaryDir(): string {
  return platformBinDir();
}

function requireBinIn(dir: string, name: string): string {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    throw new Error(`${name} binary not found: ${p}`);
  }
  return p;
}

export function axServiceBinaryPath(): string {
  requireDarwin("ax-service");
  return requireBinIn(platformBinDir(), "ax-service");
}

export function axServiceBinaryPathTcp(): string {
  requireDarwin("ax-service (tcp)");
  return requireBinIn(platformTcpBinDir(), "ax-service");
}

// tvOS control binaries. tvos-ax-service is `simctl spawn`d into an
// appletvsimulator to read the focus-engine AX state; tvos-hid-daemon runs on
// the host and injects Siri-remote HID via SimulatorKit. Both are darwin-only.
export function tvosAxServiceBinaryPath(): string {
  requireDarwin("tvos-ax-service");
  return requireBinIn(platformBinDir(), "tvos-ax-service");
}

export function tvosHidDaemonBinaryPath(): string {
  requireDarwin("tvos-hid-daemon");
  return requireBinIn(platformBinDir(), "tvos-hid-daemon");
}
