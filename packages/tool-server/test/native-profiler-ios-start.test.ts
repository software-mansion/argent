/**
 * The iOS half of `native-profiler-start`, driven at its module boundaries
 * (xctrace spawn, the readiness handshake, the capture strategy, simctl).
 *
 * Two of its lines had no coverage at all, because the only start-side test
 * file is Android-only:
 *
 *   - the teardown-breadcrumb clear. A breadcrumb explains ONE confusing
 *     answer — the "no active session" a reaped capture's own stop would get —
 *     so a start that succeeds afterwards makes it unconsumable, and it would
 *     sit in the process-global map until some genuinely unrelated later
 *     absence collected it and blamed a teardown that had nothing to do with
 *     it. The Android twin clears it and is tested; iOS was not.
 *   - the disposed-session guard, which turns a start whose session a teardown
 *     destroyed mid-handshake into a failure instead of a `status: "recording"`
 *     nothing can stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import * as os from "node:os";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";

class FakeXctrace extends EventEmitter {
  pid = 4242;
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
  // Every simctl helper on this path goes through execFileSync. Failing it puts
  // `resolveExplicitApp` on its documented "app is not running yet" fallback,
  // which attaches by name — the cold-start-retry shape.
  execFileSync: vi.fn(() => {
    throw new Error("simctl unavailable in this test");
  }),
}));
vi.mock("../src/utils/ios-device-sets", () => ({
  deviceSetForUdid: vi.fn(async () => undefined),
  simctlArgsForUdidSync: vi.fn((_udid: string, args: string[]) => args),
}));
vi.mock("../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(async () => os.tmpdir()),
}));
vi.mock("../src/utils/ios-profiler/notify", () => ({
  // Null handle: the start falls back to the stdout substring match, and
  // `waitForXctraceReady` below is what decides readiness either way.
  listenForDarwinNotification: vi.fn(() => {
    throw new Error("notifyutil unavailable in this test");
  }),
}));
vi.mock("../src/utils/ios-profiler/startup", () => ({
  waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
}));
vi.mock("../src/utils/simulator-watcher", () => ({
  firstSimulatorPoll: vi.fn(async () => {}),
}));
// The real helper lookup, which reads the macosArtifacts mock below.
vi.mock("../src/utils/macos-suspension-watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/macos-suspension-watch")>()),
  startSuspensionWatch: vi.fn(async () => null),
}));
vi.mock("@argent/native-devtools-ios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/native-devtools-ios")>()),
  macosArtifacts: vi.fn(() => ({
    bootstrap: "/fake/bootstrap.dylib",
    library: "/fake/library.dylib",
    helper: "/fake/argent-macos-helper",
  })),
}));
vi.mock("../src/utils/ios-profiler/capture-strategy", () => ({
  selectIosCaptureStrategy: vi.fn(() => ({
    name: "device",
    attachesByName: true,
    cpuFilterPid: () => null,
    buildRecordArgs: () => ["record", "--device", "UDID"],
  })),
  resolveIosCaptureStrategy: vi.fn(() => ({ name: "device" })),
  warnIfInvalidCaptureOverride: vi.fn(),
}));

import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { startNativeProfilerIos } from "../src/tools/profiler/native-profiler/platforms/ios";
import { __resetXctraceRecordingsForTesting } from "../src/tools/profiler/native-profiler/platforms/xctrace";
import { execFileSync, spawn } from "child_process";
import { waitForXctraceReady } from "../src/utils/ios-profiler/startup";
import { resolveIosCaptureStrategy } from "../src/utils/ios-profiler/capture-strategy";
import {
  recordReapedSession,
  takeReapedSession,
  __resetReapedSessionsForTesting,
} from "../src/utils/reaped-sessions";

const iosDevice = { id: "6DBF83B4-0000-0000-0000-000000000000", platform: "ios" } as DeviceInfo;

async function session() {
  return nativeProfilerSessionBlueprint.factory({}, iosDevice, { device: iosDevice } as never);
}

const startParams = {
  device_id: iosDevice.id,
  app_process: "Bluesky",
  template_path: "/tmp/Argent.tracetemplate",
};

beforeEach(() => {
  __resetReapedSessionsForTesting();
  // Each test's fake xctrace keeps running.
  __resetXctraceRecordingsForTesting();
});

/** How long a start waits after xctrace reports that it records, before it returns. */
const ARM_SETTLE_MS = 1_500;

