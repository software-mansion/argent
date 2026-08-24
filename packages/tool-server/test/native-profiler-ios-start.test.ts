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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import * as os from "node:os";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";

class FakeXctrace extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
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

describe("startNativeProfilerIos", () => {
  it("clears the teardown breadcrumb its own success would make unconsumable", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    recordReapedSession("native-profiler", api.deviceId, "an earlier trace");

    const result = await startNativeProfilerIos(api, startParams);

    expect(result.status).toBe("recording");
    expect(takeReapedSession("native-profiler", api.deviceId)).toBeUndefined();
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
  });

  it("leaves another device's breadcrumb alone", async () => {
    const instance = await session();
    const api = instance.api as NativeProfilerSessionApi;
    recordReapedSession("native-profiler", "emulator-5554", "somebody else's trace");

    await startNativeProfilerIos(api, startParams);

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
