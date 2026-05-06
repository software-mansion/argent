import * as path from "node:path";
import * as fs from "node:fs";

// When bundled by esbuild, __dirname points into dist/.
// ARGENT_NATIVE_DEVTOOLS_DIR lets the launcher override the dylib directory,
// matching the same pattern used by ARGENT_SIMULATOR_SERVER_DIR.
const DYLIB_DIR = process.env.ARGENT_NATIVE_DEVTOOLS_DIR ?? path.join(__dirname, "..", "dylibs");

function requireDylib(name: string): string {
  const p = path.join(DYLIB_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`Native devtools dylib not found: ${p}`);
  }
  return p;
}

export const bootstrapDylibPath = () => requireDylib("libArgentInjectionBootstrap.dylib");
export const nativeDevtoolsDylibPath = () => requireDylib("libNativeDevtoolsIos.dylib");
export const keyboardPatchDylibPath = () => requireDylib("libKeyboardPatch.dylib");

const BIN_DIR = process.env.ARGENT_SIMULATOR_SERVER_DIR ?? path.join(__dirname, "..", "bin");

// Windows binaries carry the `.exe` extension; macOS/Linux use bare names.
// The download/bundle pipeline writes the platform-specific filename into the
// same `bin/` directory, so the only platform-aware piece is which name to
// look up. The vanilla upstream `simulator-server-windows.exe` is sufficient
// for Windows because Windows targets are Android-only — the iOS-specific
// argent customizations only apply to the macOS build.
const SIMULATOR_SERVER_FILENAME =
  process.platform === "win32" ? "simulator-server.exe" : "simulator-server";

export function simulatorServerBinaryPath(): string {
  const p = path.join(BIN_DIR, SIMULATOR_SERVER_FILENAME);
  if (!fs.existsSync(p)) {
    throw new Error(`simulator-server binary not found: ${p}`);
  }
  return p;
}

export function simulatorServerBinaryDir(): string {
  return BIN_DIR;
}

export function axServiceBinaryPath(): string {
  // ax-service is an iOS-only daemon that runs inside the iOS simulator host
  // process. There is no Windows or Linux build, and it would never get
  // invoked outside the iOS dispatch branch — but throw a clearer error if
  // something does try to fetch it on the wrong platform.
  if (process.platform !== "darwin") {
    throw new Error(`ax-service is macOS-only (current platform: ${process.platform})`);
  }
  const p = path.join(BIN_DIR, "ax-service");
  if (!fs.existsSync(p)) {
    throw new Error(`ax-service binary not found: ${p}`);
  }
  return p;
}
