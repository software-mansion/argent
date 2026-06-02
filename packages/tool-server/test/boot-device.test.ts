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
    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));
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
  });

  it("skips pre-boot plist write when the sim is already Booted and falls back to ensureAutomationEnabled", async () => {
    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));
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

    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));
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

    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));
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

    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));
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
    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));
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
    const resolveService = vi.fn(async () => ({ getInitFailure: () => null }));
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
    ).rejects.toThrow(/exactly one of `udid` .* or `avdName`/);
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
