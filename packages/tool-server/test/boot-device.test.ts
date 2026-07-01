import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";

type ExecFileCallback = (error: Error | null, stdout?: string, stderr?: string) => void;

const mockExecFile = vi.fn();

function getCallback(args: unknown[]): ExecFileCallback {
  const callback = args[args.length - 1];
  if (typeof callback !== "function") {
    throw new Error("Missing execFile callback");
  }
  return callback as ExecFileCallback;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

// Mock the AX-bypass helpers at the module boundary so this file asserts
// boot-device's dispatch (state probe → pre-boot if shutdown → boot →
// ensureAutomationEnabled fallback → native-devtools → open) without pulling
// plist/kickstart internals into the exec-call sequence.
const listIosSimulatorsMock = vi.fn();
const setAccessibilityPrefsPreBootMock = vi.fn();
const ensureAutomationEnabledMock = vi.fn();
const isEntitlementBypassActiveMock = vi.fn();

vi.mock("../src/utils/ios-devices", () => ({
  listIosSimulators: (...args: unknown[]) => listIosSimulatorsMock(...args),
}));

vi.mock("../src/blueprints/ax-service", () => ({
  setAccessibilityPrefsPreBoot: (...args: unknown[]) => setAccessibilityPrefsPreBootMock(...args),
  ensureAutomationEnabled: (...args: unknown[]) => ensureAutomationEnabledMock(...args),
  isEntitlementBypassActive: (...args: unknown[]) => isEntitlementBypassActiveMock(...args),
}));

import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

describe("boot-device — iOS path", () => {
  // The iOS path is only reachable on darwin (boot-device now refuses iOS
  // udids on non-darwin hosts so a Linux user gets a clear "iOS requires
  // macOS" message instead of a misleading xcode-select hint). These tests
  // exercise the post-gate code path, so override process.platform for the
  // duration of the suite — restored after each test to avoid leaking the
  // override into other test files run in the same vitest worker.
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.clearAllMocks();
    // Pre-warm the dep cache so `ensureDep('xcrun')` doesn't probe PATH and
    // add an extra first `command -v xcrun` call to mockExecFile.
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      getCallback(args)(null, "", "");
      return {} as never;
    });
    // Default state: 11111111 + 33333333 Shutdown (happy path), 22222222
    // Booted (kickstart-fallback path). Individual tests override.
    listIosSimulatorsMock.mockReset().mockResolvedValue([
      { udid: "11111111-1111-1111-1111-111111111111", state: "Shutdown" },
      { udid: "22222222-2222-2222-2222-222222222222", state: "Booted" },
      { udid: "33333333-3333-3333-3333-333333333333", state: "Shutdown" },
    ]);
    setAccessibilityPrefsPreBootMock.mockReset().mockResolvedValue(undefined);
    ensureAutomationEnabledMock.mockReset().mockResolvedValue(undefined);
    isEntitlementBypassActiveMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("pre-boots AX prefs on a Shutdown sim then waits for boot completion and native-devtools init", async () => {
    const reverifyEnv = vi.fn(async () => {});
    const resolveService = vi.fn(async () => ({ getInitFailure: () => null, reverifyEnv }));
    const registry = {
      resolveService,
    } as unknown as Registry;

    const tool = createBootDeviceTool(registry);

    await expect(
      tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111" })
    ).resolves.toEqual({
      platform: "ios",
      udid: "11111111-1111-1111-1111-111111111111",
      booted: true,
    });

    // Pre-boot write must precede `simctl boot` so SB inherits the bypass at
    // first init; ensureAutomationEnabled then runs as a defense-in-depth
    // no-op (pref already cached, kickstart branch skipped).
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledTimes(1);
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111"
    );
    expect(setAccessibilityPrefsPreBootMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[0]
    );
    expect(ensureAutomationEnabledMock).toHaveBeenCalledTimes(1);
    expect(ensureAutomationEnabledMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111"
    );

    expect(mockExecFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["xcrun", ["simctl", "boot", "11111111-1111-1111-1111-111111111111"]],
      ["xcrun", ["simctl", "bootstatus", "11111111-1111-1111-1111-111111111111", "-b"]],
      [
        "defaults",
        [
          "write",
          "com.apple.iphonesimulator",
          "CurrentDeviceUDID",
          "11111111-1111-1111-1111-111111111111",
        ],
      ],
      ["open", ["-a", "Simulator.app"]],
    ]);
    expect(resolveService).toHaveBeenCalledWith(
      "NativeDevtools:11111111-1111-1111-1111-111111111111",
      {
        device: { id: "11111111-1111-1111-1111-111111111111", platform: "ios", kind: "simulator" },
        transport: "unix",
      }
    );
    // NativeDevtools must be primed AFTER bootstatus returns (launchd env is
    // only reachable once the simulator is fully up) and BEFORE `open`, so
    // the UI reflects the injected state on first paint.
    expect(resolveService.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockExecFile.mock.invocationCallOrder[1]
    );
    expect(resolveService.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[2]
    );
    // The (re)boot wipes launchd's DYLD_INSERT_LIBRARIES; boot-device must
    // force a re-apply so a cached/latched native-devtools service can't leave
    // the env unset (which would make the next launch uninjected).
    expect(reverifyEnv).toHaveBeenCalledOnce();
  });

  it("with headless:true boots the sim core but does NOT open Simulator.app", async () => {
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await expect(
      tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111", headless: true })
    ).resolves.toEqual({
      platform: "ios",
      udid: "11111111-1111-1111-1111-111111111111",
      booted: true,
    });

    const calls = mockExecFile.mock.calls.map(([file, args]) => [file, args]);
    // The core still boots (simctl boot + bootstatus) and the default device is
    // set, but `open -a Simulator.app` is skipped — the GUI window never opens.
    expect(calls).toEqual([
      ["xcrun", ["simctl", "boot", "11111111-1111-1111-1111-111111111111"]],
      ["xcrun", ["simctl", "bootstatus", "11111111-1111-1111-1111-111111111111", "-b"]],
      [
        "defaults",
        [
          "write",
          "com.apple.iphonesimulator",
          "CurrentDeviceUDID",
          "11111111-1111-1111-1111-111111111111",
        ],
      ],
    ]);
    expect(calls).not.toContainEqual(["open", ["-a", "Simulator.app"]]);
  });

  it("skips pre-boot plist write when the sim is already Booted and falls back to ensureAutomationEnabled", async () => {
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: "22222222-2222-2222-2222-222222222222" });

    // Already-Booted sim: in-sim cfprefsd would overwrite the host write, so
    // skip it. ensureAutomationEnabled writes prefs best-effort (no kickstart).
    expect(setAccessibilityPrefsPreBootMock).not.toHaveBeenCalled();
    expect(ensureAutomationEnabledMock).toHaveBeenCalledWith(
      "22222222-2222-2222-2222-222222222222"
    );
  });

  it("still runs the fallback ensureAutomationEnabled when the state probe fails", async () => {
    // listIosSimulators returns [] on xcrun failure / unknown udid; boot must
    // not block on the probe — fall through to ensureAutomationEnabled which
    // writes prefs best-effort.
    listIosSimulatorsMock.mockResolvedValueOnce([]);

    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: "44444444-4444-4444-4444-444444444444" });

    expect(setAccessibilityPrefsPreBootMock).not.toHaveBeenCalled();
    expect(ensureAutomationEnabledMock).toHaveBeenCalledWith(
      "44444444-4444-4444-4444-444444444444"
    );
  });

  it("does not block boot on a pre-boot plist write failure", async () => {
    // plutil missing / data container read-only: log and continue;
    // ensureAutomationEnabled writes prefs best-effort post-boot.
    setAccessibilityPrefsPreBootMock.mockRejectedValueOnce(new Error("plutil missing"));

    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await expect(
      tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111" })
    ).resolves.toEqual({
      platform: "ios",
      udid: "11111111-1111-1111-1111-111111111111",
      booted: true,
    });

    expect(ensureAutomationEnabledMock).toHaveBeenCalled();
  });

  it("returns a structured init_failed result when native-devtools has given up", async () => {
    const resolveService = vi.fn(async () => ({
      reverifyEnv: async () => {},
      getInitFailure: () => ({
        attempts: 3,
        lastError: "simctl spawn timed out",
        givenUp: true,
      }),
    }));
    const registry = { resolveService } as unknown as Registry;

    const tool = createBootDeviceTool(registry);

    const result = await tool.execute!({}, { udid: "33333333-3333-3333-3333-333333333333" });
    expect(result).toMatchObject({ status: "init_failed", attempts: 3 });
    if ("status" in result && result.status === "init_failed") {
      expect(result.message).toContain("33333333-3333-3333-3333-333333333333");
      expect(result.message).toContain("simctl spawn timed out");
    }
    // Opening Simulator.app would imply success — must not happen.
    const calls = mockExecFile.mock.calls.map(([file]) => file);
    expect(calls).not.toContain("open");
  });

  it("still primes native-devtools when simctl reports the simulator is already booted", async () => {
    mockExecFile
      .mockImplementationOnce((...args: unknown[]) => {
        getCallback(args)(new Error("Unable to boot device in current state: Booted"));
        return {} as never;
      })
      .mockImplementation((...args: unknown[]) => {
        getCallback(args)(null, "", "");
        return {} as never;
      });

    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;

    const tool = createBootDeviceTool(registry);

    await expect(
      tool.execute!({}, { udid: "22222222-2222-2222-2222-222222222222" })
    ).resolves.toEqual({
      platform: "ios",
      udid: "22222222-2222-2222-2222-222222222222",
      booted: true,
    });

    expect(mockExecFile.mock.calls[1]?.slice(0, 2)).toEqual([
      "xcrun",
      ["simctl", "bootstatus", "22222222-2222-2222-2222-222222222222", "-b"],
    ]);
    expect(resolveService).toHaveBeenCalledWith(
      "NativeDevtools:22222222-2222-2222-2222-222222222222",
      {
        device: { id: "22222222-2222-2222-2222-222222222222", platform: "ios", kind: "simulator" },
        transport: "unix",
      }
    );
  });

  it("force=true on a Booted sim triggers shutdown → pre-boot write → boot", async () => {
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await expect(
      tool.execute!({}, { udid: "22222222-2222-2222-2222-222222222222", force: true })
    ).resolves.toEqual({
      platform: "ios",
      udid: "22222222-2222-2222-2222-222222222222",
      booted: true,
    });

    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledWith(
      "22222222-2222-2222-2222-222222222222"
    );
    const execCalls = mockExecFile.mock.calls.map(([file, args]) => [file, args]);
    expect(execCalls[0]).toEqual([
      "xcrun",
      ["simctl", "shutdown", "22222222-2222-2222-2222-222222222222"],
    ]);
    expect(execCalls[1]).toEqual([
      "xcrun",
      ["simctl", "boot", "22222222-2222-2222-2222-222222222222"],
    ]);
  });

  it("force not set on a Booted sim does not shut down", async () => {
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: "22222222-2222-2222-2222-222222222222" });

    expect(setAccessibilityPrefsPreBootMock).not.toHaveBeenCalled();
    const execCalls = mockExecFile.mock.calls.map(([, args]) => args);
    const hasShutdown = execCalls.some(
      (args: unknown[]) => Array.isArray(args) && args[1] === "shutdown"
    );
    expect(hasShutdown).toBe(false);
  });

  // A tvOS reboot orphans the host-side tvos-hid-daemon (it holds a
  // SimDeviceLegacyClient bound to the prior boot for its whole lifetime, so a
  // TV `button` press silently no-ops afterward). boot-device must drop the
  // cached TvControl service on a boot transition so the next TV call rebuilds
  // it against the fresh boot. The ax-service self-heals (it runs inside the
  // sim and the reboot kills it), so it doesn't need this.
  const TV_UDID = "77777777-7777-7777-7777-777777777777";

  it("disposes the cached TvControl service when a tvOS sim is booted from Shutdown", async () => {
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Shutdown", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: TV_UDID });

    expect(disposeService).toHaveBeenCalledWith(`TvControl:${TV_UDID}`);
  });

  it("disposes the cached TvControl service on a tvOS force reboot", async () => {
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Booted", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: TV_UDID, force: true });

    expect(disposeService).toHaveBeenCalledWith(`TvControl:${TV_UDID}`);
  });

  it("does NOT dispose TvControl for an iOS (non-tv) sim boot — that daemon self-heals", async () => {
    // Default mock list has no runtimeKind:"tv" entry, so the iOS path must
    // never touch disposeService.
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111" });

    expect(disposeService).not.toHaveBeenCalled();
  });

  it("swallows ServiceNotFoundError when no TvControl service is cached (fresh tvOS boot)", async () => {
    const { ServiceNotFoundError } = await import("@argent/registry");
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Shutdown", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => {
      throw new ServiceNotFoundError(`TvControl:${TV_UDID}`);
    });
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    // The not-found case is the common fresh-boot path and must not fail boot.
    await expect(tool.execute!({}, { udid: TV_UDID })).resolves.toEqual({
      platform: "ios",
      udid: TV_UDID,
      booted: true,
    });
    expect(disposeService).toHaveBeenCalledWith(`TvControl:${TV_UDID}`);
  });

  // The same boot transition wipes launchd DYLD_INSERT_LIBRARIES, but the
  // cached NativeDevtools service's sticky envSetup flag stops ensureEnvReady
  // from re-applying it — so injection stays dead until the service is rebuilt.
  // boot-device must drop the cached NativeDevtools service on a boot transition
  // (alongside TvControl) so the resolveService rebuild re-runs ensureEnv.
  it("disposes the cached NativeDevtools service when a tvOS sim is booted from Shutdown", async () => {
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Shutdown", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: TV_UDID });

    expect(disposeService).toHaveBeenCalledWith(`NativeDevtools:${TV_UDID}`);
  });

  it("disposes the cached NativeDevtools service on a tvOS force reboot", async () => {
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Booted", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: TV_UDID, force: true });

    expect(disposeService).toHaveBeenCalledWith(`NativeDevtools:${TV_UDID}`);
  });

  it("disposes the stale NativeDevtools service BEFORE re-resolving it on reboot", async () => {
    // The rebuild only re-runs ensureEnv if the dispose happens first; assert
    // the order so a future refactor can't silently resolve the stale instance.
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Shutdown", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async (_urn: string) => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async (_urn: string) => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: TV_UDID });

    const ndDisposeOrder =
      disposeService.mock.invocationCallOrder[
        disposeService.mock.calls.findIndex(([urn]) => urn === `NativeDevtools:${TV_UDID}`)
      ];
    const ndResolveOrder =
      resolveService.mock.invocationCallOrder[
        resolveService.mock.calls.findIndex(([urn]) => urn === `NativeDevtools:${TV_UDID}`)
      ];
    expect(ndDisposeOrder).toBeLessThan(ndResolveOrder);
  });

  it("swallows ServiceNotFoundError when no NativeDevtools service is cached (fresh tvOS boot)", async () => {
    const { ServiceNotFoundError } = await import("@argent/registry");
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Shutdown", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async (urn: string) => {
      // Both TvControl and NativeDevtools may be uncached on a fresh boot; the
      // ND not-found must not fail boot any more than the TvControl one does.
      if (urn === `NativeDevtools:${TV_UDID}`) {
        throw new ServiceNotFoundError(urn);
      }
      return undefined;
    });
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await expect(tool.execute!({}, { udid: TV_UDID })).resolves.toEqual({
      platform: "ios",
      udid: TV_UDID,
      booted: true,
    });
    expect(disposeService).toHaveBeenCalledWith(`NativeDevtools:${TV_UDID}`);
  });

  it("does NOT dispose NativeDevtools for an iOS (non-tv) sim boot (gated to tvOS)", async () => {
    // The validated repro is tvOS-only and the iOS boot path is heavily
    // exercised by callers passing a registry without disposeService — the
    // gate must keep the iOS path untouched.
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111" });

    expect(disposeService).not.toHaveBeenCalledWith(
      "NativeDevtools:11111111-1111-1111-1111-111111111111"
    );
  });
});

