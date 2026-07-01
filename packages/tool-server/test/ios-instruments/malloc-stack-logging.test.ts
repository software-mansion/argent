import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";

// Exercises the malloc_stack_logging launch path in startNativeProfilerIos
// directly (no blueprint/native-devtools imports) so we can assert the exact
// xctrace argv. Default mode must still `--attach`; malloc_stack_logging mode
// must cold-`--launch` the resolved .app with `--env MallocStackLogging=1`.

class StartFakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

const LISTAPPS_JSON = JSON.stringify({
  "com.example.myapp": {
    CFBundleExecutable: "MyApp",
    CFBundleIdentifier: "com.example.myapp",
    ApplicationType: "User",
  },
});

function fakeApi(): NativeProfilerSessionApi {
  return {
    deviceId: "DEVICE-UDID",
    platform: "ios",
    appProcess: null,
    capturePid: null,
    captureProcess: null,
    cpuFilterPid: null,
    traceFile: null,
    exportedFiles: null,
    profilingActive: false,
    wallClockStartMs: null,
    parsedData: null,
    recordingTimeout: null,
    recordingTimedOut: false,
    recordingExitedUnexpectedly: false,
    lastExitInfo: null,
    androidOnDeviceTracePath: null,
  };
}

function mockChildProcess() {
  const spawnFn = vi.fn(() => new StartFakeChild());
  const execSyncFn = vi.fn((cmd: string) => {
    if (cmd.includes("listapps")) return LISTAPPS_JSON;
    if (cmd.includes("launchctl list"))
      return "1\t0\tUIKitApplication:com.example.myapp[abcd][rb-legacy]\n";
    if (cmd.includes("get_app_container")) return "/Users/x/Library/.../MyApp.app\n";
    if (cmd.includes("terminate")) return "";
    return "";
  });
  return { spawnFn, execSyncFn };
}

async function importStart() {
  const mod = await import("../../src/tools/profiler/native-profiler/platforms/ios");
  return mod.startNativeProfilerIos;
}

