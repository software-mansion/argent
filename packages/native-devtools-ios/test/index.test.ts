import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Static import primes vite's module graph so the dynamic re-import below
// resolves to the same node; we re-import via the SAME specifier after
// vi.resetModules() to reset captured env per-test.
import type * as ResolverModule from "../src/index";

// Unit tests for the resolver in this package. The resolver is what gates
// iOS-only binaries from being looked up on Linux callers, and what joins
// `process.platform` into the simulator-server bin path. Both behaviors
// only execute on resolver invocation, so we test the exported functions
// directly. We override ARGENT_NATIVE_DEVTOOLS_DIR /
// ARGENT_SIMULATOR_SERVER_DIR per-test so the resolver looks at a tmpdir we
// control rather than the real packages/native-devtools-ios layout.

let tmpRoot = "";
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalDevtoolsDir = process.env.ARGENT_NATIVE_DEVTOOLS_DIR;
const originalSimulatorDir = process.env.ARGENT_SIMULATOR_SERVER_DIR;
const originalDevtoolsTcpDir = process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR;
const originalSimulatorTcpDir = process.env.ARGENT_SIMULATOR_SERVER_TCP_DIR;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function setArch(value: NodeJS.Architecture) {
  Object.defineProperty(process, "arch", { value, configurable: true });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-resolver-"));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  setPlatform(originalPlatform);
  setArch(originalArch);
  if (originalDevtoolsDir === undefined) delete process.env.ARGENT_NATIVE_DEVTOOLS_DIR;
  else process.env.ARGENT_NATIVE_DEVTOOLS_DIR = originalDevtoolsDir;
  if (originalSimulatorDir === undefined) delete process.env.ARGENT_SIMULATOR_SERVER_DIR;
  else process.env.ARGENT_SIMULATOR_SERVER_DIR = originalSimulatorDir;
  if (originalDevtoolsTcpDir === undefined) delete process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR;
  else process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR = originalDevtoolsTcpDir;
  if (originalSimulatorTcpDir === undefined) delete process.env.ARGENT_SIMULATOR_SERVER_TCP_DIR;
  else process.env.ARGENT_SIMULATOR_SERVER_TCP_DIR = originalSimulatorTcpDir;
});

afterEach(() => {
  setPlatform(originalPlatform);
  setArch(originalArch);
  delete process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR;
  delete process.env.ARGENT_SIMULATOR_SERVER_TCP_DIR;
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
  return await import("../src/index");
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

  it("resolves TCP dylibs on linux (remote upload artifacts, not gated)", async () => {
    // TCP variants are payloads uploaded to a remote Mac orchestrator via
    // sim-remote, so a Linux host must be able to resolve them. They are guarded
    // only by the file-existence check below, NOT by requireDarwin.
    setPlatform("linux");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "tcp-dylibs-"));
    fs.writeFileSync(path.join(dir, "libArgentInjectionBootstrap.dylib"), "");
    fs.writeFileSync(path.join(dir, "libNativeDevtoolsIos.dylib"), "");
    fs.writeFileSync(path.join(dir, "libKeyboardPatch.dylib"), "");
    process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR = dir;
    const r = await loadResolver();
    expect(r.bootstrapDylibPathTcp()).toBe(path.join(dir, "libArgentInjectionBootstrap.dylib"));
    expect(r.nativeDevtoolsDylibPathTcp()).toBe(path.join(dir, "libNativeDevtoolsIos.dylib"));
    expect(r.keyboardPatchDylibPathTcp()).toBe(path.join(dir, "libKeyboardPatch.dylib"));
  });

  it("throws a plain not-found (not a macOS-host error) for missing TCP dylibs on linux", async () => {
    // When the TCP artifacts haven't been downloaded, the file-existence check
    // gives a "not found" error — never the "requires a macOS host" gate.
    setPlatform("linux");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "tcp-dylibs-missing-"));
    process.env.ARGENT_NATIVE_DEVTOOLS_TCP_DIR = dir;
    const r = await loadResolver();
    expect(() => r.bootstrapDylibPathTcp()).toThrow(/dylib not found/);
    expect(() => r.bootstrapDylibPathTcp()).not.toThrow(/requires a macOS host/);
    // The error must be self-servicing: name the override env var so a user
    // hitting a stale/dev build learns how to relocate the lookup.
    expect(() => r.bootstrapDylibPathTcp()).toThrow(/ARGENT_NATIVE_DEVTOOLS_TCP_DIR/);
  });

  it("throws an actionable not-found (naming the override env) for a missing TCP ax-service", async () => {
    // A missing TCP ax-service otherwise surfaces deep in describe as a
    // misleading "reboot the simulator" hint; the resolver error must instead
    // point at the override env so the real cause is diagnosable.
    setPlatform("darwin");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "ax-tcp-missing-"));
    fs.mkdirSync(path.join(dir, "darwin", "tcp"), { recursive: true });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(() => r.axServiceBinaryPathTcp()).toThrow(/TCP-transport binary not found/);
    expect(() => r.axServiceBinaryPathTcp()).toThrow(/ARGENT_SIMULATOR_SERVER_TCP_DIR/);
  });

  it("throws with a root-cause message on linux for ax-service", async () => {
    // ax-service is darwin-only (runs INSIDE the iOS Simulator), so the
    // resolver must throw the platform error BEFORE the file-existence check.
    setPlatform("linux");
    process.env.ARGENT_SIMULATOR_SERVER_DIR = tmpRoot;
    const r = await loadResolver();
    expect(() => r.axServiceBinaryPath()).toThrow(/requires a macOS host/);
  });

  it("resolves the ax-service TCP binary on linux (remote upload artifact)", async () => {
    // The TCP ax-service is uploaded to and `simctl spawn`d on the remote Mac
    // orchestrator, so a Linux host must be able to resolve it — no darwin gate.
    setPlatform("linux");
    setArch("x64");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "ax-tcp-linux-"));
    const tcpDir = path.join(dir, "linux", "tcp");
    fs.mkdirSync(tcpDir, { recursive: true });
    const binPath = path.join(tcpDir, "ax-service");
    fs.writeFileSync(binPath, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(r.axServiceBinaryPathTcp()).toBe(binPath);
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

  it("includes a migration hint when ARGENT_SIMULATOR_SERVER_DIR points at the old flat layout", async () => {
    // Prior to the Linux per-platform layout, ARGENT_SIMULATOR_SERVER_DIR
    // was the directory that contained simulator-server directly. A user
    // with that setup now gets a "not found" error; the migration hint in
    // the message tells them exactly what changed and how to fix it.
    const dir = fs.mkdtempSync(path.join(tmpRoot, "flat-layout-"));
    fs.mkdirSync(path.join(dir, process.platform), { recursive: true });
    // Place the binary at the flat (old) path.
    const flatBin = path.join(dir, "simulator-server");
    fs.writeFileSync(flatBin, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(() => r.simulatorServerBinaryPath()).toThrow(/old flat path/);
    expect(() => r.simulatorServerBinaryPath()).toThrow(new RegExp(process.platform));
  });
});