describe("boot-device — input validation (exclusive udid/avdName)", () => {
  // The zodSchema marks both udid and avdName as optional so the JSON schema
  // advertises both; the execute function enforces that exactly one is set.
  // These tests pin the mutual-exclusion rule at the execute boundary where
  // callers actually hit it.

  it("rejects when both udid and avdName are provided — ambiguous target", async () => {
    const tool = createBootDeviceTool({ resolveService: async () => {} } as unknown as Registry);
    await expect(
      tool.execute!(
        {},
        {
          udid: "11111111-1111-1111-1111-111111111111",
          avdName: "Pixel_7_API_34",
        }
      )
    ).rejects.toThrow(/exactly one of `udid`/);
  });

  it("rejects when neither udid nor avdName is provided — no target", async () => {
    const tool = createBootDeviceTool({ resolveService: async () => {} } as unknown as Registry);
    await expect(tool.execute!({}, {})).rejects.toThrow(/exactly one of `udid`/);
  });

  it("bounds bootTimeoutMs to [30s, 15min]", () => {
    // Timeouts should fail at the zod layer before reaching execute.
    const tool = createBootDeviceTool({} as unknown as Registry);
    expect(tool.zodSchema!.safeParse({ avdName: "x", bootTimeoutMs: 29_999 }).success).toBe(false);
    expect(tool.zodSchema!.safeParse({ avdName: "x", bootTimeoutMs: 900_001 }).success).toBe(false);
    expect(tool.zodSchema!.safeParse({ avdName: "x", bootTimeoutMs: 60_000 }).success).toBe(true);
  });
});

// Non-darwin hosts that receive an iOS udid must get a clear "iOS requires
// macOS" error — NOT the legacy "install xcode-select" hint, which would send
// a Linux user chasing a tool that has no Linux build. This regression test
// pins that branch so a future refactor of bootIos doesn't quietly drop the
// platform check.
describe("boot-device — iOS udid on non-darwin", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.clearAllMocks();
    __resetDepCacheForTests();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("rejects with a platform-specific message that names the correct fix", async () => {
    const tool = createBootDeviceTool({ resolveService: async () => ({}) } as unknown as Registry);
    await expect(
      tool.execute!({}, { udid: "deadbeef-dead-beef-dead-beefdeadbeef" })
    ).rejects.toThrow(/iOS Simulator is unavailable on linux.*requires a macOS host/);
    // The misleading legacy hint must NOT appear: a Linux user shouldn't be
    // told to install xcode-select, which has no Linux build.
    await expect(
      tool.execute!({}, { udid: "deadbeef-dead-beef-dead-beefdeadbeef" })
    ).rejects.not.toThrow(/xcode-select/);
  });
});