/** Runs a start on the fake clock past the wait after the recording starts. */
async function settled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);
  return promise;
}

describe("startNativeProfilerIos", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the teardown breadcrumb its own success would make unconsumable", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    recordReapedSession("native-profiler", api.deviceId, "an earlier trace");

    const result = await settled(startNativeProfilerIos(api, startParams));

    expect(result.status).toBe("recording");
    expect(takeReapedSession("native-profiler", api.deviceId)).toBeUndefined();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("leaves another device's breadcrumb alone", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    recordReapedSession("native-profiler", "emulator-5554", "somebody else's trace");

    await settled(startNativeProfilerIos(api, startParams));

    expect(takeReapedSession("native-profiler", "emulator-5554")).toBeDefined();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("fails, rather than reporting a recording, when a teardown lands mid-handshake", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    const startup = await import("../src/utils/ios-profiler/startup");
    vi.mocked(startup.waitForXctraceReady).mockImplementationOnce(async () => {
      await instance.dispose();
      return { stderrBuffer: "" };
    });

    const err = await startNativeProfilerIos(api, startParams).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN);
    expect(api.profilingActive).toBe(false);
    expect(api.captureProcess).toBeNull();
    expect(api.recordingTimeout).toBeNull();
  });

  it("starts no xctrace when a teardown lands before the spawn", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    const dump = await import("../src/utils/react-profiler/debug/dump");
    // The trace path, which the start resolves before it spawns xctrace.
    vi.mocked(dump.getDebugDir).mockImplementationOnce(async () => {
      await instance.dispose();
      return os.tmpdir();
    });
    vi.mocked(spawn).mockClear();

    const err = await startNativeProfilerIos(api, startParams).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN);
    expect(spawn).not.toHaveBeenCalled();
    expect(api.captureProcess).toBeNull();
  });

  it("kills the xctrace it spawned rather than leaving it recording", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    const child = new FakeXctrace();
    const cp = await import("child_process");
    vi.mocked(cp.spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const startup = await import("../src/utils/ios-profiler/startup");
    vi.mocked(startup.waitForXctraceReady).mockImplementationOnce(async () => {
      await instance.dispose();
      return { stderrBuffer: "" };
    });

    await startNativeProfilerIos(api, startParams).catch(() => {});

    expect(child.kill).toHaveBeenCalled();
  });
});

describe("startNativeProfilerIos and a teardown during the readiness wait", () => {
  /** Starts with the real readiness wait, and tears the session down while it waits. */
  async function startAndTearDown(params: Parameters<typeof startNativeProfilerIos>[1]) {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    const child = new FakeXctrace();
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const actual = await vi.importActual<typeof import("../src/utils/ios-profiler/startup")>(
      "../src/utils/ios-profiler/startup"
    );
    vi.mocked(waitForXctraceReady).mockImplementationOnce(actual.waitForXctraceReady);

    const pending = startNativeProfilerIos(api, params).catch((e: unknown) => e);
    await vi.waitFor(() => expect(api.captureProcess).toBe(child));
    await instance.dispose();
    return { api, child, err: await pending };
  }

  it("fails as torn down, not as an xctrace that exited", async () => {
    const { api, child, err } = await startAndTearDown(startParams);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN);
    expect((err as Error).message).toContain("torn down by a stop-all-simulator-servers");
    expect(api.profilingActive).toBe(false);
    expect(api.captureProcess).toBeNull();
  });

  it("with malloc_stack_logging, does not launch the app again", async () => {
    vi.mocked(resolveIosCaptureStrategy).mockReturnValueOnce({
      strategy: { name: "device" },
      reason: { kind: "default" },
    } as unknown as ReturnType<typeof resolveIosCaptureStrategy>);
    const app = {
      CFBundleExecutable: "Bluesky",
      CFBundleIdentifier: "xyz.blueskyweb.app",
      ApplicationType: "User",
    };
    const simctl = vi.mocked(execFileSync);
    simctl.mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === "plutil") return JSON.stringify({ [app.CFBundleIdentifier]: app });
      if (args.includes("get_app_container")) return "/apps/Bluesky.app\n";
      // listapps, terminate and launch succeed.
      return "";
    }) as unknown as typeof execFileSync);
    try {
      const { err } = await startAndTearDown({ ...startParams, malloc_stack_logging: true });

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN
      );
      const calls = simctl.mock.calls.map(([, args]) => (args as string[]).join(" "));
      expect(calls).toContain(`terminate ${iosDevice.id} ${app.CFBundleIdentifier}`);
      expect(calls).not.toContain(`launch ${iosDevice.id} ${app.CFBundleIdentifier}`);
    } finally {
      simctl.mockImplementation(() => {
        throw new Error("simctl unavailable in this test");
      });
    }
  });
});