describe("host platform key (arch-aware Linux bin dirs)", () => {
  // Linux binaries are single-arch ELFs (unlike the universal macOS binary),
  // so arm64 Linux resolves to its own "linux-arm64" directory while x86_64
  // keeps the pre-arm64 "linux" name. Without this split, an arm64 host would
  // silently pick up the x86_64 ELF and fail with ENOEXEC at spawn time.
  it("resolves bin/linux-arm64 on arm64 Linux", async () => {
    setPlatform("linux");
    setArch("arm64");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "linux-arm64-"));
    const platDir = path.join(dir, "linux-arm64");
    fs.mkdirSync(platDir, { recursive: true });
    const binPath = path.join(platDir, "simulator-server");
    fs.writeFileSync(binPath, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(r.hostPlatformKey()).toBe("linux-arm64");
    expect(r.simulatorServerBinaryPath()).toBe(binPath);
    expect(r.simulatorServerBinaryDir()).toBe(platDir);
  });

  it("keeps resolving bin/linux on x86_64 Linux", async () => {
    setPlatform("linux");
    setArch("x64");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "linux-x64-"));
    const platDir = path.join(dir, "linux");
    fs.mkdirSync(platDir, { recursive: true });
    const binPath = path.join(platDir, "simulator-server");
    fs.writeFileSync(binPath, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(r.hostPlatformKey()).toBe("linux");
    expect(r.simulatorServerBinaryPath()).toBe(binPath);
  });

  it("keeps resolving bin/darwin on arm64 macOS (universal binary)", async () => {
    setPlatform("darwin");
    setArch("arm64");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "darwin-arm64-"));
    const platDir = path.join(dir, "darwin");
    fs.mkdirSync(platDir, { recursive: true });
    const binPath = path.join(platDir, "simulator-server");
    fs.writeFileSync(binPath, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(r.hostPlatformKey()).toBe("darwin");
    expect(r.simulatorServerBinaryPath()).toBe(binPath);
  });

  it("names the linux-arm64 key in the missing-binary error", async () => {
    // The error must name the directory actually searched ("linux-arm64"),
    // not bare process.platform, so an arm64 user re-running the download
    // script can tell which asset is absent.
    setPlatform("linux");
    setArch("arm64");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "linux-arm64-missing-"));
    fs.mkdirSync(path.join(dir, "linux-arm64"), { recursive: true });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(() => r.simulatorServerBinaryPath()).toThrow(/linux-arm64/);
  });
});

describe("ax-service path resolution", () => {
  it("joins process.platform into the ax-service bin path", async () => {
    if (originalPlatform !== "darwin") return;
    const dir = fs.mkdtempSync(path.join(tmpRoot, "ax-platform-"));
    const platDir = path.join(dir, "darwin");
    fs.mkdirSync(platDir, { recursive: true });
    const binPath = path.join(platDir, "ax-service");
    fs.writeFileSync(binPath, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(r.axServiceBinaryPath()).toBe(binPath);
  });

  it("joins process.platform/tcp into the ax-service TCP bin path", async () => {
    if (originalPlatform !== "darwin") return;
    const dir = fs.mkdtempSync(path.join(tmpRoot, "ax-tcp-"));
    const tcpDir = path.join(dir, "darwin", "tcp");
    fs.mkdirSync(tcpDir, { recursive: true });
    const binPath = path.join(tcpDir, "ax-service");
    fs.writeFileSync(binPath, "", { mode: 0o755 });
    process.env.ARGENT_SIMULATOR_SERVER_DIR = dir;
    const r = await loadResolver();
    expect(r.axServiceBinaryPathTcp()).toBe(binPath);
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
