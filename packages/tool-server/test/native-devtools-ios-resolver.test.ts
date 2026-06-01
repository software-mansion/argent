import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Static import primes vite's module graph for the dynamic re-import below.
// We re-import via the SAME path string after `vi.resetModules()` so the
// resolver re-reads ARGENT_NATIVE_DEVTOOLS_DIR / ARGENT_SIMULATOR_SERVER_DIR
// per-test instead of using whatever was set at first load.
import type * as ResolverModule from "../../native-devtools-ios/src/index";

// Unit tests for the @argent/native-devtools-ios resolver. The resolver is
// what gates iOS-only binaries from being looked up on Linux callers, and
// what joins `process.platform` into the simulator-server bin path. Both
// behaviors only execute on resolver invocation, so we test the exported
// functions directly. We override ARGENT_NATIVE_DEVTOOLS_DIR /
// ARGENT_SIMULATOR_SERVER_DIR per-test so the resolver looks at a tmpdir we
// control rather than the real packages/native-devtools-ios layout.

let tmpRoot = "";
const originalPlatform = process.platform;
const originalDevtoolsDir = process.env.ARGENT_NATIVE_DEVTOOLS_DIR;
const originalSimulatorDir = process.env.ARGENT_SIMULATOR_SERVER_DIR;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-resolver-"));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  setPlatform(originalPlatform);
  if (originalDevtoolsDir === undefined) delete process.env.ARGENT_NATIVE_DEVTOOLS_DIR;
  else process.env.ARGENT_NATIVE_DEVTOOLS_DIR = originalDevtoolsDir;
  if (originalSimulatorDir === undefined) delete process.env.ARGENT_SIMULATOR_SERVER_DIR;
  else process.env.ARGENT_SIMULATOR_SERVER_DIR = originalSimulatorDir;
});

afterEach(() => {
  setPlatform(originalPlatform);
});

/**
 * Re-import the resolver after env / platform mutations. The module captures
 * ARGENT_NATIVE_DEVTOOLS_DIR / ARGENT_SIMULATOR_SERVER_DIR at top-level on
 * first load; vi.resetModules() clears vite's cache so the next import()
 * re-executes the module body and picks up the current env. The dynamic
 * specifier must match the static import above byte-for-byte so vite's
 * module graph resolves to the same node.
 */
async function loadResolver(): Promise<typeof ResolverModule> {
  vi.resetModules();
  return await import("../../native-devtools-ios/src/index");
}

describe("requireDarwin gating", () => {
  it("throws with a root-cause message on linux for iOS-only dylibs", async () => {
    // A Linux caller asking for an iOS Simulator dylib should get the root
    // cause ("requires a macOS host") not a misleading "file not found",
    // which is what happened before this PR and led to confused bug reports.
    setPlatform("linux");
    const r = await loadResolver();
    expect(() => r.bootstrapDylibPath()).toThrow(/requires a macOS host/);
    expect(() => r.nativeDevtoolsDylibPath()).toThrow(/requires a macOS host/);
    expect(() => r.keyboardPatchDylibPath()).toThrow(/requires a macOS host/);
  });

  it("throws with a root-cause message on linux for ax-service", async () => {
    // ax-service is darwin-only (runs INSIDE the iOS Simulator), so the
    // resolver must throw the platform error BEFORE the file-existence check.
    setPlatform("linux");
    process.env.ARGENT_SIMULATOR_SERVER_DIR = tmpRoot;
    const r = await loadResolver();
    expect(() => r.axServiceBinaryPath()).toThrow(/requires a macOS host/);
  });
});

describe("simulator-server path resolution", () => {
  it("joins process.platform into the bin path", async () => {
    // The whole point of the per-platform bin layout. We're verifying that
    // the resolver constructs <BIN_ROOT>/<platform>/simulator-server, not
    // <BIN_ROOT>/simulator-server.
    const dir = fs.mkdtempSync(path.join(tmpRoot, "platform-join-"));
    const platDir = path.join(dir, process.platform);
    fs.mkdirSync(platDir, { recursive: true });
    const binPath = path.join(platDir, "simulator-server");
    fs.writeFileSync(binPath, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(r.simulatorServerBinaryPath()).toBe(binPath);
    expect(r.simulatorServerBinaryDir()).toBe(platDir);
  });

  it("throws when the per-platform binary is missing", async () => {
    // Empty per-platform dir: the resolver should fail loudly with both the
    // platform name and the expected path in the message so the user can
    // act on it (re-run the download script, switch hosts, etc).
    const dir = fs.mkdtempSync(path.join(tmpRoot, "missing-"));
    fs.mkdirSync(path.join(dir, process.platform), { recursive: true });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(() => r.simulatorServerBinaryPath()).toThrow(/simulator-server binary not found/);
    expect(() => r.simulatorServerBinaryPath()).toThrow(new RegExp(process.platform));
  });
});

describe("ARGENT_NATIVE_DEVTOOLS_DIR override", () => {
  it("uses the env-var dir for dylib resolution on darwin", async () => {
    // The launcher script swaps the dylib dir at runtime via this env var
    // (matches the ARGENT_SIMULATOR_SERVER_DIR pattern). Linux callers can't
    // exercise the happy path because requireDarwin throws first, so this
    // test only meaningfully runs on darwin — skip elsewhere rather than
    // pretend to test it.
    if (originalPlatform !== "darwin") return;
    const dir = fs.mkdtempSync(path.join(tmpRoot, "dylib-override-"));
    const dylib = path.join(dir, "libNativeDevtoolsIos.dylib");
    fs.writeFileSync(dylib, "");
    process.env.ARGENT_NATIVE_DEVTOOLS_DIR = dir;
    setPlatform("darwin");
    const r = await loadResolver();
    expect(r.nativeDevtoolsDylibPath()).toBe(dylib);
  });
});