describe("startNativeProfilerIos: the wait after the recording starts", () => {
  const STARTING = "Starting recording with the Time Profiler template. Targeting All Processes.\n";
  const TRACING = "Ctrl-C to stop the recording\n";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A start with the real readiness wait, which ends at xctrace's first line. */
  async function startWithReadiness() {
    const actual = await vi.importActual<typeof import("../src/utils/ios-profiler/startup")>(
      "../src/utils/ios-profiler/startup"
    );
    vi.mocked(waitForXctraceReady).mockImplementationOnce(actual.waitForXctraceReady);
    const api = (await session()).api as NativeProfilerSessionApi;
    const state = { done: false, error: undefined as unknown };
    const pending = startNativeProfilerIos(api, startParams);
    pending.then(
      () => (state.done = true),
      (err: unknown) => {
        state.done = true;
        state.error = err;
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    const child = api.captureProcess as unknown as FakeXctrace;
    expect(child).toBeInstanceOf(FakeXctrace);
    return { api, pending, state, child };
  }

  it("returns only 1.5 s after xctrace says that tracing started", async () => {
    const { api, pending, state, child } = await startWithReadiness();

    child.stdout.emit("data", Buffer.from(STARTING));
    // xctrace prints the Ctrl-C line 1.2 to 1.7 s later, when tracing starts.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.done).toBe(false);
    expect(api.profilingActive).toBe(false);

    child.stdout.emit("data", Buffer.from(TRACING));
    await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: "recording" });
    expect(api.profilingActive).toBe(true);
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("fails with what xctrace printed when it quits in that time", async () => {
    const { api, state, child } = await startWithReadiness();

    child.stdout.emit("data", Buffer.from(STARTING + TRACING));
    await vi.advanceTimersByTimeAsync(1_000);
    child.stdout.emit(
      "data",
      Buffer.from(
        "Run issues were detected (trace is still ready to be viewed):\n" +
          "* [Error] Failed to start the recording: _lockKPerf: could not lock kperf. " +
          "Likely another session just started.\n"
      )
    );
    child.exitWith(null, 2);
    await vi.advanceTimersByTimeAsync(0);

    expect(getFailureSignal(state.error)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED
    );
    expect((state.error as Error).message).toContain(
      "xctrace said: Failed to start the recording: _lockKPerf: could not lock kperf."
    );
    // As the stop says for this error: the app is not the cause.
    expect((state.error as Error).message).toContain(
      "macOS lets one recording at a time use the kernel trace"
    );
    expect((state.error as Error).message).not.toContain("Check that the app still runs");
    expect(api.profilingActive).toBe(false);
    expect(api.captureProcess).toBeNull();
  });
});

describe("startNativeProfilerIos when the app list times out", () => {
  /** What execFileSync throws when its timeout ends the call. */
  const timedOut = () =>
    Object.assign(new Error("spawnSync xcrun ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGKILL" });

  beforeEach(async () => {
    const { selectIosCaptureStrategy } = await import("../src/utils/ios-profiler/capture-strategy");
    // The all-processes capture finds the app by its pid.
    vi.mocked(selectIosCaptureStrategy).mockReturnValueOnce({
      name: "all-processes",
      attachesByName: false,
      cpuFilterPid: () => null,
      buildRecordArgs: () => ["record", "--all-processes"],
    } as never);
    vi.mocked(execFileSync).mockImplementation(((_file: string, args: string[]) => {
      if (args.includes("launchctl")) throw timedOut();
      throw new Error("simctl unavailable in this test");
    }) as never);
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation((() => {
      throw new Error("simctl unavailable in this test");
    }) as never);
  });

  it("says that the list timed out, not that the app does not run", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;

    const error = await startNativeProfilerIos(api, startParams).catch((err: unknown) => err);

    expect(getFailureSignal(error)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_APP_PROCESS_LIST_FAILED
    );
    expect((error as Error).message).toContain("within 10000 ms");
    expect((error as Error).message).not.toContain("no running PID");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ends a launchctl call that does not end on its timeout", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;

    await startNativeProfilerIos(api, startParams).catch(() => {});

    const call = vi
      .mocked(execFileSync)
      .mock.calls.find(([, args]) => (args as string[]).includes("launchctl"));
    // simctl spawn passes SIGTERM on to the process in the simulator and waits for it.
    expect(call?.[2]).toMatchObject({ timeout: 10_000, killSignal: "SIGKILL" });
  });
});

describe("startNativeProfilerIos with malloc_stack_logging", () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation((() => {
      throw new Error("simctl unavailable in this test");
    }) as never);
  });

  it("ends each simctl call of the malloc_stack_logging path that does not end on its timeout", async () => {
    vi.mocked(resolveIosCaptureStrategy).mockReturnValueOnce({
      strategy: { name: "device" },
      reason: { kind: "default" },
    } as unknown as ReturnType<typeof resolveIosCaptureStrategy>);
    const app = {
      CFBundleExecutable: "Bluesky",
      CFBundleIdentifier: "xyz.blueskyweb.app",
      ApplicationType: "User",
    };
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === "plutil") return JSON.stringify({ [app.CFBundleIdentifier]: app });
      if (args.includes("get_app_container")) return "/apps/Bluesky.app\n";
      return "";
    }) as never);
    // A failed start launches the app again.
    vi.mocked(waitForXctraceReady).mockRejectedValueOnce(new Error("xctrace failed"));
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;

    await startNativeProfilerIos(api, { ...startParams, malloc_stack_logging: true }).catch(
      () => {}
    );

    const simctl = vi
      .mocked(execFileSync)
      .mock.calls.filter(([file]) => file === "xcrun")
      .map(([, args, options]) => [
        (args as string[])[0],
        (options as { killSignal?: string })?.killSignal,
      ]);
    expect(simctl).toEqual([
      ["listapps", "SIGKILL"],
      ["get_app_container", "SIGKILL"],
      ["terminate", "SIGKILL"],
      ["launch", "SIGKILL"],
    ]);
  });
});