describe("native-profiler-start malloc_stack_logging", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("child_process");
    vi.doUnmock("../../src/utils/react-profiler/debug/dump");
    vi.doUnmock("../../src/utils/ios-profiler/notify");
    vi.doUnmock("../../src/utils/ios-profiler/startup");
  });

  function applyCommonMocks(spawnFn: unknown, execSyncFn: unknown) {
    vi.doMock("child_process", () => ({
      spawn: spawnFn,
      execSync: execSyncFn,
      execFile: vi.fn(),
      execFileSync: vi.fn(),
    }));
    vi.doMock("../../src/utils/react-profiler/debug/dump", () => ({
      getDebugDir: vi.fn(async () => "/tmp/argent-profiler-cwd"),
    }));
    vi.doMock("../../src/utils/ios-profiler/notify", () => ({
      listenForDarwinNotification: vi.fn(() => {
        throw new Error("notifyutil unavailable in tests");
      }),
    }));
    vi.doMock("../../src/utils/ios-profiler/startup", () => ({
      waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
    }));
  }

  it("cold-launches the .app with MallocStackLogging when malloc_stack_logging is true", async () => {
    const { spawnFn, execSyncFn } = mockChildProcess();
    applyCommonMocks(spawnFn, execSyncFn);

    const startNativeProfilerIos = await importStart();
    const api = fakeApi();
    const result = await startNativeProfilerIos(api, {
      device_id: "DEVICE-UDID",
      app_process: "MyApp",
      malloc_stack_logging: true,
    });

    expect(result.status).toBe("recording");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe("xctrace");

    // launch + env, not attach
    expect(args).toContain("--launch");
    expect(args).toContain("--env");
    expect(args[args.indexOf("--env") + 1]).toBe("MallocStackLogging=1");
    expect(args).not.toContain("--attach");
    // the launched target is the resolved .app bundle, and must be the LAST args
    // (everything after `--` is the launched command).
    const dashIdx = args.indexOf("--");
    expect(dashIdx).toBeGreaterThan(args.indexOf("--launch"));
    expect(args[dashIdx + 1]).toBe("/Users/x/Library/.../MyApp.app");
    expect(dashIdx + 1).toBe(args.length - 1);

    // the running instance is terminated first for a clean cold start
    const execCmds = execSyncFn.mock.calls.map((c) => String(c[0]));
    expect(
      execCmds.some((c) => c.includes("simctl terminate") && c.includes("com.example.myapp"))
    ).toBe(true);
    expect(execCmds.some((c) => c.includes("get_app_container"))).toBe(true);
  });

  it("does not terminate the app if the debug dir can't be created (malloc mode)", async () => {
    // getDebugDir()'s mkdir runs BEFORE the terminate, so a failure (e.g. ENOSPC)
    // must leave the running app untouched — never killed-without-relaunch.
    const { spawnFn, execSyncFn } = mockChildProcess();
    vi.doMock("child_process", () => ({
      spawn: spawnFn,
      execSync: execSyncFn,
      execFile: vi.fn(),
      execFileSync: vi.fn(),
    }));
    vi.doMock("../../src/utils/react-profiler/debug/dump", () => ({
      getDebugDir: vi.fn(async () => {
        throw new Error("ENOSPC: no space left on device");
      }),
    }));
    vi.doMock("../../src/utils/ios-profiler/notify", () => ({
      listenForDarwinNotification: vi.fn(() => {
        throw new Error("notifyutil unavailable in tests");
      }),
    }));
    vi.doMock("../../src/utils/ios-profiler/startup", () => ({
      waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
    }));

    const startNativeProfilerIos = await importStart();
    const api = fakeApi();
    await expect(
      startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      })
    ).rejects.toThrow(/ENOSPC/);

    const execCmds = execSyncFn.mock.calls.map((c) => String(c[0]));
    expect(execCmds.some((c) => c.includes("simctl terminate"))).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("attaches (no launch/env) by default", async () => {
    const { spawnFn, execSyncFn } = mockChildProcess();
    applyCommonMocks(spawnFn, execSyncFn);

    const startNativeProfilerIos = await importStart();
    const api = fakeApi();
    await startNativeProfilerIos(api, {
      device_id: "DEVICE-UDID",
      app_process: "MyApp",
    });

    const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain("--attach");
    // default mode attaches by host PID (Xcode 26.5 compat); the mock's launchctl yields pid 1
    expect(args[args.indexOf("--attach") + 1]).toBe("1");
    expect(args).not.toContain("--launch");
    expect(args).not.toContain("--env");
    // default attach mode never terminates the running app
    const execCmds = execSyncFn.mock.calls.map((c) => String(c[0]));
    expect(execCmds.some((c) => c.includes("simctl terminate"))).toBe(false);
  });

  // A degraded Xcode (26.4–27.0) is reported by `xcodebuild -version`, which the
  // capture-strategy selector reads. The malloc cold launch needs `--device`,
  // which is broken on those versions, so the start must be refused UP FRONT —
  // before the running app is terminated and before any xctrace spawn.
  function mockChildProcessDegraded() {
    const spawnFn = vi.fn(() => new StartFakeChild());
    const execSyncFn = vi.fn((cmd: string) => {
      if (cmd.includes("xcodebuild")) return "Xcode 26.5\nBuild version 17F42";
      if (cmd.includes("listapps")) return LISTAPPS_JSON;
      if (cmd.includes("launchctl list"))
        return "1\t0\tUIKitApplication:com.example.myapp[abcd][rb-legacy]\n";
      if (cmd.includes("get_app_container")) return "/Users/x/Library/.../MyApp.app\n";
      if (cmd.includes("terminate")) return "";
      return "";
    });
    return { spawnFn, execSyncFn };
  }

  it("refuses malloc_stack_logging on a degraded Xcode before terminating the app", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      const { spawnFn, execSyncFn } = mockChildProcessDegraded();
      applyCommonMocks(spawnFn, execSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      // It must fail, with the degraded-Xcode failure code (telemetry-classified).
      expect(err).toBeTruthy();
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_MALLOC_DEGRADED_XCODE
      );
      // And critically: it never touched the app or xctrace — no terminate, no
      // bundle-path resolution, no spawn. The app the user had running is intact.
      const execCmds = execSyncFn.mock.calls.map((c) => String(c[0]));
      expect(execCmds.some((c) => c.includes("simctl terminate"))).toBe(false);
      expect(execCmds.some((c) => c.includes("get_app_container"))).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("ARGENT_IOS_CAPTURE=device forces the malloc cold launch through on a degraded Xcode", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    process.env.ARGENT_IOS_CAPTURE = "device";
    try {
      const { spawnFn, execSyncFn } = mockChildProcessDegraded();
      applyCommonMocks(spawnFn, execSyncFn);

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const result = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      });

      // The override bypasses the guard, so the cold launch proceeds as usual.
      expect(result.status).toBe("recording");
      const [, args] = spawnFn.mock.calls[0] as unknown as [string, string[]];
      expect(args).toContain("--launch");
      expect(args).toContain("--env");
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });

  it("best-effort relaunches the app when the malloc cold launch fails after terminate", async () => {
    const prev = process.env.ARGENT_IOS_CAPTURE;
    delete process.env.ARGENT_IOS_CAPTURE;
    try {
      const spawnFn = vi.fn(() => new StartFakeChild());
      // Non-degraded Xcode → the guard passes and the path reaches the cold launch.
      const execSyncFn = vi.fn((cmd: string) => {
        if (cmd.includes("xcodebuild")) return "Xcode 16.4\nBuild version 16F6";
        if (cmd.includes("listapps")) return LISTAPPS_JSON;
        if (cmd.includes("launchctl list"))
          return "1\t0\tUIKitApplication:com.example.myapp[abcd][rb-legacy]\n";
        if (cmd.includes("get_app_container")) return "/Users/x/Library/.../MyApp.app\n";
        if (cmd.includes("terminate")) return "";
        return "";
      });
      const execFileSyncFn = vi.fn();
      vi.doMock("child_process", () => ({
        spawn: spawnFn,
        execSync: execSyncFn,
        execFile: vi.fn(),
        execFileSync: execFileSyncFn,
      }));
      vi.doMock("../../src/utils/react-profiler/debug/dump", () => ({
        getDebugDir: vi.fn(async () => "/tmp/argent-profiler-cwd"),
      }));
      vi.doMock("../../src/utils/ios-profiler/notify", () => ({
        listenForDarwinNotification: vi.fn(() => {
          throw new Error("notifyutil unavailable in tests");
        }),
      }));
      // Force the capture start to fail *after* the app has been terminated.
      vi.doMock("../../src/utils/ios-profiler/startup", () => ({
        waitForXctraceReady: vi.fn(async () => {
          throw new Error("xctrace exited before recording started");
        }),
      }));

      const startNativeProfilerIos = await importStart();
      const api = fakeApi();
      const err = await startNativeProfilerIos(api, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
        malloc_stack_logging: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      // The start failed (error surfaced) AND the terminated app was relaunched.
      expect(err).toBeTruthy();
      const relaunch = execFileSyncFn.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("launch")
      );
      expect(relaunch).toBeTruthy();
      expect(relaunch![1]).toEqual(["simctl", "launch", "DEVICE-UDID", "com.example.myapp"]);
    } finally {
      if (prev === undefined) delete process.env.ARGENT_IOS_CAPTURE;
      else process.env.ARGENT_IOS_CAPTURE = prev;
    }
  });
});
