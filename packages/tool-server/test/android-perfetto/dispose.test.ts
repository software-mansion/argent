import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

vi.mock("../../src/utils/adb", () => ({
  adbShell: vi.fn(async () => ""),
}));

import { adbShell } from "../../src/utils/adb";

const mockedAdbShell = vi.mocked(adbShell);

async function buildAndroidSession(): Promise<{
  api: NativeProfilerSessionApi;
  dispose: () => Promise<void>;
}> {
  const device = { id: "emulator-5554", platform: "android" as const, kind: "emulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return { api: instance.api, dispose: instance.dispose };
}

function primeActiveSession(api: NativeProfilerSessionApi): void {
  api.profilingActive = true;
  api.capturePid = 12345;
  api.captureProcess = { kill: vi.fn() } as never;
  api.androidOnDeviceTracePath = "/data/misc/perfetto-traces/argent-x.pftrace";
  api.recordingTimedOut = true;
  api.recordingExitedUnexpectedly = true;
  api.lastExitInfo = { code: 1, signal: null };
}

describe("nativeProfilerSessionBlueprint Android dispose", () => {
  beforeEach(() => {
    mockedAdbShell.mockReset();
    mockedAdbShell.mockResolvedValue("");
  });

  it("kills the on-device perfetto daemon and clears live state", async () => {
    const { api, dispose } = await buildAndroidSession();
    primeActiveSession(api);

    await dispose();

    expect(mockedAdbShell).toHaveBeenCalledWith("emulator-5554", "kill -KILL 12345", {
      timeoutMs: 5_000,
    });
    expect(mockedAdbShell).toHaveBeenCalledWith(
      "emulator-5554",
      "rm -f /data/misc/perfetto-traces/argent-x.pftrace",
      { timeoutMs: 5_000 }
    );
    expect(api.profilingActive).toBe(false);
    expect(api.capturePid).toBeNull();
    expect(api.captureProcess).toBeNull();
    expect(api.androidOnDeviceTracePath).toBeNull();
    expect(api.recordingTimedOut).toBe(false);
    expect(api.recordingExitedUnexpectedly).toBe(false);
    expect(api.lastExitInfo).toBeNull();
  });

  it("still clears live state when adb cleanup fails", async () => {
    const { api, dispose } = await buildAndroidSession();
    primeActiveSession(api);
    mockedAdbShell.mockRejectedValue(new Error("device offline"));

    await expect(dispose()).resolves.toBeUndefined();

    expect(mockedAdbShell).toHaveBeenCalledWith("emulator-5554", "kill -KILL 12345", {
      timeoutMs: 5_000,
    });
    expect(api.profilingActive).toBe(false);
    expect(api.capturePid).toBeNull();
    expect(api.captureProcess).toBeNull();
    expect(api.androidOnDeviceTracePath).toBeNull();
    expect(api.recordingTimedOut).toBe(false);
    expect(api.recordingExitedUnexpectedly).toBe(false);
    expect(api.lastExitInfo).toBeNull();
  });
});
