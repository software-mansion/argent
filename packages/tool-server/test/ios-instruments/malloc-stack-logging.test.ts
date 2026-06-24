import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
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
});
