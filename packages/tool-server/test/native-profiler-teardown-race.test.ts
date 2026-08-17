/**
 * A teardown that lands INSIDE `native-profiler-start`'s readiness window.
 *
 * Start spawns its capture child and only then awaits a readiness handshake —
 * xctrace's `--notify-tracing-started`, or `startPerfetto`'s round trip. A
 * `stop-all-simulator-servers` arriving in that window used to see
 * `profilingActive` still false, so it disposed the session WITHOUT killing the
 * child and reported the session as stopped. The start then resumed and
 * returned `status: "recording"` against a session `Registry._teardown` had
 * already destroyed: the owner's `native-profiler-stop` answered "No active
 * native profiling session found. Call native-profiler-start first," and the
 * trace file sat on disk with nothing able to reach it.
 *
 * This became reachable outside process shutdown only when
 * `NativeProfilerSession` joined the teardown's namespace set.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";

vi.mock("../src/utils/adb", () => ({ adbShell: vi.fn(async () => "") }));
vi.mock("@argent/native-devtools-android", () => ({
  disposeWarmEngine: vi.fn(async () => {}),
  TraceProcessorUnavailableError: class extends Error {},
}));
vi.mock("../src/utils/android-profiler/capture", () => ({
  startPerfetto: vi.fn(),
  stopPerfetto: vi.fn(),
}));
vi.mock("../src/utils/android-profiler/detect-app", () => ({
  detectAndroidRunningApp: vi.fn(async () => "com.example.app"),
  validateAndroidAppProcess: vi.fn(async () => {}),
}));

import { adbShell } from "../src/utils/adb";
import { startPerfetto } from "../src/utils/android-profiler/capture";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { startNativeProfilerAndroid } from "../src/tools/profiler/native-profiler/platforms/android";

const adbShellMock = vi.mocked(adbShell);
const startPerfettoMock = vi.mocked(startPerfetto);

const iosDevice = { id: "6DBF83B4-0000-0000-0000-000000000000", platform: "ios" } as DeviceInfo;
const androidDevice = { id: "emulator-5554", platform: "android" } as DeviceInfo;

class FakeChild extends EventEmitter {
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
    return true;
  });
}

async function session(device: DeviceInfo) {
  return nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
}

beforeEach(() => {
  adbShellMock.mockClear();
  startPerfettoMock.mockReset();
});

describe("a teardown inside the native-profiler start window", () => {
  it("iOS: SIGKILLs a child the start handed over before declaring the run active", async () => {
    const instance = await session(iosDevice);
    const api = instance.api as NativeProfilerSessionApi;
    // Exactly what `attemptStart` leaves behind while it awaits readiness.
    const child = new FakeChild();
    api.captureProcess = child as unknown as ChildProcess;
    api.capturePid = 4242;
    expect(api.profilingActive).toBe(false);

    await instance.dispose();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(api.captureProcess).toBeNull();
  });

  it("marks the session disposed, so a resuming start can see it is gone", async () => {
    const instance = await session(iosDevice);
    const api = instance.api as NativeProfilerSessionApi;
    expect(api.disposed).toBe(false);

    await instance.dispose();

    expect(api.disposed).toBe(true);
  });

  it("Android: fails the start instead of reporting a recording nothing can stop", async () => {
    const instance = await session(androidDevice);
    const api = instance.api as NativeProfilerSessionApi;

    // The teardown lands while perfetto is still coming up.
    startPerfettoMock.mockImplementation(async () => {
      await instance.dispose();
      return {
        pid: 9001,
        onDeviceTracePath: "/data/misc/perfetto-traces/fake.pftrace",
        child: new FakeChild() as unknown as ChildProcess,
      };
    });

    const err = await startNativeProfilerAndroid(api, { device_id: androidDevice.id }).catch(
      (e: unknown) => e
    );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN);
    expect((err as Error).message).toContain("torn down by a stop-all-simulator-servers");
    // The session state must stay clean — a `status: "recording"` was the bug.
    expect(api.profilingActive).toBe(false);
    expect(api.recordingTimeout).toBeNull();
    // And the daemon this attempt spawned is this attempt's to reap: the
    // teardown never saw it, because `capturePid` is handed over after the await.
    expect(adbShellMock).toHaveBeenCalledWith(androidDevice.id, "kill -KILL 9001");
    expect(adbShellMock).toHaveBeenCalledWith(
      androidDevice.id,
      "rm -f /data/misc/perfetto-traces/fake.pftrace"
    );
  });

  it("Android: an undisturbed start still reports the recording", async () => {
    // The control — the guard must not fire on the ordinary path.
    const instance = await session(androidDevice);
    const api = instance.api as NativeProfilerSessionApi;
    startPerfettoMock.mockResolvedValue({
      pid: 9002,
      onDeviceTracePath: "/data/misc/perfetto-traces/real.pftrace",
      child: new FakeChild() as unknown as ChildProcess,
    });

    const result = await startNativeProfilerAndroid(api, { device_id: androidDevice.id });

    expect(result.status).toBe("recording");
    expect(api.profilingActive).toBe(true);
    await instance.dispose();
  });
});
