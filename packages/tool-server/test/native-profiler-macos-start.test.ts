/**
 * native-profiler-start on a native Mac app (`macos-app-<bundle id>`), driven at
 * its module boundaries: the xctrace spawn, the readiness handshake, argent's
 * record of the apps it started, and the app's MacosAppApi.
 *
 * A Mac app is a host process, so xctrace attaches to its pid with no
 * `--device`. malloc_stack_logging restarts the app through argent with
 * MallocStackLogging=1 and attaches to the new process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import * as os from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAILURE_CODES, FailureError, getFailureSignal, type DeviceInfo } from "@argent/registry";

class FakeXctrace extends EventEmitter {
  pid = 5151;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    queueMicrotask(() => this.exitWith(signal));
    return true;
  });

  /** Exits as a real ChildProcess does: the handle's fields first, then the event. */
  exitWith(signal: NodeJS.Signals | null, code: number | null = signal ? null : 0): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = code;
    this.emit("exit", this.exitCode, this.signalCode);
  }
}

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: vi.fn(() => new FakeXctrace()),
}));
vi.mock("../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(async () => os.tmpdir()),
}));
vi.mock("../src/utils/ios-profiler/notify", () => ({
  // No notifyutil: the start falls back to xctrace's stdout, and the mocked
  // `waitForXctraceReady` below decides readiness either way.
  listenForDarwinNotification: vi.fn(() => {
    throw new Error("notifyutil unavailable in this test");
  }),
}));
vi.mock("../src/utils/ios-profiler/startup", () => ({
  waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
}));
vi.mock("../src/utils/macos-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/macos-apps")>()),
  runningTrackedApp: vi.fn(async () => undefined),
  getTrackedMacosApp: vi.fn(() => undefined),
  readCodeSignature: vi.fn(async () => null),
  inBackgroundSession: vi.fn(async () => false),
}));
vi.mock("../src/utils/ios-profiler/export", () => ({
  exportIosTraceData: vi.fn(async () => {
    throw new Error("no xctrace export in this test");
  }),
}));
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
  ensureDep: vi.fn(async () => {}),
}));

