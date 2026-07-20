/**
 * Device-free coverage of the start-path app_process dispatch (PR #340,
 * behavior 1). The full validate-against-a-real-device flow is covered by the
 * emulator E2E; this pins the pure dispatch logic and — crucially — the
 * fail-fast ORDERING that is the whole point of the change: an explicit
 * app_process is validated BEFORE perfetto is started, so a bogus target fails
 * immediately instead of producing a zero-sample trace that only errors minutes
 * later at analyze time.
 *
 * Everything below the handler is stubbed at the module boundary (no adb, no
 * perfetto, no fs), so this never touches a device.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

const validateAndroidAppProcess = vi.fn();
const detectAndroidRunningApp = vi.fn();
const startPerfetto = vi.fn();

vi.mock("../../src/utils/android-profiler/detect-app", () => ({
  validateAndroidAppProcess: (...a: unknown[]) => validateAndroidAppProcess(...a),
  detectAndroidRunningApp: (...a: unknown[]) => detectAndroidRunningApp(...a),
}));
vi.mock("../../src/utils/android-profiler/capture", () => ({
  startPerfetto: (...a: unknown[]) => startPerfetto(...a),
  stopPerfetto: vi.fn(),
}));
vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(async () => "/tmp/argent-profiler-cwd"),
}));

import { startNativeProfilerAndroid } from "../../src/tools/profiler/native-profiler/platforms/android";

async function buildAndroidSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "emulator-5554", platform: "android" as const, kind: "emulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

describe("startNativeProfilerAndroid — app_process dispatch (fail-fast validation)", () => {
  beforeEach(() => {
    validateAndroidAppProcess.mockReset();
    detectAndroidRunningApp.mockReset();
    startPerfetto.mockReset();
    startPerfetto.mockResolvedValue({
      pid: 4242,
      onDeviceTracePath: "/data/misc/perfetto-traces/argent-x.pftrace",
      child: { kill: () => true },
    });
  });

  it("validates an explicit app_process BEFORE starting perfetto, and stamps wallClockStartMs", async () => {
    const api = await buildAndroidSession();
    const callOrder: string[] = [];
    validateAndroidAppProcess.mockImplementation(async () => {
      callOrder.push("validate");
    });
    startPerfetto.mockImplementation(async () => {
      callOrder.push("start");
      return {
        pid: 4242,
        onDeviceTracePath: "/data/misc/perfetto-traces/argent-x.pftrace",
        child: { kill: () => true },
      };
    });

    const before = Date.now();
    const result = await startNativeProfilerAndroid(api, {
      device_id: "emulator-5554",
      app_process: "  com.example.app  ", // also exercises the .trim()
    });

    expect(validateAndroidAppProcess).toHaveBeenCalledWith("emulator-5554", "com.example.app");
    expect(detectAndroidRunningApp).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["validate", "start"]); // fail-fast ordering
    expect(api.appProcess).toBe("com.example.app");
    expect(api.profilingActive).toBe(true);
    expect(api.wallClockStartMs).toBeGreaterThanOrEqual(before);
    expect(result.status).toBe("recording");
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("does NOT start perfetto when validation rejects (bogus app_process fails fast)", async () => {
    const api = await buildAndroidSession();
    validateAndroidAppProcess.mockRejectedValueOnce(
      new Error("app_process `com.bogus` was not found on emulator-5554")
    );

    await expect(
      startNativeProfilerAndroid(api, {
        device_id: "emulator-5554",
        app_process: "com.bogus",
      })
    ).rejects.toThrow(/was not found/);

    expect(startPerfetto).not.toHaveBeenCalled();
    expect(api.profilingActive).toBe(false);
  });

  it("auto-detects the foreground app when app_process is omitted (no validation call)", async () => {
    const api = await buildAndroidSession();
    detectAndroidRunningApp.mockResolvedValueOnce("com.detected.app");

    await startNativeProfilerAndroid(api, { device_id: "emulator-5554" });

    expect(detectAndroidRunningApp).toHaveBeenCalledWith("emulator-5554");
    expect(validateAndroidAppProcess).not.toHaveBeenCalled();
    expect(api.appProcess).toBe("com.detected.app");
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("treats a whitespace-only app_process as omitted (falls back to auto-detect)", async () => {
    const api = await buildAndroidSession();
    detectAndroidRunningApp.mockResolvedValueOnce("com.detected.app");

    await startNativeProfilerAndroid(api, { device_id: "emulator-5554", app_process: "   " });

    expect(validateAndroidAppProcess).not.toHaveBeenCalled();
    expect(detectAndroidRunningApp).toHaveBeenCalledOnce();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("a failed startPerfetto does not burn a prior capture's pending partial-trace recovery", async () => {
    // Pass-4 finding 2 (same class the iOS start path already guards): a prior
    // capture hit the 10-min cap — recordingTimedOut=true with its partial trace
    // still on the device, recoverable by native-profiler-stop. A new start whose
    // startPerfetto then fails (adb offline, spawn failure) must NOT have already
    // cleared recordingTimedOut or overwritten traceFile, or that ~10 min of data
    // becomes unrecoverable (stop would throw "No active session").
    const api = await buildAndroidSession();
    api.recordingTimedOut = true; // prior capped capture awaiting recovery
    api.traceFile = "/prior/partial.pftrace";
    api.appProcess = "com.prior.app";
    api.capturePid = 9999;
    api.androidOnDeviceTracePath = "/data/misc/perfetto-traces/prior.pftrace";

    detectAndroidRunningApp.mockResolvedValueOnce("com.new.app");
    startPerfetto.mockRejectedValueOnce(new Error("adb: device offline"));

    await expect(startNativeProfilerAndroid(api, { device_id: "emulator-5554" })).rejects.toThrow(
      /device offline/
    );

    // Recovery state for the prior capture must survive the failed start.
    expect(api.recordingTimedOut).toBe(true);
    expect(api.traceFile).toBe("/prior/partial.pftrace");
    expect(api.androidOnDeviceTracePath).toBe("/data/misc/perfetto-traces/prior.pftrace");
    expect(api.capturePid).toBe(9999);
    expect(api.profilingActive).toBe(false);
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });
});
