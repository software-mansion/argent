/**
 * The Android stop saves when the recording ended, so that profiler-load pairs
 * the session with the React session of the same run. When perfetto had ended
 * before the stop (the app crashed, the traced daemon restarted), the stop saved
 * its own time: a React session that started after the trace ended then paired
 * with it. The end of such a trace is not known, so the stop saves none.
 * The real stopPerfetto runs against a fake adb.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

vi.mock("../../src/utils/adb", async () => ({
  ...(await vi.importActual<typeof import("../../src/utils/adb")>("../../src/utils/adb")),
  runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
  adbShell: vi.fn(async () => ""),
}));
vi.mock("../../src/utils/android-profiler/session-metadata", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeAndroidNativeProfilerMetadata: vi.fn(async () => {}),
}));

import { adbShell } from "../../src/utils/adb";
import { writeAndroidNativeProfilerMetadata } from "../../src/utils/android-profiler/session-metadata";
import { stopNativeProfilerAndroid } from "../../src/tools/profiler/native-profiler/platforms/android";

const mockedShell = vi.mocked(adbShell);
const mockedWrite = vi.mocked(writeAndroidNativeProfilerMetadata);
const HOST_TRACE = "/tmp/native-profiler-20261113-135245.pftrace";

async function activeSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "emulator-5554", platform: "android" as const, kind: "emulator" as const };
  const api = (await nativeProfilerSessionBlueprint.factory({}, device, { device })).api;
  api.profilingActive = true;
  api.capturePid = 12345;
  api.captureProcess = { kill: () => true } as never;
  api.androidOnDeviceTracePath = "/data/misc/perfetto-traces/argent-x.pftrace";
  api.traceFile = HOST_TRACE;
  api.appProcess = "com.example.app";
  api.wallClockStartMs = Date.now() - 60_000;
  return api;
}

/** A fake perfetto: each `/proc/<pid>` probe answers the next state, then "gone". */
function perfettoProbes(...states: ("alive" | "gone")[]): void {
  mockedShell.mockImplementation(async (_serial, command) =>
    command.includes("/proc/") ? `${states.shift() ?? "gone"}\n` : ""
  );
}

describe("the end of an Android recording that the stop saves", () => {
  beforeEach(() => {
    mockedShell.mockReset();
    mockedWrite.mockClear();
  });

  it("is none when perfetto ended before the stop", async () => {
    perfettoProbes("gone");
    const result = await stopNativeProfilerAndroid(await activeSession());

    expect(result.warning).toMatch(/perfetto exited before stop was called/);
    expect(mockedWrite).toHaveBeenCalledWith(
      HOST_TRACE,
      expect.objectContaining({ stoppedAtMs: null })
    );
  });

  it("is the stop when perfetto recorded until the stop", async () => {
    perfettoProbes("alive", "gone");
    const before = Date.now();
    await stopNativeProfilerAndroid(await activeSession());
    const after = Date.now();

    const saved = mockedWrite.mock.calls[0]![1].stoppedAtMs;
    expect(saved).toBeGreaterThanOrEqual(before);
    expect(saved).toBeLessThanOrEqual(after);
  });
});