import { spawn } from "child_process";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import type { MacosAppApi, MacosLaunchResult } from "../src/blueprints/macos-app";
import { startNativeProfilerMacos } from "../src/tools/profiler/native-profiler/platforms/macos";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";
import { InvalidToolInputError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import { getDebugDir } from "../src/utils/react-profiler/debug/dump";
import { listenForDarwinNotification, type NotifyHandle } from "../src/utils/ios-profiler/notify";
import { waitForXctraceReady } from "../src/utils/ios-profiler/startup";
import {
  getTrackedMacosApp,
  inBackgroundSession,
  readCodeSignature,
  runningTrackedApp,
} from "../src/utils/macos-apps";
import { isProfiling } from "../src/utils/profiling-devices";
import { isCaptureInFlight } from "../src/utils/profiler-shared/capture-guard";
import {
  analyzeNativeProfilerIos,
  stopNativeProfilerIos,
} from "../src/tools/profiler/native-profiler/platforms/ios";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import type { AppSuspensionWindow } from "../src/utils/ios-profiler/app-suspensions";

useMacosAppsFlag();

type TrackedMacosApp = NonNullable<ReturnType<typeof getTrackedMacosApp>>;

const spawnMock = vi.mocked(spawn);
const runningMock = vi.mocked(runningTrackedApp);
const trackedMock = vi.mocked(getTrackedMacosApp);
const signatureMock = vi.mocked(readCodeSignature);
const readyMock = vi.mocked(waitForXctraceReady);

const TEMPLATE = "/tmp/Custom.tracetemplate";

/**
 * Each test profiles its own bundle id: the start remembers per bundle id which
 * process it restarted with malloc stack logging, for the whole module.
 */
let bundleId = "";
let deviceId = "";
let sessions: NativeProfilerSessionApi[] = [];

function trackedApp(pid: number): TrackedMacosApp {
  return {
    bundleId,
    appPath: "/Applications/Example.app",
    executable: "/Applications/Example.app/Contents/MacOS/ExampleExec",
    name: "Example",
    pid,
    sandboxed: false,
    userSelectedReadOnly: false,
    listenSocket: null,
    logPath: "/tmp/example.log",
    args: [],
    startedAt: 0,
  };
}

/** A code signature with or without get-task-allow, as a Debug or a Release build has. */
function signature(getTaskAllow: boolean) {
  return {
    hardenedRuntime: false,
    libraryValidation: false,
    sandboxed: false,
    userSelectedReadOnly: false,
    entitlements: {
      getTaskAllow,
      disableLibraryValidation: false,
      allowDyldEnvironmentVariables: false,
    },
  };
}

function fakeMacosApp(
  pid = 7777,
  note?: string,
  watch: { end(): AppSuspensionWindow[] } | null = null
) {
  const watchSuspensions = vi.fn(async (_pid: number) => watch);
  const launch = vi.fn(async (): Promise<MacosLaunchResult> => ({
    bundleId,
    pid,
    platform: "macos",
    protocol: 1,
    args: [],
    appPath: "/Applications/Example.app",
    sandboxed: false,
    logPath: "/tmp/example.log",
    ...(note ? { note } : {}),
  }));
  return {
    app: { bundleId, launch, watchSuspensions } as unknown as MacosAppApi,
    launch,
    watchSuspensions,
  };
}

async function sessionInstance() {
  const device: DeviceInfo = resolveDevice(deviceId);
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
  sessions.push(instance.api);
  return instance;
}

async function session(): Promise<NativeProfilerSessionApi> {
  return (await sessionInstance()).api;
}

/** How long a start waits after xctrace reports that it records, before it returns. */
const ARM_SETTLE_MS = 1_500;

/** Runs a start on the fake clock to its end, past the wait after the recording starts. */
async function settled<T>(promise: Promise<T>): Promise<T> {
  // A refusal before the wait must not surface as unhandled while the clock runs.
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);
  return promise;
}

function start(...args: Parameters<typeof startNativeProfilerMacos>) {
  return settled(startNativeProfilerMacos(...args));
}

function executeStart(...args: Parameters<typeof nativeProfilerStartTool.execute>) {
  return settled(nativeProfilerStartTool.execute(...args));
}

/** The arguments of the one xctrace spawn this test made. */
function xctraceArgs(): string[] {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const [command, args] = spawnMock.mock.calls[0]!;
  expect(command).toBe("xctrace");
  return args as string[];
}

/** The xctrace the last start spawned exits, as it does when the recording ends. */
function endRecording(api: NativeProfilerSessionApi): void {
  (api.captureProcess as unknown as FakeXctrace).exitWith(null);
  expect(api.profilingActive).toBe(false);
}

beforeEach(() => {
  // Only the timers: notifyutil's registration race and the wait after the
  // start are setTimeout, while the fake xctrace exits on a microtask.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  bundleId = `com.example.profiled${Math.random().toString(36).slice(2, 10)}`;
  deviceId = `macos-app-${bundleId}`;
  spawnMock.mockClear();
  runningMock.mockReset();
  runningMock.mockResolvedValue(undefined);
  trackedMock.mockReset();
  trackedMock.mockReturnValue(undefined);
  signatureMock.mockReset();
  signatureMock.mockResolvedValue(signature(true));
});

afterEach(() => {
  for (const api of sessions) {
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
    api.profilingActive = false;
  }
  sessions = [];
  vi.useRealTimers();
});

