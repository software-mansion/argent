import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";

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

// Which GUI app the active Xcode ships decides how boot-device shows the device.
const DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
const SIMULATOR_APP = `${DEVELOPER_DIR}/Applications/Simulator.app`;
const DEVICE_HUB_APP = "/Applications/Xcode.app/Contents/Applications/DeviceHub.app";
const existsSyncMock = vi.hoisted(() => vi.fn());

// Only the Xcode app lookups are faked; modules that probe other paths at
// import time still see the real filesystem.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const isXcodePath = (path: string) => path.startsWith("/Applications/Xcode.app/");
  return {
    ...actual,
    existsSync: (path: string) =>
      isXcodePath(path) ? existsSyncMock(path) : actual.existsSync(path),
    realpathSync: (path: string) => (isXcodePath(path) ? path : actual.realpathSync(path)),
  };
});

// Mock the AX-bypass helpers at the module boundary so this file asserts
// boot-device's dispatch (state probe → pre-boot if shutdown → boot →
// clearAutomationEnabledOrWarn → native-devtools → open) without pulling
// plist/kickstart internals into the exec-call sequence.
const scannedSimulatorsMock = vi.fn();
const setAccessibilityPrefsPreBootMock = vi.fn();
const clearAutomationEnabledOrWarnMock = vi.fn();
const ensureAutomationEnabledMock = vi.fn();
const isEntitlementBypassActiveMock = vi.fn();

let scanTimedOut = false;

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  scanIosSimulators: async () => ({
    simulators: await scannedSimulatorsMock(),
    timedOut: scanTimedOut,
  }),
}));

vi.mock("../src/utils/ax-prefs", () => ({
  setAccessibilityPrefsPreBoot: (...args: unknown[]) => setAccessibilityPrefsPreBootMock(...args),
  clearAutomationEnabledOrWarn: (...args: unknown[]) => clearAutomationEnabledOrWarnMock(...args),
  ensureAutomationEnabled: (...args: unknown[]) => ensureAutomationEnabledMock(...args),
  isEntitlementBypassActive: (...args: unknown[]) => isEntitlementBypassActiveMock(...args),
}));

// The launch-crash record lives in the real ~/.argent; its own suite covers it.
const launchSimulatorAppMock = vi.hoisted(() => vi.fn());
vi.mock("../src/utils/simulator-app-launch", () => ({
  launchSimulatorApp: (...args: unknown[]) => launchSimulatorAppMock(...args),
}));

