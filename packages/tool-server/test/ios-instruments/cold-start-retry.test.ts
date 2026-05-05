import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

// xctrace's verbatim cold-launch race signature, asserted on as a stable
// upstream contract by the retry detector in native-profiler-start.
const COLD_START_ERROR =
  "xctrace record exited before recording started (code=19, signal=null). " +
  "stderr: Cannot find process matching name: MyApp";

class StartFakeChild extends EventEmitter {
  pid = 9999;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn();
}

async function buildSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "DEVICE-UDID", platform: "ios" as const, kind: "simulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

describe("native-profiler-start cold-start retry", () => {
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

  it("retries once when xctrace fails with the cold-start signature, then resolves", async () => {
    const spawnFn = vi.fn(() => new StartFakeChild());
    const waitForReady = vi
      .fn()
      .mockRejectedValueOnce(new Error(COLD_START_ERROR))
      .mockResolvedValueOnce({ stderrBuffer: "" });

    vi.doMock("child_process", () => ({
      spawn: spawnFn,
      execSync: vi.fn(() => ""),
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
      waitForXctraceReady: waitForReady,
    }));

    const { nativeProfilerStartTool: startTool } =
      await import("../../src/tools/profiler/native-profiler/native-profiler-start");

    const api = await buildSession();
    const promise = startTool.execute({ session: api } as never, {
      device_id: "DEVICE-UDID",
      app_process: "MyApp",
    });

    // Drain the retry sleep (1.2s) so the second attempt can run.
    await vi.advanceTimersByTimeAsync(1_200);

    const result = await promise;
    expect(result.status).toBe("recording");
    expect(result.pid).toBe(9999);
    expect(waitForReady).toHaveBeenCalledTimes(2);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(api.profilingActive).toBe(true);
    expect(api.appProcess).toBe("MyApp");
  });

  it("throws a classified cold-start error after exhausting attempts", async () => {
    const spawnFn = vi.fn(() => new StartFakeChild());
    const waitForReady = vi.fn().mockRejectedValue(new Error(COLD_START_ERROR));

    vi.doMock("child_process", () => ({
      spawn: spawnFn,
      execSync: vi.fn(() => ""),
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
      waitForXctraceReady: waitForReady,
    }));

    const { nativeProfilerStartTool: startTool } =
      await import("../../src/tools/profiler/native-profiler/native-profiler-start");

    const api = await buildSession();
    const promise = startTool
      .execute({ session: api } as never, { device_id: "DEVICE-UDID", app_process: "MyApp" })
      .catch((e) => e);

    await vi.advanceTimersByTimeAsync(1_200);

    const err = (await promise) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('xctrace could not find process "MyApp" after 2 attempts');
    expect(err.message).toContain("cold-launching");
    expect(err.message).toContain("pass app_process explicitly");
    expect(waitForReady).toHaveBeenCalledTimes(2);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(api.profilingActive).toBe(false);
    expect(api.xctracePid).toBeNull();
    expect(api.xctraceProcess).toBeNull();
  });

  it("does not retry when xctrace fails with an unrelated error", async () => {
    const spawnFn = vi.fn(() => new StartFakeChild());
    const otherError = new Error(
      "xctrace record exited before recording started (code=1, signal=null). " +
        "stderr: Recording failed: device not found"
    );
    const waitForReady = vi.fn().mockRejectedValue(otherError);

    vi.doMock("child_process", () => ({
      spawn: spawnFn,
      execSync: vi.fn(() => ""),
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
      waitForXctraceReady: waitForReady,
    }));

    const { nativeProfilerStartTool: startTool } =
      await import("../../src/tools/profiler/native-profiler/native-profiler-start");

    const api = await buildSession();
    await expect(
      startTool.execute({ session: api } as never, {
        device_id: "DEVICE-UDID",
        app_process: "MyApp",
      })
    ).rejects.toThrow("device not found");

    expect(waitForReady).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(api.profilingActive).toBe(false);
  });
});