describe("startNativeProfilerMacos refusals", () => {
  it("refuses an app that argent is not running, before it spawns xctrace", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_PROFILER_NO_RUNNING_APPS);
    expect((err as Error).message).toContain(`${bundleId} is not running`);
    expect(runningMock).toHaveBeenCalledWith(bundleId);
    expect(launch).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(api.profilingActive).toBe(false);
  });

  it("refuses app_process, and does not restart the app for a malloc_stack_logging start", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));

    const err = await start(api, app, {
      device_id: deviceId,
      app_process: "Example",
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect((err as Error).message).toContain("app_process is not used for a Mac app");
    expect(launch).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses while a capture runs, and does not restart the app for a malloc_stack_logging start", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();
    api.profilingActive = true;
    api.capturePid = 999;

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING
    );
    expect(launch).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not restart the app when the trace path cannot be made", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();
    vi.mocked(getDebugDir).mockRejectedValueOnce(new Error("EACCES: debug dir"));

    await expect(
      start(api, app, {
        device_id: deviceId,
        template_path: TEMPLATE,
        malloc_stack_logging: true,
      })
    ).rejects.toThrow("EACCES: debug dir");
    expect(launch).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns no xctrace when the restart with malloc stack logging fails", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();
    launch.mockRejectedValueOnce(new Error("the app shows a dialog"));

    await expect(
      start(api, app, {
        device_id: deviceId,
        template_path: TEMPLATE,
        malloc_stack_logging: true,
      })
    ).rejects.toThrow("the app shows a dialog");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(api.profilingActive).toBe(false);
  });
});

describe("startNativeProfilerMacos recording", () => {
  it("attaches xctrace to the running app's pid with no --device", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    trackedMock.mockReturnValue(trackedApp(4321));

    const result = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });

    const args = xctraceArgs();
    expect(args).toEqual([
      "record",
      "--template",
      TEMPLATE,
      "--attach",
      "4321",
      "--output",
      result.traceFile,
      "--no-prompt",
    ]);
    expect(args).not.toContain("--device");
    expect(args).not.toContain("--launch");
    expect(result).toEqual({ status: "recording", pid: 5151, traceFile: result.traceFile });
    expect(result.traceFile).toMatch(/native-profiler-\d{8}-\d{6}\.trace$/);
    expect(launch).not.toHaveBeenCalled();

    expect(api.profilingActive).toBe(true);
    expect(api.capturePid).toBe(5151);
    // Scoped to the app by --attach: no host-wide sample filter.
    expect(api.cpuFilterPid).toBeNull();
    expect(api.recordingMallocStackLogging).toBe(false);
    expect(api.appProcess).toBe("ExampleExec");
    expect(api.traceFile).toBe(result.traceFile);
  });

  it("names the capture after the bundle id when argent has no record of the executable", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));

    await start(api, app, { device_id: deviceId, template_path: TEMPLATE });

    expect(api.appProcess).toBe(bundleId);
  });

  it("passes the startup notification to xctrace when notifyutil listens", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    const handle: NotifyHandle = {
      ready: Promise.resolve(),
      fired: new Promise<void>(() => {}),
      cancel: vi.fn(),
    };
    vi.mocked(listenForDarwinNotification).mockReturnValueOnce(handle);

    await start(api, app, { device_id: deviceId, template_path: TEMPLATE });

    const args = xctraceArgs();
    const flag = args.indexOf("--notify-tracing-started");
    expect(flag).toBeGreaterThan(args.indexOf("--no-prompt"));
    expect(args[flag + 1]).toBe(vi.mocked(listenForDarwinNotification).mock.lastCall![0]);
  });

  it("uses the bundled Argent template when template_path is omitted", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));

    await start(api, app, { device_id: deviceId });

    const args = xctraceArgs();
    expect(args[args.indexOf("--template") + 1]).toMatch(/Argent\.tracetemplate$/);
  });

  it("an xctrace exit ends the recording and keeps the trace for stop", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    await start(api, app, { device_id: deviceId, template_path: TEMPLATE });

    (api.captureProcess as unknown as FakeXctrace).exitWith(null);

    expect(api.profilingActive).toBe(false);
    expect(api.recordingExitedUnexpectedly).toBe(true);
    expect(api.recordingTimeout).toBeNull();
    expect(api.traceFile).not.toBeNull();
  });
});

