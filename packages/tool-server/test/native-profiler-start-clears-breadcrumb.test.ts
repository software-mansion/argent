/**
 * A teardown breadcrumb explains ONE confusing answer: the "no active session"
 * a reaped capture's own stop would otherwise get. A start that succeeds after
 * the teardown means that stop will succeed instead, so the breadcrumb is never
 * consumed by the read it was left for — and would sit in the process-global
 * map until some genuinely unrelated "no active session", possibly much later,
 * collected it and blamed a teardown that had nothing to do with it.
 *
 * Both platform starts clear it for that reason. Only the stop-side consume was
 * covered; this drives the real `startNativeProfilerAndroid` (perfetto, adb and
 * the debug dir stubbed at their module boundaries) so the clear is exercised
 * where it actually lives rather than called directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import type { DeviceInfo } from "@argent/registry";
import * as os from "node:os";

vi.mock("../src/utils/adb", () => ({ adbShell: vi.fn(async () => "") }));
vi.mock("@argent/native-devtools-android", () => ({
  disposeWarmEngine: vi.fn(async () => {}),
  TraceProcessorUnavailableError: class extends Error {},
}));
vi.mock("../src/utils/android-profiler/detect-app", () => ({
  detectAndroidRunningApp: vi.fn(async () => "com.example.app"),
  validateAndroidAppProcess: vi.fn(async () => {}),
}));
vi.mock("../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(async () => os.tmpdir()),
}));
vi.mock("../src/utils/android-profiler/capture", () => ({
  startPerfetto: vi.fn(async () => ({
    pid: 4242,
    onDeviceTracePath: "/data/misc/perfetto-traces/fake.pftrace",
    child: new EventEmitter() as unknown as ChildProcess,
  })),
  stopPerfetto: vi.fn(async () => {}),
}));

import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import {
  startNativeProfilerAndroid,
  stopNativeProfilerAndroid,
} from "../src/tools/profiler/native-profiler/platforms/android";
import {
  recordReapedSession,
  takeReapedSession,
  __resetReapedSessionsForTesting,
} from "../src/utils/reaped-sessions";

const androidDevice = { id: "emulator-5554", platform: "android" } as DeviceInfo;

async function session(): Promise<NativeProfilerSessionApi> {
  const instance = await nativeProfilerSessionBlueprint.factory({}, androidDevice, {
    device: androidDevice,
  } as never);
  return instance.api as NativeProfilerSessionApi;
}

beforeEach(() => {
  __resetReapedSessionsForTesting();
});

describe("native-profiler-start after a teardown", () => {
  it("clears the breadcrumb, so a later unrelated absence is not blamed on it", async () => {
    recordReapedSession("native-profiler", androidDevice.id, "salvage note");

    const api = await session();
    await startNativeProfilerAndroid(api, { device_id: androidDevice.id });
    expect(api.profilingActive).toBe(true);

    // Nothing is left for a later read to pick up…
    expect(takeReapedSession("native-profiler", androidDevice.id)).toBeUndefined();

    // …so a genuine "no active session" much later stays a plain absence.
    const fresh = await session();
    const err = await stopNativeProfilerAndroid(fresh).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "No active native profiling session found. Call native-profiler-start first."
    );
  });

  it("leaves another device's breadcrumb alone", async () => {
    // The clear is scoped to the device the start ran on. Clearing broadly
    // would silently disarm the explanation another agent's reaped capture is
    // still owed.
    recordReapedSession("native-profiler", "emulator-5556", "other device");

    await startNativeProfilerAndroid(await session(), { device_id: androidDevice.id });

    expect(takeReapedSession("native-profiler", "emulator-5556")).toBeDefined();
  });
});
