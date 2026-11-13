/**
 * native-profiler-stop watches xctrace for a hang after SIGINT (it sometimes
 * stops for good: idle, and writing nothing), ends a hung one early and says
 * so, on a Mac app and on an iOS simulator. xctrace, its progress probe and the
 * export are faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import type { DeviceInfo } from "@argent/registry";

vi.mock("../src/tools/profiler/native-profiler/platforms/xctrace", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/tools/profiler/native-profiler/platforms/xctrace")
  >()),
  xctraceProgressProbe: vi.fn(() => async () => "0:01.20|4096"),
}));
vi.mock("../src/utils/ios-profiler/export", () => ({
  exportIosTraceData: vi.fn(async () => ({
    files: { cpu: "/tmp/cpu.xml", hangs: "/tmp/hangs.xml", leaks: null },
    diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
  })),
}));

import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { stopNativeProfilerIos } from "../src/tools/profiler/native-profiler/platforms/ios";
import {
  commitXctraceRecording,
  xctraceProgressProbe,
} from "../src/tools/profiler/native-profiler/platforms/xctrace";
import { RECORDING_CAP_MS } from "../src/utils/profiler-shared/types";
import { exportIosTraceData } from "../src/utils/ios-profiler/export";
import { resolveDevice } from "../src/utils/device-info";

class FakeXctrace extends EventEmitter {
  pid = 7373;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  respondsTo = new Set<NodeJS.Signals>();
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.respondsTo.has(signal)) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit("exit", null, signal);
      });
    }
    return true;
  }
}

const TRACE = "/tmp/native-profiler-20260101-000000.trace";
const STALL_MS = 30_000;
const POLL_MS = 2_000;

/** A session that records with `child`, as a successful start leaves it. */
async function recording(deviceId: string, child: FakeXctrace): Promise<NativeProfilerSessionApi> {
  const device: DeviceInfo = resolveDevice(deviceId);
  const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
  api.profilingActive = true;
  api.captureProcess = child as unknown as ChildProcess;
  api.capturePid = child.pid;
  api.traceFile = TRACE;
  return api;
}

const MAC = "macos-app-com.example.stopstall";
const IOS = "6DBF83B4-0000-0000-0000-000000000000";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.mocked(xctraceProgressProbe).mockClear();
  vi.mocked(exportIosTraceData).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("native-profiler-stop and an xctrace that hangs after SIGINT", () => {
  it("on a Mac app, ends a hung xctrace early, still exports, and warns", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGTERM");
    const api = await recording(MAC, child);

    const pending = stopNativeProfilerIos(api);
    await vi.advanceTimersByTimeAsync(STALL_MS + 2 * POLL_MS);

    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(vi.mocked(xctraceProgressProbe)).toHaveBeenCalledWith(child, TRACE);
    const result = await pending;
    expect(result.warning).toMatch(/^xctrace hung while it ended the recording/);
    expect(result.warning).toContain("argent ended it with SIGTERM");
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledWith(TRACE, false);
    expect(result.exportedFiles.cpu).toBe("/tmp/cpu.xml");
    expect(api.profilingActive).toBe(false);
    expect(api.captureProcess).toBeNull();
  });

  it("on a Mac app, waits a fifth of a long recording, at most 2 min, before it ends a hung xctrace", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGTERM");
    const api = await recording(MAC, child);
    // A 10-minute recording: a healthy stop waits longer before it writes.
    api.wallClockStartMs = Date.now() - 600_000;

    const pending = stopNativeProfilerIos(api);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(child.signals).toEqual(["SIGINT"]);
    await vi.advanceTimersByTimeAsync(10_000 + 2 * POLL_MS);
    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect((await pending).warning).toContain("for 120 s it used no CPU");
  });

  it("on a Mac app, gives no warning when xctrace ends on SIGINT", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGINT");
    const api = await recording(MAC, child);

    const pending = stopNativeProfilerIos(api);
    await vi.advanceTimersByTimeAsync(0);

    const result = await pending;
    expect(child.signals).toEqual(["SIGINT"]);
    expect(result.warning).toBeUndefined();
  });

  it("on an iOS simulator, ends a hung xctrace early too, still exports, and warns", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGTERM");
    const api = await recording(IOS, child);

    const pending = stopNativeProfilerIos(api);
    await vi.advanceTimersByTimeAsync(STALL_MS + 2 * POLL_MS);

    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(vi.mocked(xctraceProgressProbe)).toHaveBeenCalledWith(child, TRACE);
    const result = await pending;
    expect(result.warning).toMatch(/^xctrace hung while it ended the recording/);
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledWith(TRACE, false);
    expect(api.captureProcess).toBeNull();
  });

  it("on an iOS simulator, waits the whole SIGINT window for an xctrace that makes progress", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGTERM");
    const api = await recording(IOS, child);
    let n = 0;
    vi.mocked(xctraceProgressProbe).mockImplementationOnce(() => async () => `0:0${n++}|4096`);

    const pending = stopNativeProfilerIos(api);
    await vi.advanceTimersByTimeAsync(STALL_MS + 10 * POLL_MS);
    expect(child.signals).toEqual(["SIGINT"]);

    // The 5-minute window, then the ordinary escalation.
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await pending;
    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(result.warning).toMatch(/^xctrace did not respond to SIGINT/);
  });
});

describe("the 10-minute recording cap and an xctrace that does not end", () => {
  async function capped(deviceId: string, child: FakeXctrace): Promise<NativeProfilerSessionApi> {
    const device: DeviceInfo = resolveDevice(deviceId);
    const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
    commitXctraceRecording(
      api,
      { child: child as unknown as ChildProcess, pid: child.pid },
      { appProcess: "ExampleExec", traceFile: TRACE, mallocStackLogging: false, cpuFilterPid: null }
    );
    await vi.advanceTimersByTimeAsync(RECORDING_CAP_MS);
    return api;
  }

  it("on a Mac app, kills it 2 min after the cap's SIGINT, as no stop waits for it", async () => {
    const child = new FakeXctrace();
    const api = await capped(MAC, child);
    expect(child.signals).toEqual(["SIGINT"]);
    expect(api.recordingTimedOut).toBe(true);
    expect(api.captureProcess).toBeNull();

    await vi.advanceTimersByTimeAsync(119_000);
    expect(child.signals).toEqual(["SIGINT"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("on a Mac app, leaves one alone that ended on the cap's SIGINT", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGINT");
    await capped(MAC, child);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("on an iOS simulator, only sends the cap's SIGINT, as before", async () => {
    const child = new FakeXctrace();
    await capped(IOS, child);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(child.signals).toEqual(["SIGINT"]);
  });
});