describe("startNativeProfilerMacos with malloc_stack_logging", () => {
  it("restarts the app with MallocStackLogging=1, attaches to the new pid and says so", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp(7777, "The app showed no window.");
    // The copy that ran before the restart: never the one to attach to.
    runningMock.mockResolvedValue(trackedApp(4321));

    const result = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({ restart: true, env: { MallocStackLogging: "1" } });
    const args = xctraceArgs();
    expect(args[args.indexOf("--attach") + 1]).toBe("7777");
    expect(args).not.toContain("--device");
    expect(args).not.toContain("--env");
    expect(api.recordingMallocStackLogging).toBe(true);
    expect(api.cpuFilterPid).toBeNull();
    expect(result.status).toBe("recording");
    expect(result.warning).toContain(`argent restarted ${bundleId} (pid 7777)`);
    expect(result.warning).toContain("MallocStackLogging=1");
    expect(result.warning).toContain("restart-app");
    // The launch's own note is passed on after it.
    expect(result.warning).toMatch(/MallocStackLogging=1.*The app showed no window\.$/s);
  });

  it("a later plain start of the same process warns that it still logs, and a restarted one does not", async () => {
    const { app } = fakeMacosApp(7777);
    const api = await session();
    await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    });
    endRecording(api);

    // The same process, still started with MallocStackLogging=1.
    runningMock.mockResolvedValue(trackedApp(7777));
    const same = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });
    expect(same.warning).toContain(`${bundleId} still runs with MallocStackLogging=1`);
    expect(same.warning).toContain("restart-app");
    // It still logs, so its leaks carry backtraces as in a malloc_stack_logging capture.
    expect(api.recordingMallocStackLogging).toBe(true);
    endRecording(api);

    // restart-app started a new process, without the logging.
    runningMock.mockResolvedValue(trackedApp(8888));
    const restarted = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });
    expect(restarted.warning).toBeUndefined();
    expect(spawnMock.mock.lastCall![1]).toContain("8888");
  });

  it("says that it restarted the app when xctrace then fails to start", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp(7777);
    runningMock.mockResolvedValue(trackedApp(4321));
    readyMock.mockRejectedValueOnce(
      new FailureError(
        "xctrace record exited before recording started (code=33, signal=null). " +
          "stderr: Cannot find template matching name: /nonexistent/x",
        {
          error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED,
          failure_stage: "native_profiler_xctrace_ready",
          failure_area: "tool_server",
          error_kind: "subprocess",
        }
      )
    );

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: "/nonexistent/x.tracetemplate",
      malloc_stack_logging: true,
    }).catch((e: unknown) => e);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED
    );
    // xctrace's error first, then that the app lost its state and now logs.
    const message = (err as Error).message;
    expect(message).toMatch(/^xctrace record exited before recording started .*\/nonexistent\/x /);
    expect(message).toContain(
      `argent restarted ${bundleId} (pid 7777) with MallocStackLogging=1, so its earlier state is gone.`
    );
    expect(message).toContain("restart-app");
  });

  it("says that it restarted the app when xctrace quits during the wait after the start", async () => {
    const api = await session();
    const { app } = fakeMacosApp(7777);
    runningMock.mockResolvedValue(trackedApp(4321));

    const pending = startNativeProfilerMacos(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    (api.captureProcess as unknown as FakeXctrace).exitWith(null, 3);
    await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);
    const err = await pending.catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED
    );
    expect((err as Error).message).toContain("xctrace quit right after the recording started");
    expect((err as Error).message).toContain(`argent restarted ${bundleId} (pid 7777)`);
  });

  it("a plain start that fails says nothing about a restart", async () => {
    const api = await session();
    const { app } = fakeMacosApp(7777);
    runningMock.mockResolvedValue(trackedApp(4321));
    readyMock.mockRejectedValueOnce(new Error("xctrace record exited before recording started"));

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    }).catch((e: unknown) => e);

    expect((err as Error).message).toBe("xctrace record exited before recording started");
  });

  it("does not warn about another app's malloc stack logging", async () => {
    const { app } = fakeMacosApp(7777);
    const api = await session();
    await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    });

    // Another bundle id whose process happens to have the same pid.
    bundleId = `${bundleId}other`;
    deviceId = `macos-app-${bundleId}`;
    const { app: otherApp } = fakeMacosApp(7777);
    runningMock.mockResolvedValue(trackedApp(7777));
    const other = await start(await session(), otherApp, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });

    expect(other.warning).toBeUndefined();
  });
});

