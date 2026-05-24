import { beforeEach, describe, expect, it, vi } from "vitest";
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

// Mock the iOS 26.5+ AX-bypass plumbing at the module boundary so this test
// pins boot-device's dispatch contract (state probe → pre-boot if shutdown →
// boot → ensureAutomationEnabled fallback → native-devtools → open) without
// dragging the plist/kickstart implementation into the exec-call assertions.
// Implementation behaviour for those helpers is covered by ax-service tests.
const listIosSimulatorsMock = vi.fn();
const setAccessibilityPrefsPreBootMock = vi.fn();
const ensureAutomationEnabledMock = vi.fn();

vi.mock("../src/utils/ios-devices", () => ({
  listIosSimulators: (...args: unknown[]) => listIosSimulatorsMock(...args),
}));

vi.mock("../src/blueprints/ax-service", () => ({
  setAccessibilityPrefsPreBoot: (...args: unknown[]) => setAccessibilityPrefsPreBootMock(...args),
  ensureAutomationEnabled: (...args: unknown[]) => ensureAutomationEnabledMock(...args),
}));

import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

describe("boot-device — iOS path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pre-warm the dep cache so `ensureDep('xcrun')` doesn't probe PATH and
    // add an extra first `command -v xcrun` call to mockExecFile.
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      getCallback(args)(null, "", "");
      return {} as never;
    });
    // Default: sim is Shutdown so the happy path (pre-boot plist write, no
    // post-boot kickstart needed) runs. Individual tests override.
    listIosSimulatorsMock.mockReset().mockResolvedValue([
      { udid: "11111111-1111-1111-1111-111111111111", state: "Shutdown" },
      { udid: "22222222-2222-2222-2222-222222222222", state: "Booted" },
      { udid: "33333333-3333-3333-3333-333333333333", state: "Shutdown" },
    ]);
    setAccessibilityPrefsPreBootMock.mockReset().mockResolvedValue(undefined);
    ensureAutomationEnabledMock.mockReset().mockResolvedValue(undefined);
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

    // Pre-boot plist write must fire BEFORE simctl boot — that's the whole
    // point of approach (B): SpringBoard reads the pref at first init.
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledTimes(1);
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111"
    );
    expect(setAccessibilityPrefsPreBootMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[0]
    );
    // ensureAutomationEnabled still fires as a defense-in-depth no-op, but the
    // pref is already set on disk so its internal kickstart-branch is skipped.
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
      { device: { id: "11111111-1111-1111-1111-111111111111", platform: "ios", kind: "simulator" } }
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

    // Sim was Booted before we touched it: SB's AX server already cached the
    // pref at its prior boot, so the pre-boot write would be undone by
    // cfprefsd flushes. Skip it; rely on ensureAutomationEnabled's
    // kickstart-if-needed branch to flip the bypass live.
    expect(setAccessibilityPrefsPreBootMock).not.toHaveBeenCalled();
    expect(ensureAutomationEnabledMock).toHaveBeenCalledWith(
      "22222222-2222-2222-2222-222222222222"
    );
  });

  it("still runs the fallback ensureAutomationEnabled when the state probe fails", async () => {
    // simctl unavailable or udid unknown — listIosSimulators returns []
    // (its own try/catch swallows errors). We must not block boot on the
    // probe; let it fall through and rely on ensureAutomationEnabled, which
    // self-detects whether a kickstart is needed.
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
    // If plutil is missing or the data container is read-only, log to stderr
    // and keep going — ensureAutomationEnabled will still apply the bypass
    // (with a kickstart) on the post-boot side.
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
      { device: { id: "22222222-2222-2222-2222-222222222222", platform: "ios", kind: "simulator" } }
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
