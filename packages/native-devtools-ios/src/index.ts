import * as path from "node:path";
import * as fs from "node:fs";

// When bundled by esbuild, __dirname points into dist/.
// ARGENT_SIMULATOR_SERVER_DIR must point at the parent of bin/<platform>/, not
// at the directory holding the binary.
const DYLIB_DIR = process.env.ARGENT_NATIVE_DEVTOOLS_DIR ?? path.join(__dirname, "..", "dylibs");
const BIN_DIR = process.env.ARGENT_SIMULATOR_SERVER_DIR ?? path.join(__dirname, "..", "bin");
const DYLIB_TCP_DIR = process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR ?? path.join(DYLIB_DIR, "tcp");
const DYLIB_TVOS_DIR = path.join(DYLIB_DIR, "tvos");

// The local and tvos artifacts run against a simulator on *this* host, and iOS
// Simulator only runs on macOS; name the root cause instead of leaving a Linux
// caller with a confusing "file not found". The `*Tcp` accessors are
// deliberately not gated: they are uploaded to a remote Mac orchestrator via
// `sim-remote` (`remoteIosHost` in tool-server), so they must resolve anywhere.
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

// TCP artifacts are built separately from the default unix-socket set, so they
// can be legitimately absent in a local/dev build. `describe` matches this
// exact "TCP-transport <kind> not found" wording (its `tcpArtifactHint`) to
// surface the message instead of the unrelated "reboot the simulator" hint.
function requireTcpArtifact(
  dir: string,
  name: string,
  kind: "binary" | "dylib",
  envVar: string
): string {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) {
    throw new Error(
      `TCP-transport ${kind} not found: ${p}. This ${kind} is required to drive an ` +
        `ios-remote (sim-remote) device over the QUIC tunnel. It ships in the argent ` +
        `package under bin/tcp/ and dylibs/tcp/ (platform-neutral); if you are running a ` +
        `local build, produce it with \`npm run build:ios-binaries:tcp\`. To point the ` +
        `lookup at a directory that already contains it, set ${envVar}=<dir>.`
    );
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
  return requireTcpArtifact(
    DYLIB_TCP_DIR,
    "libArgentInjectionBootstrap.dylib",
    "dylib",
    "ARGENT_NATIVE_DEVTOOLS_TCP_DIR"
  );
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
  return requireTcpArtifact(
    DYLIB_TCP_DIR,
    "libNativeDevtoolsIos.dylib",
    "dylib",
    "ARGENT_NATIVE_DEVTOOLS_TCP_DIR"
  );
};
export const keyboardPatchDylibPathTcp = () => {
  return requireTcpArtifact(
    DYLIB_TCP_DIR,
    "libKeyboardPatch.dylib",
    "dylib",
    "ARGENT_NATIVE_DEVTOOLS_TCP_DIR"
  );
};

/**
 * The TCP-variant dylibs a remote orchestrator must hold for native devtools.
 * Only the bootstrap is inserted into `DYLD_INSERT_LIBRARIES`; the others are
 * uploaded to sit beside it, where the bootstrap resolves them via
 * `@loader_path`.
 */
export function tcpInjectionDylibs(): { path: string; insert: boolean }[] {
  return [
    { path: bootstrapDylibPathTcp(), insert: true },
    { path: nativeDevtoolsDylibPathTcp(), insert: false },
    { path: keyboardPatchDylibPathTcp(), insert: false },
  ];
}

// simulator-server is a host-side binary driving iOS Simulators (macOS) and
// Android emulators (any host with `adb`), so every host platform's build ships
// in its own bin/ subdirectory keyed by this value.
//
// darwin ships a universal (lipo) binary, so one "darwin" dir serves both
// arches; Linux binaries are single-arch ELFs, so arm64 gets its own directory
// next to the x86_64 one ("linux", the pre-arm64 name kept for compatibility).
export function hostPlatformKey(): string {
  if (process.platform === "linux" && process.arch === "arm64") {
    return "linux-arm64";
  }
  return process.platform;
}
// Matches the artifact the simulator-server release publishes for each host
// (simulator-server-argent-windows.exe keeps its extension end-to-end).
export function simulatorServerBinaryName(): string {
  return process.platform === "win32" ? "simulator-server.exe" : "simulator-server";
}
function platformBinDir(): string {
  return path.join(BIN_DIR, hostPlatformKey());
}
// Platform-NEUTRAL, mirroring dylibs/tcp: unlike simulator-server and the unix
// ax-service, the tcp ax-service is a darwin simulator binary uploaded to and
// `simctl spawn`d on the *remote* orchestrator, so it is needed whatever the
// host is — under bin/<hostPlatform>/ a Linux host would look in bin/linux/tcp
// and never find it.
function tcpBinDir(): string {
  return process.env.ARGENT_SIMULATOR_SERVER_TCP_DIR ?? path.join(BIN_DIR, "tcp");
}

export function simulatorServerBinaryPath(): string {
  const binaryName = simulatorServerBinaryName();
  const p = path.join(platformBinDir(), binaryName);
  if (!fs.existsSync(p)) {
    // The pre-Linux-support layout kept simulator-server flat at the root.
    const flat = path.join(BIN_DIR, binaryName);
    const migrationHint = fs.existsSync(flat)
      ? ` Found a binary at the old flat path ${flat}; move it to ${p} or update ARGENT_SIMULATOR_SERVER_DIR to point at the parent of the platform subdirectory.`
      : "";
    throw new Error(
      `simulator-server binary not found for platform "${hostPlatformKey()}" at ${p}. ` +
        `Supported hosts today: darwin, linux (x86_64 and arm64), win32.${migrationHint}`
    );
  }
  return p;
}

// Working directory for the simulator-server spawn: the binary resolves the
// screen-sharing agent at `resources/android/` relative to cwd. One shared
// copy lives at the bin root; fall back to the per-platform dir for pre-dedup
// layouts (e.g. an ARGENT_SIMULATOR_SERVER_DIR override on an old install).
export function simulatorServerRunDir(): string {
  if (fs.existsSync(path.join(BIN_DIR, "resources", "android"))) {
    return BIN_DIR;
  }
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
  return requireTcpArtifact(tcpBinDir(), "ax-service", "binary", "ARGENT_SIMULATOR_SERVER_TCP_DIR");
}

// tvos-ax-service is `simctl spawn`d into an appletvsimulator to read the
// focus-engine AX state; tvos-hid-daemon runs on the host and injects
// Siri-remote HID via SimulatorKit.
export function tvosAxServiceBinaryPath(): string {
  requireDarwin("tvos-ax-service");
  return requireBinIn(platformBinDir(), "tvos-ax-service");
}

export function tvosHidDaemonBinaryPath(): string {
  requireDarwin("tvos-hid-daemon");
  return requireBinIn(platformBinDir(), "tvos-hid-daemon");
}