describe("startNativeProfilerMacos: the wait after the recording starts", () => {
  /** A start whose settling the test drives itself. */
  function track<T>(promise: Promise<T>) {
    const state = { done: false, error: undefined as unknown };
    promise.then(
      () => (state.done = true),
      (err: unknown) => {
        state.done = true;
        state.error = err;
      }
    );
    return state;
  }

  const EARLIER_TRACE = "/tmp/native-profiler-20260101-000000.trace";
  const EARLIER_EXPORTS = { cpu: "/tmp/earlier_cpu.xml", hangs: null, leaks: null };

  /** A session holding a finished, exported capture, as a stop leaves it. */
  async function sessionWithEarlierCapture() {
    const instance = await sessionInstance();
    instance.api.traceFile = EARLIER_TRACE;
    instance.api.exportedFiles = { ...EARLIER_EXPORTS };
    instance.api.recordingMallocStackLogging = true;
    instance.api.mallocStackLogging = true;
    return instance;
  }

  it("takes the capture and returns only once xctrace has recorded for a while", async () => {
    const { api } = await sessionWithEarlierCapture();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));

    const pending = startNativeProfilerMacos(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });
    const state = track(pending);

    // A hang that began 0.9 s after xctrace said it records was found, one at 0.65 s was not.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.done).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The session holds the child, for a teardown to kill, but not yet the capture.
    expect(api.captureProcess).toBe(spawnMock.mock.results[0]!.value);
    expect(api.profilingActive).toBe(false);
    expect(api.traceFile).toBe(EARLIER_TRACE);
    expect(api.recordingMallocStackLogging).toBe(true);

    await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS - 1_000);
    expect(state).toEqual({ done: true, error: undefined });
    const result = await pending;
    expect(result).toMatchObject({ status: "recording", pid: 5151 });
    expect(api.profilingActive).toBe(true);
    expect(api.traceFile).toBe(result.traceFile);
    expect(api.recordingMallocStackLogging).toBe(false);
  });

  it("fails as torn down, and kills xctrace, when a teardown lands during the wait", async () => {
    const instance = await sessionWithEarlierCapture();
    const api = instance.api;
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));

    const pending = startNativeProfilerMacos(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });
    const state = track(pending);
    await vi.advanceTimersByTimeAsync(500);
    const child = api.captureProcess as unknown as FakeXctrace;
    await instance.dispose();
    await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);

    expect(getFailureSignal(state.error)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN
    );
    expect((state.error as Error).message).toContain("torn down");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(api.profilingActive).toBe(false);
    expect(api.recordingTimeout).toBeNull();
  });

  it.each([
    [3, null, "code=3, signal=?"],
    [null, "SIGSEGV", "code=?, signal=SIGSEGV"],
  ] as const)(
    "fails with xctrace's exit when it quits during the wait (code %s, signal %s), and leaves the session as it was",
    async (code, signal, shown) => {
      const { api } = await sessionWithEarlierCapture();
      const { app } = fakeMacosApp();
      runningMock.mockResolvedValue(trackedApp(4321));

      const pending = startNativeProfilerMacos(api, app, {
        device_id: deviceId,
        template_path: TEMPLATE,
      });
      const state = track(pending);
      await vi.advanceTimersByTimeAsync(500);
      (api.captureProcess as unknown as FakeXctrace).exitWith(signal, code);
      await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);

      expect(getFailureSignal(state.error)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED
      );
      expect((state.error as Error).message).toContain(
        `xctrace quit right after the recording started (${shown})`
      );
      expect(api.capturePid).toBeNull();
      expect(api.captureProcess).toBeNull();
      expect(isCaptureInFlight(api)).toBe(false);
      expect(api.traceFile).toBe(EARLIER_TRACE);
      expect(api.exportedFiles).toEqual(EARLIER_EXPORTS);
      expect(api.mallocStackLogging).toBe(true);
      expect(api.recordingMallocStackLogging).toBe(true);
      expect(api.recordingTimeout).toBeNull();
    }
  );

  it("says what xctrace printed when it quits during the wait", async () => {
    const { api } = await sessionWithEarlierCapture();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));

    const pending = startNativeProfilerMacos(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });
    const state = track(pending);
    await vi.advanceTimersByTimeAsync(500);
    const child = api.captureProcess as unknown as FakeXctrace;
    child.stdout.emit(
      "data",
      Buffer.from(
        "Run issues were detected (trace is still ready to be viewed):\n" +
          "* [Error] Failed to attach to target process\n"
      )
    );
    child.exitWith(null, 2);
    await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);

    expect((state.error as Error).message).toContain(
      "xctrace said: Failed to attach to target process Check that the app still runs"
    );
    expect(getFailureSignal(state.error)?.failure_exit_code).toBe(2);
  });

  it("keeps a finished capture analyzable after a start that fails in the wait", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "argent-macos-settle-"));
    try {
      const cpu = join(dir, "cpu.xml");
      writeFileSync(
        cpu,
        `<trace-query-result><node><row><sample-time>1000000</sample-time>` +
          `<thread fmt="Main Thread 0x1 (ExampleExec, pid: 4321)"></thread><weight>5000000</weight>` +
          `<backtrace id="1"><frame id="2" name="-[ExampleView layout]" addr="0x1">` +
          `<binary id="3" name="ExampleExec" arch="arm64" load-addr="0x1" ` +
          `path="/Applications/Example.app/Contents/MacOS/ExampleExec"/></frame></backtrace>` +
          `</row></node></trace-query-result>`
      );
      const api = await session();
      api.traceFile = join(dir, "native-profiler-20260101-000000.trace");
      api.exportedFiles = { cpu, hangs: null, leaks: null };
      const { app } = fakeMacosApp();
      runningMock.mockResolvedValue(trackedApp(4321));

      const pending = startNativeProfilerMacos(api, app, {
        device_id: deviceId,
        template_path: TEMPLATE,
      });
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(500);
      (api.captureProcess as unknown as FakeXctrace).exitWith(null, 3);
      await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);
      await expect(pending).rejects.toThrow("xctrace quit right after the recording started");

      const { report } = await analyzeNativeProfilerIos(api);
      expect(report).toMatch(/^# macOS Instruments Analysis\n/);
      expect(report).toContain("-[ExampleView layout]");
      // Nothing of the failed start is left for a stop to export over it.
      await expect(stopNativeProfilerIos(api)).rejects.toThrow(
        "No active native profiling session found"
      );
      expect(api.exportedFiles).toEqual({ cpu, hangs: null, leaks: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startNativeProfilerMacos and the app's code signature", () => {
  const NOT_DEBUGGABLE = "NATIVE_PROFILER_APP_NOT_DEBUGGABLE";

  it("refuses a running app signed without get-task-allow, before it spawns xctrace", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    signatureMock.mockResolvedValue(signature(false));

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(NOT_DEBUGGABLE);
    expect((err as Error).message).toContain("com.apple.security.get-task-allow");
    expect((err as Error).message).toContain("Profile a build that Xcode signed for development");
    // The running process's signature, which can differ from the bundle's after a rebuild.
    expect(signatureMock).toHaveBeenCalledWith(4321);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(api.profilingActive).toBe(false);
  });

  it("in a Background session, records an app without get-task-allow with the template the caller chose", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    signatureMock.mockResolvedValue(signature(false));
    // Over SSH, for example: macOS shows no password dialog there, and Time Profiler records the app.
    vi.mocked(inBackgroundSession).mockResolvedValueOnce(true);

    const result = await start(api, app, {
      device_id: deviceId,
      template_path: "Time Profiler",
    });

    expect(result.status).toBe("recording");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("in a Background session, refuses an app without get-task-allow with the bundled template", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    signatureMock.mockResolvedValue(signature(false));
    vi.mocked(inBackgroundSession).mockResolvedValueOnce(true);

    const err = await start(api, app, { device_id: deviceId }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(NOT_DEBUGGABLE);
    expect((err as Error).message).toContain('template_path: "Time Profiler"');
    expect((err as Error).message).not.toContain("system dialog");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("records when the signature cannot be read", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    signatureMock.mockResolvedValue(null);

    const result = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
    });

    expect(result.status).toBe("recording");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("with malloc_stack_logging, refuses a running release build before it restarts it", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));
    signatureMock.mockResolvedValue(signature(false));

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(NOT_DEBUGGABLE);
    expect(signatureMock).toHaveBeenCalledWith(4321);
    expect(launch).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("with malloc_stack_logging, checks the bundle of an app that is not running before it starts it", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp();
    trackedMock.mockReturnValue(trackedApp(4321));
    signatureMock.mockResolvedValue(signature(false));

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(NOT_DEBUGGABLE);
    expect(signatureMock).toHaveBeenCalledWith("/Applications/Example.app");
    expect(launch).not.toHaveBeenCalled();
  });

  it("with malloc_stack_logging and no record of the app, checks the process it started", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp(7777);
    signatureMock.mockResolvedValue(signature(false));

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(NOT_DEBUGGABLE);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(signatureMock).toHaveBeenCalledWith(7777);
    expect(spawnMock).not.toHaveBeenCalled();
    // The refusal says that argent left the app it started running, with the logging.
    expect((err as Error).message).toContain(`argent restarted ${bundleId} (pid 7777)`);
  });

  it("with malloc_stack_logging, refuses the restarted process when the bundle on disk lost get-task-allow", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp(7777);
    runningMock.mockResolvedValue(trackedApp(4321));
    // The running process is a Debug build; the bundle on disk was rebuilt for release.
    signatureMock.mockImplementation(async (target) => signature(target === 4321));

    const err = await start(api, app, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(NOT_DEBUGGABLE);
    expect(signatureMock.mock.calls.map(([target]) => target)).toEqual([4321, 7777]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect((err as Error).message).toContain(`argent restarted ${bundleId} (pid 7777)`);
  });
});

