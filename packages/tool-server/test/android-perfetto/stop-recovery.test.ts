import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

// Mock the capture layer so the stop path never shells out to adb. We drive
// stopPerfetto's success/failure to assert the session-state reset behaviour.
vi.mock("../../src/utils/android-profiler/capture", () => ({
  startPerfetto: vi.fn(),
  stopPerfetto: vi.fn(),
}));

import { stopPerfetto } from "../../src/utils/android-profiler/capture";
import { stopNativeProfilerAndroid } from "../../src/tools/profiler/native-profiler/platforms/android";

const mockedStop = vi.mocked(stopPerfetto);

async function buildAndroidSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "emulator-5554", platform: "android" as const, kind: "emulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

function primeActiveSession(api: NativeProfilerSessionApi): void {
  api.profilingActive = true;
  api.capturePid = 12345;
  api.captureProcess = { kill: () => true } as never;
  api.androidOnDeviceTracePath = "/data/misc/perfetto-traces/argent-x.pftrace";
  api.traceFile = "/tmp/native-profiler-x.pftrace";
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
}

describe("stopNativeProfilerAndroid — session-state reset (stability #2)", () => {
  beforeEach(() => {
    mockedStop.mockReset();
  });

  it("resets the session to a startable state even when adb pull fails", async () => {
    const api = await buildAndroidSession();
    primeActiveSession(api);
    mockedStop.mockRejectedValueOnce(new Error("adb pull failed: device offline"));

    await expect(stopNativeProfilerAndroid(api)).rejects.toThrow(/device offline/);

    // A transient pull failure must not wedge the session — the next start
    // should be allowed.
    expect(api.profilingActive).toBe(false);
    expect(api.captureProcess).toBeNull();
    expect(api.recordingTimedOut).toBe(false);
    expect(api.recordingExitedUnexpectedly).toBe(false);
  });

  it("clears the recording-cap timeout before the pull so a failed pull can't leak it", async () => {
    const api = await buildAndroidSession();
    primeActiveSession(api);
    const timeout = setTimeout(() => {}, 60_000);
    api.recordingTimeout = timeout;
    mockedStop.mockRejectedValueOnce(new Error("host disk full"));

    await expect(stopNativeProfilerAndroid(api)).rejects.toThrow(/disk full/);

    expect(api.recordingTimeout).toBeNull();
    clearTimeout(timeout);
  });

  it("returns the trace and resets state on a successful stop", async () => {
    const api = await buildAndroidSession();
    primeActiveSession(api);
    mockedStop.mockResolvedValueOnce({
      hostTracePath: "/tmp/native-profiler-x.pftrace",
      warning: "pulled the partial trace",
    });

    const result = await stopNativeProfilerAndroid(api);

    expect(result.traceFile).toBe("/tmp/native-profiler-x.pftrace");
    expect(result.warning).toBe("pulled the partial trace");
    expect(api.exportedFiles).toEqual({ pftrace: "/tmp/native-profiler-x.pftrace" });
    expect(api.profilingActive).toBe(false);
    expect(api.captureProcess).toBeNull();
  });
});
