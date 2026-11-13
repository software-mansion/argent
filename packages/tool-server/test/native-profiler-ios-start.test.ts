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