import { createHttpApp } from "../src/http";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { InvalidToolInputError } from "../src/utils/capability";
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
      // A mocked execFile has no promisify.custom, so promisify resolves the
      // second callback argument as-is: pass the { stdout } shape it reads.
      const stdout = args[0] === "xcode-select" ? `${DEVELOPER_DIR}\n` : "";
      getCallback(args)(null, { stdout, stderr: "" } as never);
      return {} as never;
    });
    existsSyncMock.mockReset().mockImplementation((path: string) => path === SIMULATOR_APP);
    launchSimulatorAppMock
      .mockReset()
      .mockImplementation(async (_app: string, launch: () => Promise<unknown>) => {
        await launch();
        return true;
      });
    // Default state: 11111111 + 33333333 Shutdown (happy path), 22222222
    // Booted (kickstart-fallback path). Individual tests override.
    scanTimedOut = false;
    scannedSimulatorsMock.mockReset().mockResolvedValue([
      { udid: "11111111-1111-1111-1111-111111111111", state: "Shutdown" },
      { udid: "22222222-2222-2222-2222-222222222222", state: "Booted" },
      { udid: "33333333-3333-3333-3333-333333333333", state: "Shutdown" },
    ]);
    setAccessibilityPrefsPreBootMock.mockReset().mockResolvedValue(undefined);
    clearAutomationEnabledOrWarnMock.mockReset().mockResolvedValue(undefined);
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
    // first init.
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledTimes(1);
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { isTvOs: false }
    );
    expect(setAccessibilityPrefsPreBootMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecFile.mock.invocationCallOrder[0]
    );
    expect(clearAutomationEnabledOrWarnMock).toHaveBeenCalledTimes(1);
    expect(clearAutomationEnabledOrWarnMock).toHaveBeenCalledWith(
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
      ["xcode-select", ["-p"]],
      ["open", ["-a", SIMULATOR_APP]],
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
    expect(calls.map(([file]) => file)).not.toContain("open");
  });

  it("with ARGENT_SIMULATOR_NO_WINDOW set does NOT open Simulator.app even without headless:true", async () => {
    // Host-wide iOS analog of ARGENT_EMULATOR_NO_WINDOW: the env var forces the
    // GUI-attach skip so CI/Lens hosts don't pass `headless` on every call.
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    const prev = process.env.ARGENT_SIMULATOR_NO_WINDOW;
    process.env.ARGENT_SIMULATOR_NO_WINDOW = "1";
    try {
      await expect(
        tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111" })
      ).resolves.toEqual({
        platform: "ios",
        udid: "11111111-1111-1111-1111-111111111111",
        booted: true,
      });
    } finally {
      if (prev === undefined) delete process.env.ARGENT_SIMULATOR_NO_WINDOW;
      else process.env.ARGENT_SIMULATOR_NO_WINDOW = prev;
    }

    const calls = mockExecFile.mock.calls.map(([file, args]) => [file, args]);
    expect(calls.map(([file]) => file)).not.toContain("open");
  });

  describe("GUI window", () => {
    const udid = "11111111-1111-1111-1111-111111111111";
    const registry = {
      resolveService: async () => ({ getInitFailure: () => null, reverifyEnv: async () => {} }),
    } as unknown as Registry;
    const openCalls = () =>
      mockExecFile.mock.calls
        .filter(([file]) => file === "open")
        .map(([file, args]) => [file, args]);

    it("opens the booted device in the active Xcode's Device Hub when it has no Simulator.app", async () => {
      existsSyncMock.mockImplementation((path: string) => path === DEVICE_HUB_APP);

      await createBootDeviceTool(registry).execute!({}, { udid });

      expect(openCalls()).toEqual([
        ["open", ["-a", DEVICE_HUB_APP, `devices://device/open?id=${udid}`]],
      ]);
    });

    it("opens nothing when the active Xcode ships neither app", async () => {
      existsSyncMock.mockReturnValue(false);

      await expect(createBootDeviceTool(registry).execute!({}, { udid })).resolves.toMatchObject({
        booted: true,
      });
      expect(openCalls()).toEqual([]);
    });

    it("still reports the boot when the app fails to open", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const stdout = args[0] === "xcode-select" ? `${DEVELOPER_DIR}\n` : "";
        getCallback(args)(args[0] === "open" ? new Error("LaunchServices error") : null, {
          stdout,
          stderr: "",
        } as never);
        return {} as never;
      });

      await expect(createBootDeviceTool(registry).execute!({}, { udid })).resolves.toMatchObject({
        booted: true,
      });
      expect(openCalls()).toEqual([["open", ["-a", SIMULATOR_APP]]]);
    });

    it("does not open a Simulator.app on record as crashing at launch, nor Device Hub", async () => {
      existsSyncMock.mockImplementation(
        (path: string) => path === SIMULATOR_APP || path === DEVICE_HUB_APP
      );
      launchSimulatorAppMock.mockResolvedValue(false);

      await expect(createBootDeviceTool(registry).execute!({}, { udid })).resolves.toEqual({
        platform: "ios",
        udid,
        booted: true,
        note: `${SIMULATOR_APP} exits right after launch on this host, so Argent no longer opens it and the device runs without a window. Delete ~/.argent/simulator-app-launch.json to try opening it again.`,
      });
      expect(launchSimulatorAppMock).toHaveBeenCalledWith(SIMULATOR_APP, expect.any(Function));
      expect(openCalls()).toEqual([]);
    });

    it("hands over a launch that settles only once open has", async () => {
      let launch: () => Promise<unknown> = async () => undefined;
      launchSimulatorAppMock.mockImplementation(
        async (_app: string, fn: () => Promise<unknown>) => {
          launch = fn;
          return true;
        }
      );
      await createBootDeviceTool(registry).execute!({}, { udid });

      let finishOpen = () => {};
      mockExecFile.mockImplementation((...args: unknown[]) => {
        finishOpen = () => getCallback(args)(null, { stdout: "", stderr: "" } as never);
        return {} as never;
      });
      let settled = false;
      const launched = launch().finally(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      finishOpen();
      await launched;
      expect(openCalls()).toEqual([["open", ["-a", SIMULATOR_APP]]]);
    });

    it("adds no note when the Simulator.app opens", async () => {
      const result = await createBootDeviceTool(registry).execute!({}, { udid });
      expect(result).not.toHaveProperty("note");
    });

    it("bounds the GUI lookups with a timeout", async () => {
      await createBootDeviceTool(registry).execute!({}, { udid });

      const guiCalls = mockExecFile.mock.calls.filter(
        ([file]) => file === "xcode-select" || file === "open"
      );
      expect(guiCalls).toHaveLength(2);
      for (const call of guiCalls) expect(call[2]).toMatchObject({ timeout: 5_000 });
    });

    it("still reports the boot when xcode-select fails", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        getCallback(args)(
          args[0] === "xcode-select" ? new Error("no developer dir") : null,
          "",
          ""
        );
        return {} as never;
      });

      await expect(createBootDeviceTool(registry).execute!({}, { udid })).resolves.toMatchObject({
        booted: true,
      });
      expect(openCalls()).toEqual([]);
    });
  });

  it("skips pre-boot plist write when the sim is already Booted and still clears AutomationEnabled", async () => {
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: "22222222-2222-2222-2222-222222222222" });

    // Already-Booted sim: in-sim cfprefsd would overwrite the host write, so
    // skip it.
    expect(setAccessibilityPrefsPreBootMock).not.toHaveBeenCalled();
    expect(clearAutomationEnabledOrWarnMock).toHaveBeenCalledWith(
      "22222222-2222-2222-2222-222222222222"
    );
  });

  it("still clears AutomationEnabled when the state probe fails", async () => {
    // The scan lists nothing on an unknown udid or an xcrun failure other than
    // a timeout; boot must not block on the probe.
    scannedSimulatorsMock.mockResolvedValueOnce([]);

    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: "44444444-4444-4444-4444-444444444444" });

    expect(setAccessibilityPrefsPreBootMock).not.toHaveBeenCalled();
    expect(clearAutomationEnabledOrWarnMock).toHaveBeenCalledWith(
      "44444444-4444-4444-4444-444444444444"
    );
  });

  it("refuses to boot when the state probe times out without finding the simulator", async () => {
    scannedSimulatorsMock.mockResolvedValueOnce([]);
    scanTimedOut = true;

    const resolveService = vi.fn();
    const tool = createBootDeviceTool({ resolveService } as unknown as Registry);

    const err = await tool.execute!({}, { udid: "44444444-4444-4444-4444-444444444444" }).catch(
      (e: unknown) => e
    );

    expect(getFailureSignal(err)).toMatchObject({
      error_code: "BOOT_IOS_SIMCTL_LIST_TIMEOUT",
      failure_stage: "boot_ios_state_probe",
      error_kind: "timeout",
    });
    expect((err as Error).message).toContain("call boot-device again shortly");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(clearAutomationEnabledMock).not.toHaveBeenCalled();
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("boots when another device set timed out but the simulator was found", async () => {
    scanTimedOut = true;

    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const tool = createBootDeviceTool({ resolveService } as unknown as Registry);

    await tool.execute!({}, { udid: "11111111-1111-1111-1111-111111111111" });

    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111"
    );
  });

  it("does not block boot on a pre-boot plist write failure", async () => {
    // plutil missing / data container read-only: log and continue.
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

    expect(clearAutomationEnabledOrWarnMock).toHaveBeenCalled();
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

  it.each(["Booted", "Booting"])(
    "still primes native-devtools when simctl reports the simulator as %s",
    async (state) => {
      mockExecFile
        .mockImplementationOnce((...args: unknown[]) => {
          getCallback(args)(new Error(`Unable to boot device in current state: ${state}`));
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
          device: {
            id: "22222222-2222-2222-2222-222222222222",
            platform: "ios",
            kind: "simulator",
          },
          transport: "unix",
        }
      );
    }
  );

  it("fails when simctl cannot boot the simulator in a state other than Booted or Booting", async () => {
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      getCallback(args)(new Error("Unable to boot device in current state: Shutting Down"));
      return {} as never;
    });
    const tool = createBootDeviceTool({ resolveService: vi.fn() } as unknown as Registry);

    await expect(
      tool.execute!({}, { udid: "22222222-2222-2222-2222-222222222222" })
    ).rejects.toThrow("Unable to boot device in current state: Shutting Down");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("SIGKILL-bounds every simctl call, since longRunning lifts the client timeout", async () => {
    const registry = {
      resolveService: vi.fn(async () => ({
        getInitFailure: () => null,
        reverifyEnv: async () => {},
      })),
    } as unknown as Registry;

    await createBootDeviceTool(registry).execute!(
      {},
      { udid: "22222222-2222-2222-2222-222222222222", force: true }
    );

    const simctl = mockExecFile.mock.calls.filter(
      ([file, args]) => file === "xcrun" && args[0] === "simctl"
    );
    expect(simctl.map(([, args]) => args[1])).toEqual(["shutdown", "boot", "bootstatus"]);
    for (const [, , options] of simctl) {
      expect(options).toMatchObject({ killSignal: "SIGKILL" });
      // 0 means no timeout to Node.
      expect(options.timeout).toBeGreaterThan(0);
    }
  });

  it.each([
    ["shutdown", 30, "boot"],
    ["boot", 120, "bootstatus"],
    ["bootstatus", 480, null],
  ])(
    "a timed-out simctl %s fails as a timeout and runs nothing after it",
    async (sub, secs, next) => {
      const registry = {
        resolveService: vi.fn(async () => ({
          getInitFailure: () => null,
          reverifyEnv: async () => {},
        })),
      } as unknown as Registry;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const [file, argv] = args as [string, string[]];
        if (file === "xcrun" && argv[1] === sub) {
          getCallback(args)(
            Object.assign(new Error(`Command failed: xcrun simctl ${sub}`), {
              killed: true,
              signal: "SIGKILL",
            })
          );
          return {} as never;
        }
        const stdout = file === "xcode-select" ? `${DEVELOPER_DIR}\n` : "";
        getCallback(args)(null, { stdout, stderr: "" } as never);
        return {} as never;
      });

      const err = await createBootDeviceTool(registry).execute!(
        {},
        { udid: "22222222-2222-2222-2222-222222222222", force: true }
      ).catch((e: unknown) => e);

      expect((err as Error).message).toBe(
        `simctl ${sub} of iOS simulator 22222222-2222-2222-2222-222222222222 did not finish within ${secs}s.`
      );
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.BOOT_IOS_SIMCTL_TIMEOUT,
        failure_stage: `boot_ios_simctl_${sub}`,
        error_kind: "timeout",
        failure_command: "xcrun_simctl",
        failure_signal: "SIGKILL",
      });
      const subs = mockExecFile.mock.calls
        .filter(([file, args]) => file === "xcrun" && args[0] === "simctl")
        .map(([, args]) => args[1]);
      expect(subs.at(-1)).toBe(sub);
      if (next) expect(subs).not.toContain(next);
      expect(launchSimulatorAppMock).not.toHaveBeenCalled();
    }
  );

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
      "22222222-2222-2222-2222-222222222222",
      { isTvOs: false }
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
    scannedSimulatorsMock.mockResolvedValueOnce([
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
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledWith(TV_UDID, { isTvOs: true });
  });

  it("writes AutomationEnabled on a tvOS sim instead of clearing it", async () => {
    listIosSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Booted", runtimeKind: "tv" },
    ]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const registry = { resolveService } as unknown as Registry;
    const tool = createBootDeviceTool(registry);

    await tool.execute!({}, { udid: TV_UDID });

    expect(ensureAutomationEnabledMock).toHaveBeenCalledWith(TV_UDID);
    expect(clearAutomationEnabledOrWarnMock).not.toHaveBeenCalled();
  });

  it("disposes the cached TvControl service on a tvOS force reboot", async () => {
    scannedSimulatorsMock.mockResolvedValueOnce([
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

  it("recycles TvControl when a retry finds the tvOS sim still Booting", async () => {
    scannedSimulatorsMock.mockResolvedValueOnce([
      { udid: TV_UDID, state: "Booting", runtimeKind: "tv" },
    ]);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const sub = (args[1] as string[])[1];
      if (sub === "boot") {
        getCallback(args)(new Error("Unable to boot device in current state: Booting"));
      } else {
        getCallback(args)(null, { stdout: "", stderr: "" } as never);
      }
      return {} as never;
    });
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));
    const disposeService = vi.fn(async () => undefined);
    const registry = { resolveService, disposeService } as unknown as Registry;

    await createBootDeviceTool(registry).execute!({}, { udid: TV_UDID });

    expect(disposeService).toHaveBeenCalledWith(`TvControl:${TV_UDID}`);
  });

  it("waits out a Booting sim, then shuts it down and reboots it on force", async () => {
    const udid = "44444444-4444-4444-4444-444444444444";
    scannedSimulatorsMock.mockResolvedValueOnce([{ udid, state: "Booting" }]);
    const resolveService = vi.fn(async () => ({
      getInitFailure: () => null,
      reverifyEnv: async () => {},
    }));

    await createBootDeviceTool({ resolveService } as unknown as Registry).execute!(
      {},
      { udid, force: true }
    );

    const simctl = mockExecFile.mock.calls
      .filter(([file, args]) => file === "xcrun" && args[0] === "simctl")
      .map(([, args]) => args[1]);
    expect(simctl).toEqual(["bootstatus", "shutdown", "boot", "bootstatus"]);
    expect(setAccessibilityPrefsPreBootMock).toHaveBeenCalledWith(udid);
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
    scannedSimulatorsMock.mockResolvedValueOnce([
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
    scannedSimulatorsMock.mockResolvedValueOnce([
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
    scannedSimulatorsMock.mockResolvedValueOnce([
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
    scannedSimulatorsMock.mockResolvedValueOnce([
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
    scannedSimulatorsMock.mockResolvedValueOnce([
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

  it.each([
    "remote:",
    "remote:chromium-cdp-9222",
    "remote:emulator-5554",
    "remote:remote:x",
    "remote:00008110-000978540290401E",
    "remote:ext:prov:11111111-1111-1111-1111-111111111111",
  ])("refuses %s before it reaches sim-remote", async (udid) => {
    mockExecFile.mockClear();
    const tool = createBootDeviceTool({
      resolveService: async () => ({}),
    } as unknown as Registry);
    const error = await tool.execute!({}, { udid }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidToolInputError);
    expect((error as Error).message).toBe(`'${udid}' is not \`remote:<simulator udid>\`.`);
    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.BOOT_DEVICE_TARGET_SELECTION_INVALID,
      failure_stage: "boot_device_target_selection",
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("boots remote:<simulator udid> through sim-remote and returns the prefixed id", async () => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["sim-remote"]);
    mockExecFile.mockReset().mockImplementation((...args: unknown[]) => {
      // sim-remote.ts promisifies execFile, so the result arrives as one value.
      (getCallback(args) as (e: null, r: unknown) => void)(null, {
        stdout: JSON.stringify({ devices: {} }),
        stderr: "",
      });
      return {} as never;
    });
    const tool = createBootDeviceTool({
      resolveService: async () => ({ getInitFailure: () => null }),
    } as unknown as Registry);
    const udid = "remote:11111111-1111-1111-1111-111111111111";
    await expect(tool.execute!({}, { udid })).resolves.toEqual({
      platform: "ios-remote",
      udid,
      booted: true,
    });
    expect(mockExecFile.mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "))).toEqual([
      "sim-remote simctl list devices --json",
      "sim-remote simctl boot 11111111-1111-1111-1111-111111111111",
      "sim-remote simctl bootstatus 11111111-1111-1111-1111-111111111111 -b",
    ]);
  });

  describe("a remote simulator that is still Booting", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const udid = `remote:${id}`;
    const simRemote = () => {
      __resetDepCacheForTests();
      __primeDepCacheForTests(["sim-remote"]);
      mockExecFile.mockReset().mockImplementation((...args: unknown[]) => {
        const argv = args[1] as string[];
        const cb = getCallback(args) as (e: unknown, r?: unknown) => void;
        if (argv[1] === "list") {
          cb(null, {
            stdout: JSON.stringify({ devices: { r: [{ udid: id, name: "x", state: "Booting" }] } }),
            stderr: "",
          });
        } else if (argv[1] === "boot") {
          cb(
            Object.assign(new Error("Command failed"), {
              stderr: "Unable to boot device in current state: Booting",
            })
          );
        } else {
          cb(null, { stdout: "", stderr: "" });
        }
        return {} as never;
      });
      return createBootDeviceTool({
        resolveService: async () => ({ getInitFailure: () => null }),
      } as unknown as Registry);
    };
    const calls = () =>
      mockExecFile.mock.calls.map((c) => (c[1] as string[]).slice(1, 2).join(" "));

    it("waits for the boot instead of failing", async () => {
      await expect(simRemote().execute!({}, { udid })).resolves.toMatchObject({ booted: true });
      expect(calls()).toEqual(["list", "boot", "bootstatus"]);
    });

    it("waits for the boot, then reboots it on force", async () => {
      mockExecFile.mockClear();
      await expect(simRemote().execute!({}, { udid, force: true })).resolves.toMatchObject({
        booted: true,
      });
      expect(calls()).toEqual(["list", "bootstatus", "shutdown", "boot", "bootstatus"]);
    });
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

  it.each([
    ["iPhone 16 Pro", /requires a macOS host/],
    ["chromium-cdp-9222", /`electronAppPath`/],
  ])("answers %s with %s", async (udid, message) => {
    const tool = createBootDeviceTool({ resolveService: async () => ({}) } as unknown as Registry);
    await expect(tool.execute!({}, { udid })).rejects.toThrow(message);
  });
});

describe("boot-device — non-iOS device id passed as `udid`", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.clearAllMocks();
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      getCallback(args)(null, "", "");
      return {} as never;
    });
    scanTimedOut = false;
    scannedSimulatorsMock.mockReset().mockResolvedValue([]);
    setAccessibilityPrefsPreBootMock.mockReset().mockResolvedValue(undefined);
    clearAutomationEnabledMock.mockReset().mockResolvedValue(undefined);
    isEntitlementBypassActiveMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it.each([
    [
      "chromium-cdp-9222",
      /already running and needs no boot; to start an Electron app, pass `electronAppPath`/,
    ],
    ["amazon-4a27df03c9777152", /`vvdImage`/],
    ["emulator-5554", /Boot an Android emulator by passing `avdName`/],
  ])("refuses %s and names the parameter that boots it", async (udid, hint) => {
    const tool = createBootDeviceTool({ resolveService: async () => ({}) } as unknown as Registry);

    await expect(tool.execute!({}, { udid })).rejects.toThrow(/`udid` takes an iOS simulator UDID/);
    await expect(tool.execute!({}, { udid })).rejects.toThrow(hint);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it.each(["iPhone 16 Pro", "4A27DF03"])(
    "refuses %s without calling it an Android emulator",
    async (udid) => {
      const tool = createBootDeviceTool({
        resolveService: async () => ({}),
      } as unknown as Registry);

      const error = await tool.execute!({}, { udid }).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/Copy it exactly/);
      expect((error as Error).message).not.toMatch(/Boot an Android emulator/);
      expect(mockExecFile).not.toHaveBeenCalled();
    }
  );

  // `sim-remote` is not in the primed dep cache, so this error proves the route.
  it("routes a `remote:` id to the remote simulator path", async () => {
    const tool = createBootDeviceTool({ resolveService: async () => ({}) } as unknown as Registry);

    await expect(
      tool.execute!({}, { udid: "remote:11111111-1111-1111-1111-111111111111" })
    ).rejects.toThrow(/`sim-remote` CLI not found/);
  });

  it.each([{ udid: "chromium-cdp-9222" }, { udid: "iPhone 16 Pro" }, {}])(
    "answers %j with a 400, not a server error",
    async (body) => {
      const registry = new Registry();
      registry.registerTool(createBootDeviceTool(registry));
      const { app } = createHttpApp(registry);

      const res = await request(app).post("/tools/boot-device").send(body);

      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe("BOOT_DEVICE_TARGET_SELECTION_INVALID");
    }
  );
});
