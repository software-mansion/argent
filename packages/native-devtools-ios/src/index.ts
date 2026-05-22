import * as path from "node:path";
import * as fs from "node:fs";

// When bundled by esbuild, __dirname points into dist/.
// ARGENT_NATIVE_DEVTOOLS_DIR lets the launcher override the dylib directory,
// matching the same pattern used by ARGENT_SIMULATOR_SERVER_DIR.
const DYLIB_DIR = process.env.ARGENT_NATIVE_DEVTOOLS_DIR ?? path.join(__dirname, "..", "dylibs");
const BIN_ROOT = process.env.ARGENT_SIMULATOR_SERVER_DIR ?? path.join(__dirname, "..", "bin");

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

function requireDylib(name: string): string {
  requireDarwin(name);
  const p = path.join(DYLIB_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`Native devtools dylib not found: ${p}`);
  }
  return p;
}

export const bootstrapDylibPath = () => requireDylib("libArgentInjectionBootstrap.dylib");
export const nativeDevtoolsDylibPath = () => requireDylib("libNativeDevtoolsIos.dylib");
export const keyboardPatchDylibPath = () => requireDylib("libKeyboardPatch.dylib");

// simulator-server is a host-side binary that talks to both iOS Simulators
// (macOS) and Android emulators (any host with `adb`). Each platform's
// binary lives in its own subdirectory of bin/ — keyed by `process.platform`
// — so a single npm package can ship both without colliding filenames.
function platformBinDir(): string {
  return path.join(BIN_ROOT, process.platform);
}

export function simulatorServerBinaryPath(): string {
  const p = path.join(platformBinDir(), "simulator-server");
  if (!fs.existsSync(p)) {
    throw new Error(
      `simulator-server binary not found for platform "${process.platform}" at ${p}. ` +
        `Supported hosts today: darwin, linux.`
    );
  }
  return p;
}

export function simulatorServerBinaryDir(): string {
  return platformBinDir();
}

export function axServiceBinaryPath(): string {
  requireDarwin("ax-service");
  const p = path.join(platformBinDir(), "ax-service");
  if (!fs.existsSync(p)) {
    throw new Error(`ax-service binary not found: ${p}`);
  }
  return p;
}