/**
 * The leak check of the Argent template suspends the whole simulator app, and
 * xctrace counts the pause in a hang. The start watches the app's host pid with
 * the helper of Mac apps, so analyze can take the pauses out.
 */
describe("startNativeProfilerIos and the app's suspensions", () => {
  const APP_PID = 4321;

  async function mockRunningApp() {
    const cp = await import("child_process");
    vi.mocked(cp.execFileSync).mockImplementation(((_file: string, args: readonly string[]) => {
      if (args.includes("launchctl"))
        return `${APP_PID}\t0\tUIKitApplication:com.example.app[1a]\n`;
      if (args.includes("listapps")) return "(plist)";
      if (args.includes("get_app_container")) return "/apps/Bluesky.app\n";
      if (args[0] === "-convert") {
        return JSON.stringify({
          "com.example.app": {
            CFBundleExecutable: "Bluesky",
            CFBundleIdentifier: "com.example.app",
            ApplicationType: "User",
          },
        });
      }
      return "";
    }) as never);
  }

  function fakeWatch() {
    return {
      pid: APP_PID,
      suspendedSince: () => null,
      suspendedMsBetween: () => 0,
      waitUntilRunning: async () => true,
      end: vi.fn(() => [{ startMs: 1, endMs: 2 }]),
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    await mockRunningApp();
    const watch = await import("../src/utils/macos-suspension-watch");
    vi.mocked(watch.startSuspensionWatch).mockReset().mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    const cp = await import("child_process");
    vi.mocked(cp.execFileSync).mockImplementation(() => {
      throw new Error("simctl unavailable in this test");
    });
  });

  it("watches the app's host pid from before xctrace attaches, for the session", async () => {
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const cp = await import("child_process");
    const watch = fakeWatch();
    let spawnedBeforeWatch: boolean | null = null;
    vi.mocked(startSuspensionWatch).mockImplementationOnce(async () => {
      spawnedBeforeWatch = vi.mocked(cp.spawn).mock.calls.length > spawnsBefore;
      return watch;
    });
    const spawnsBefore = vi.mocked(cp.spawn).mock.calls.length;
    const api = (await session()).api as NativeProfilerSessionApi;

    await settled(startNativeProfilerIos(api, startParams));

    expect(startSuspensionWatch).toHaveBeenCalledWith("/fake/argent-macos-helper", APP_PID);
    expect(spawnedBeforeWatch).toBe(false);
    expect(vi.mocked(cp.spawn).mock.calls.length).toBeGreaterThan(spawnsBefore);
    expect(api.suspensionWatch).toBe(watch);
    expect(watch.end).not.toHaveBeenCalled();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  /** The order of the first call of each mock, for "before" and "after". */
  function firstCall(mock: { mock: { invocationCallOrder: number[] } }): number {
    return mock.mock.invocationCallOrder[0] ?? Infinity;
  }

  /** The first launchctl list call of this test. */
  async function firstLaunchctlCall(): Promise<number> {
    const cp = await import("child_process");
    const mock = vi.mocked(cp.execFileSync).mock;
    const index = mock.calls.findIndex(([, args]) => (args as string[]).includes("launchctl"));
    return index < 0 ? Infinity : mock.invocationCallOrder[index]!;
  }

  const mallocParams = { ...startParams, malloc_stack_logging: true };

  function deviceForMalloc(): void {
    vi.mocked(resolveIosCaptureStrategy).mockReturnValueOnce({
      strategy: { name: "device" },
      reason: { kind: "default" },
    } as unknown as ReturnType<typeof resolveIosCaptureStrategy>);
  }

  it("watches the app that malloc_stack_logging launches, from when the start finds its pid", async () => {
    // xctrace launches the app, so the start knows its pid only after the start.
    deviceForMalloc();
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const cp = await import("child_process");
    vi.mocked(cp.execFileSync).mockClear();
    vi.mocked(cp.spawn).mockClear();
    const watch = fakeWatch();
    vi.mocked(startSuspensionWatch).mockResolvedValueOnce(watch);
    const api = (await session()).api as NativeProfilerSessionApi;

    await settled(startNativeProfilerIos(api, mallocParams));

    expect(vi.mocked(cp.spawn).mock.calls[0]?.[1]).toContain("--launch");
    expect(startSuspensionWatch).toHaveBeenCalledWith("/fake/argent-macos-helper", APP_PID);
    expect(firstCall(vi.mocked(cp.spawn))).toBeLessThan(await firstLaunchctlCall());
    expect(await firstLaunchctlCall()).toBeLessThan(firstCall(vi.mocked(startSuspensionWatch)));
    expect(api.suspensionWatch).toBe(watch);
    expect(watch.end).not.toHaveBeenCalled();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("watches an app that xctrace attached to by name, from when the start finds its pid", async () => {
    // The app was not running yet when the start listed the apps.
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const cp = await import("child_process");
    vi.mocked(cp.spawn).mockClear();
    const listed = vi.mocked(cp.execFileSync).getMockImplementation()!;
    vi.mocked(cp.execFileSync).mockImplementation(((file: string, args: readonly string[]) =>
      args.includes("launchctl") && vi.mocked(cp.spawn).mock.calls.length === 0
        ? ""
        : listed(file, args as string[])) as never);
    const watch = fakeWatch();
    vi.mocked(startSuspensionWatch).mockResolvedValueOnce(watch);
    const api = (await session()).api as NativeProfilerSessionApi;

    await settled(startNativeProfilerIos(api, startParams));

    expect(startSuspensionWatch).toHaveBeenCalledTimes(1);
    expect(startSuspensionWatch).toHaveBeenCalledWith("/fake/argent-macos-helper", APP_PID);
    expect(firstCall(vi.mocked(cp.spawn))).toBeLessThan(firstCall(vi.mocked(startSuspensionWatch)));
    expect(api.suspensionWatch).toBe(watch);
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("records as before when the start does not find the pid after the start", async () => {
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const cp = await import("child_process");
    const listed = vi.mocked(cp.execFileSync).getMockImplementation()!;

    // By name: the app is not listed after the start either.
    vi.mocked(cp.execFileSync).mockImplementation(((file: string, args: readonly string[]) =>
      args.includes("launchctl") ? "" : listed(file, args as string[])) as never);
    const byName = (await session()).api as NativeProfilerSessionApi;
    await expect(settled(startNativeProfilerIos(byName, startParams))).resolves.toMatchObject({
      status: "recording",
    });
    expect(byName.suspensionWatch).toBeNull();
    if (byName.recordingTimeout) clearTimeout(byName.recordingTimeout);

    // malloc_stack_logging: the list fails after the start.
    __resetXctraceRecordingsForTesting();
    vi.mocked(cp.execFileSync).mockImplementation(((file: string, args: readonly string[]) => {
      if (args.includes("launchctl")) throw new Error("launchctl timed out");
      return listed(file, args as string[]);
    }) as never);
    deviceForMalloc();
    const launched = (await session()).api as NativeProfilerSessionApi;
    await expect(settled(startNativeProfilerIos(launched, mallocParams))).resolves.toMatchObject({
      status: "recording",
    });
    expect(launched.suspensionWatch).toBeNull();
    expect(startSuspensionWatch).not.toHaveBeenCalled();
    if (launched.recordingTimeout) clearTimeout(launched.recordingTimeout);
  });

  it("does not read the app list again after the start when it failed before", async () => {
    // Each call can wait out its 10 s timeout, and the start waits for it.
    const cp = await import("child_process");
    const listed = vi.mocked(cp.execFileSync).getMockImplementation()!;
    vi.mocked(cp.execFileSync).mockImplementation(((file: string, args: readonly string[]) => {
      if (args.includes("launchctl")) throw new Error("spawnSync xcrun ETIMEDOUT");
      return listed(file, args as string[]);
    }) as never);
    vi.mocked(cp.execFileSync).mockClear();
    const api = (await session()).api as NativeProfilerSessionApi;

    await expect(settled(startNativeProfilerIos(api, startParams))).resolves.toMatchObject({
      status: "recording",
    });

    const launchctlCalls = vi
      .mocked(cp.execFileSync)
      .mock.calls.filter(([, args]) => (args as string[]).includes("launchctl"));
    expect(launchctlCalls).toHaveLength(1);
    expect(api.suspensionWatch).toBeNull();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("fails and ends the watch when xctrace quits while the watch starts", async () => {
    deviceForMalloc();
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const cp = await import("child_process");
    const child = new FakeXctrace();
    vi.mocked(cp.spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const watch = fakeWatch();
    vi.mocked(startSuspensionWatch).mockImplementationOnce(async () => {
      child.exitWith(null, 1);
      return watch;
    });
    vi.mocked(cp.execFileSync).mockClear();
    const api = (await session()).api as NativeProfilerSessionApi;

    const err = await settled(startNativeProfilerIos(api, mallocParams)).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_XCTRACE_READY_EXITED
    );
    expect(watch.end).toHaveBeenCalledTimes(1);
    expect(api.suspensionWatch).toBeNull();
    expect(api.profilingActive).toBe(false);
    // The malloc path terminated the app for its cold start, and restores it.
    const calls = vi
      .mocked(cp.execFileSync)
      .mock.calls.map(([, args]) => (args as string[]).join(" "));
    expect(calls).toContain(`launch ${iosDevice.id} com.example.app`);
  });

  it("ends the watch of a recording that the cap ended without a stop", async () => {
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const watch = fakeWatch();
    vi.mocked(startSuspensionWatch).mockResolvedValueOnce(watch);
    const api = (await session()).api as NativeProfilerSessionApi;
    const capped = fakeWatch();
    api.suspensionWatch = capped;
    api.recordingTimedOut = true;

    await settled(startNativeProfilerIos(api, startParams));

    expect(capped.end).toHaveBeenCalledTimes(1);
    expect(api.suspensionWatch).toBe(watch);
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("does not watch with the all-processes fallback, which records no leak check", async () => {
    const strategy = await import("../src/utils/ios-profiler/capture-strategy");
    vi.mocked(strategy.selectIosCaptureStrategy).mockReturnValueOnce({
      name: "all-processes",
      attachesByName: false,
      cpuFilterPid: () => APP_PID,
      buildRecordArgs: () => ["record", "--all-processes"],
    } as never);
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const api = (await session()).api as NativeProfilerSessionApi;

    await settled(startNativeProfilerIos(api, startParams));

    expect(startSuspensionWatch).not.toHaveBeenCalled();
    expect(api.suspensionWatch).toBeNull();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("records as before when there is no helper or it cannot watch", async () => {
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const native = await import("@argent/native-devtools-ios");
    vi.mocked(native.macosArtifacts).mockImplementationOnce(() => {
      throw new Error("macOS app artifact not found");
    });
    const noHelper = (await session()).api as NativeProfilerSessionApi;
    await expect(settled(startNativeProfilerIos(noHelper, startParams))).resolves.toMatchObject({
      status: "recording",
    });
    expect(startSuspensionWatch).not.toHaveBeenCalled();
    expect(noHelper.suspensionWatch).toBeNull();
    if (noHelper.recordingTimeout) clearTimeout(noHelper.recordingTimeout);

    // A helper from before the command: startSuspensionWatch returns null. The
    // first fake xctrace keeps running, and would refuse a second recording.
    __resetXctraceRecordingsForTesting();
    const oldHelper = (await session()).api as NativeProfilerSessionApi;
    await expect(settled(startNativeProfilerIos(oldHelper, startParams))).resolves.toMatchObject({
      status: "recording",
    });
    expect(startSuspensionWatch).toHaveBeenCalledTimes(1);
    expect(oldHelper.suspensionWatch).toBeNull();
    if (oldHelper.recordingTimeout) clearTimeout(oldHelper.recordingTimeout);
  });

  it("ends the watch when xctrace does not start, and when a teardown lands mid-handshake", async () => {
    const { startSuspensionWatch } = await import("../src/utils/macos-suspension-watch");
    const startup = await import("../src/utils/ios-profiler/startup");

    const failed = fakeWatch();
    vi.mocked(startSuspensionWatch).mockResolvedValueOnce(failed);
    vi.mocked(startup.waitForXctraceReady).mockRejectedValueOnce(new Error("xctrace exited"));
    const api = (await session()).api as NativeProfilerSessionApi;
    await expect(settled(startNativeProfilerIos(api, startParams))).rejects.toThrow(
      "xctrace exited"
    );
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(api.suspensionWatch).toBeNull();

    // The fake xctrace of the failed start keeps running.
    __resetXctraceRecordingsForTesting();
    const torn = fakeWatch();
    vi.mocked(startSuspensionWatch).mockResolvedValueOnce(torn);
    const instance = await session();
    vi.mocked(startup.waitForXctraceReady).mockImplementationOnce(async () => {
      await instance.dispose();
      return { stderrBuffer: "" };
    });
    const tornApi = instance.api as NativeProfilerSessionApi;
    const err = await settled(startNativeProfilerIos(tornApi, startParams)).catch(
      (e: unknown) => e
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN);
    expect(torn.end).toHaveBeenCalledTimes(1);
    expect(tornApi.suspensionWatch).toBeNull();
  });
});
