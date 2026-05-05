import { describe, it, expect, beforeEach, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

// `probe()` now special-cases adb / emulator to use `resolveAndroidBinary`
// (which adds an `$ANDROID_HOME` fallback on top of PATH). Mock the resolver
// so each test controls availability per-dep instead of fighting the host's
// real $ANDROID_HOME — otherwise a dev machine with the SDK installed would
// always report adb/emulator as available regardless of `stubProbe`.
const resolveAndroidBinaryMock = vi.fn();
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: (name: "adb" | "emulator") => resolveAndroidBinaryMock(name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import {
  DependencyMissingError,
  __resetDepCacheForTests,
  ensureDep,
  ensureDeps,
} from "../src/utils/check-deps";

/**
 * The real `command -v` uses execFile's error-on-nonzero-exit contract. We
 * mimic that: when the shell command would succeed, invoke the node-style
 * callback with `(null, stdout, stderr)`; when it would fail, pass an
 * Error. This matches how `promisify(execFile)` sees the result.
 */
function stubProbe(missing: readonly string[]): void {
  // PATH probe (used for xcrun and any non-Android dep): mock /bin/sh `command -v <dep>`
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const script = args[1] ?? "";
      const dep = script.replace("command -v ", "").trim();
      if (missing.includes(dep)) cb(new Error(`not found: ${dep}`));
      else cb(null, `/usr/bin/${dep}\n`, "");
    }
  );
  // Android resolver path (used for adb / emulator): return null when the
  // caller wants the dep treated as missing, otherwise an absolute path.
  resolveAndroidBinaryMock.mockImplementation(async (name: string) => {
    return missing.includes(name) ? null : `/usr/bin/${name}`;
  });
}

describe("check-deps", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    execFileMock.mockReset();
    resolveAndroidBinaryMock.mockReset();
  });

  it("returns without throwing when all deps are on PATH", async () => {
    stubProbe([]);
    await expect(ensureDeps(["xcrun", "adb"])).resolves.toBeUndefined();
  });

  it("throws DependencyMissingError listing only the missing deps", async () => {
    stubProbe(["adb"]);
    await expect(ensureDeps(["xcrun", "adb"])).rejects.toMatchObject({
      name: "DependencyMissingError",
      missing: ["adb"],
    });
  });

  it("reports all missing deps in a single error message when both are absent", async () => {
    stubProbe(["adb", "xcrun"]);
    try {
      await ensureDeps(["xcrun", "adb"]);
      expect.fail("expected ensureDeps to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(DependencyMissingError);
      const e = err as DependencyMissingError;
      expect(e.missing).toEqual(expect.arrayContaining(["adb", "xcrun"]));
      expect(e.message).toMatch(/xcode-select --install/);
      expect(e.message).toMatch(/android-platform-tools/);
    }
  });

  it("caches probe results within the TTL so a burst of calls shells out once per dep", async () => {
    stubProbe([]);
    await ensureDeps(["xcrun"]);
    await ensureDeps(["xcrun"]);
    await ensureDeps(["xcrun"]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the deps array is empty", async () => {
    stubProbe([]);
    await ensureDeps([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("ensureDep is the single-dep form of ensureDeps", async () => {
    stubProbe(["xcrun"]);
    await expect(ensureDep("xcrun")).rejects.toBeInstanceOf(DependencyMissingError);
  });
});
