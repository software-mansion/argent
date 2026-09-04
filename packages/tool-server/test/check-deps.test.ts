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

// The two HarmonyOS deps ship inside DevEco Studio rather than on PATH, so they
// probe through their own resolvers. Mocked for the same reason as the Android
// pair above: a dev machine with DevEco installed would report them available
// however the test stubs PATH.
const resolveHdcMock = vi.fn();
const resolveHarmonyEmulatorMock = vi.fn();
vi.mock("../src/utils/harmony-hdc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-hdc")>()),
  resolveHdc: () => resolveHdcMock(),
}));
vi.mock("../src/utils/harmony-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-cli")>()),
  resolveHarmonyEmulator: () => resolveHarmonyEmulatorMock(),
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
    resolveHdcMock.mockReset().mockResolvedValue("/deveco/hdc");
    resolveHarmonyEmulatorMock.mockReset().mockResolvedValue("/deveco/Emulator");
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

  // Neither HarmonyOS dep is a PATH binary on an IDE install: `hdc` lives under
  // the SDK and the manager is named `Emulator`, too generic to match on PATH.
  // Probed through `commandOnPath` they read as missing on every machine that
  // has DevEco Studio, gating the whole platform off behind a 424.
  it("probes the HarmonyOS deps through the DevEco resolvers, not PATH", async () => {
    stubProbe(["hdc", "Emulator", "harmony-emulator"]);

    await expect(ensureDeps(["hdc", "harmony-emulator"])).resolves.toBeUndefined();
    expect(commandOnPathMock).not.toHaveBeenCalledWith("hdc");
    expect(commandOnPathMock).not.toHaveBeenCalledWith("harmony-emulator");
  });

  it("reports each HarmonyOS dep as missing when its own resolver finds nothing", async () => {
    stubProbe([]);
    resolveHdcMock.mockResolvedValue(null);
    resolveHarmonyEmulatorMock.mockResolvedValue(null);

    // The hint is the whole value of the 424: it names DevEco Studio and
    // `$DEVECO_STUDIO_HOME`, which is the only way to point at a non-macOS
    // install. A caller told merely "hdc is missing" has nowhere to go.
    await expect(ensureDep("hdc")).rejects.toThrow(/DEVECO_STUDIO_HOME/);
    await expect(ensureDep("harmony-emulator")).rejects.toBeInstanceOf(DependencyMissingError);
  });
});
