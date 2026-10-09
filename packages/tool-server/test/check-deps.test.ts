import { describe, it, expect, beforeEach, vi } from "vitest";

// `probe()` resolves PATH deps (xcrun, etc.) through `commandOnPath`, which
// abstracts the `command -v` (POSIX) / `where` (Windows) difference. Mock it so
// these tests stay platform-agnostic instead of asserting a `/bin/sh` shape
// that wouldn't run on a Windows host.
const commandOnPathMock = vi.fn();
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: (name: string) => commandOnPathMock(name),
}));

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
 * `commandOnPath` returns the resolved absolute path on a hit, or `null` on a
 * miss. Both the PATH probe (xcrun) and the Android resolver follow that
 * contract, so model them the same way: `null` for a dep the test wants
 * treated as missing, an absolute path otherwise.
 */
function stubProbe(missing: readonly string[]): void {
  commandOnPathMock.mockImplementation(async (name: string) =>
    missing.includes(name) ? null : `/usr/bin/${name}`
  );
  resolveAndroidBinaryMock.mockImplementation(async (name: string) => {
    return missing.includes(name) ? null : `/usr/bin/${name}`;
  });
}

describe("check-deps", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    commandOnPathMock.mockReset();
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
    expect(commandOnPathMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the deps array is empty", async () => {
    stubProbe([]);
    await ensureDeps([]);
    expect(commandOnPathMock).not.toHaveBeenCalled();
  });

  it("ensureDep is the single-dep form of ensureDeps", async () => {
    stubProbe(["xcrun"]);
    await expect(ensureDep("xcrun")).rejects.toBeInstanceOf(DependencyMissingError);
  });
});

/**
 * These strings are handed to an agent as remediation, and it will run what
 * they say. A command that only exists on the author's machine is not a hint —
 * it is a wrong instruction, which is how #641 happened.
 */
describe("install hints are runnable wherever they are read", () => {
  // `vega` resolves through its own SDK-aware lookup, which this file's probe
  // stub does not intercept; its hint names no package manager anyway.
  const DEPS = ["adb", "xcrun", "emulator", "sim-remote"] as const;

  // `brew` on Linux, `apt` on macOS: fine as a labelled example, wrong as the
  // instruction. Each must sit next to the platform it belongs to.
  const PACKAGE_MANAGERS = [
    { command: /brew install/, platform: /macOS/ },
    { command: /\bapt install/, platform: /Debian|Ubuntu/ },
    { command: /\bdnf install/, platform: /Fedora|RPM/ },
    { command: /\bpacman -S/, platform: /Arch/ },
  ];

  async function hintFor(dep: (typeof DEPS)[number]): Promise<string> {
    stubProbe([dep]);
    try {
      await ensureDeps([dep]);
      throw new Error(`expected ensureDeps to reject for ${dep}`);
    } catch (err) {
      if (!(err instanceof DependencyMissingError)) throw err;
      return err.message;
    }
  }

  it.each(DEPS)("%s names a package manager only alongside its platform", async (dep) => {
    const hint = await hintFor(dep);
    for (const { command, platform } of PACKAGE_MANAGERS) {
      if (command.test(hint)) {
        expect(hint, `${dep}: "${command.source}" needs its platform named`).toMatch(platform);
      }
    }
  });

  it("tells an Android user where to get the SDK without assuming a package manager", async () => {
    // The route that works on every host, for the reader who has no SDK at all.
    for (const dep of ["adb", "emulator"] as const) {
      const hint = await hintFor(dep);
      expect(hint, dep).toMatch(/SDK Manager|developer\.android\.com/);
      expect(hint, dep).toMatch(/\$ANDROID_HOME/);
    }
  });

  it("leads the xcrun hint with the requirement a non-macOS reader cannot satisfy", async () => {
    // `xcrun` is reachable off macOS (a device id is classified by shape), so
    // the disqualifier has to come before the command.
    const hint = await hintFor("xcrun");
    expect(hint).toMatch(/macOS host/);
    expect(hint.indexOf("macOS host")).toBeLessThan(hint.indexOf("xcode-select"));
  });
});