describe("the native-profiler-start tool on a Mac app id", () => {
  it("resolves the Mac app's channel next to the session, and only for a Mac id", () => {
    expect(nativeProfilerStartTool.services({ device_id: deviceId })).toEqual({
      session: { urn: `NativeProfilerSession:${deviceId}`, options: expect.anything() },
      macosApp: { urn: `MacosApp:${deviceId}`, options: { device: resolveDevice(deviceId) } },
    });
    const ios = nativeProfilerStartTool.services({
      device_id: "6DBF83B4-0000-0000-0000-000000000000",
    });
    expect(Object.keys(ios)).toEqual(["session"]);
  });

  it("starts through the Mac branch, returns its warning and counts the run as profiling", async () => {
    const api = await session();
    const { app, launch } = fakeMacosApp(7777);

    const result = await executeStart({ session: api, macosApp: app }, {
      device_id: deviceId,
      template_path: TEMPLATE,
      malloc_stack_logging: true,
    } as never);

    expect(launch).toHaveBeenCalledWith({ restart: true, env: { MallocStackLogging: "1" } });
    expect(xctraceArgs()).toContain("--attach");
    expect(result).toMatchObject({ status: "recording", pid: 5151 });
    expect((result as { warning?: string }).warning).toContain(`argent restarted ${bundleId}`);
    expect(isProfiling(deviceId)).toBe(true);
    endRecording(api);
    expect(isProfiling(deviceId)).toBe(false);
  });

  it("keeps the result free of a warning when there is nothing to say", async () => {
    const api = await session();
    const { app } = fakeMacosApp();
    runningMock.mockResolvedValue(trackedApp(4321));

    const result = await executeStart({ session: api, macosApp: app }, {
      device_id: deviceId,
      template_path: TEMPLATE,
    } as never);

    expect(result).toEqual({ status: "recording", pid: 5151, traceFile: api.traceFile });
  });
});
