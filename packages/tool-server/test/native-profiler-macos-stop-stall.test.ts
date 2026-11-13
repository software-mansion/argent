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

vi.mock("../src/utils/ios-profiler/xctrace-progress", () => ({
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
import { commitXctraceRecording } from "../src/tools/profiler/native-profiler/platforms/xctrace";
import { xctraceProgressProbe } from "../src/utils/ios-profiler/xctrace-progress";
import { RECORDING_CAP_MS } from "../src/utils/profiler-shared/types";
import { exportIosTraceData } from "../src/utils/ios-profiler/export";
import { resolveDevice } from "../src/utils/device-info";

class FakeXctrace extends EventEmitter {
  pid = 7373;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  respondsTo = new Set<NodeJS.Signals>();
  /** How long it takes to end after a signal it responds to: saving the trace. */
  exitAfterMs = 0;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.respondsTo.has(signal)) {
      const exit = () => {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.signalCode = signal;
        this.emit("exit", null, signal);
      };
      if (this.exitAfterMs > 0 && signal !== "SIGKILL") setTimeout(exit, this.exitAfterMs);
      else queueMicrotask(exit);
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

describe("the 10-minute recording cap", () => {
  /** A recording of `child` whose 10-minute cap has fired. */
  async function capped(deviceId: string, child: FakeXctrace) {
    const device: DeviceInfo = resolveDevice(deviceId);
    const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
    // As spawnXctraceRecording leaves it.
    instance.api.captureProcess = child as unknown as ChildProcess;
    instance.api.capturePid = child.pid;
    commitXctraceRecording(
      instance.api,
      { child: child as unknown as ChildProcess, pid: child.pid },
      { appProcess: "ExampleExec", traceFile: TRACE, mallocStackLogging: false, cpuFilterPid: null }
    );
    await vi.advanceTimersByTimeAsync(RECORDING_CAP_MS);
    expect(child.signals).toEqual(["SIGINT"]);
    expect(instance.api.recordingTimedOut).toBe(true);
    expect(instance.api.profilingActive).toBe(false);
    return instance;
  }

  for (const [platform, deviceId] of [
    ["an iOS simulator", IOS],
    ["a Mac app", MAC],
  ] as const) {
    it(`on ${platform}, ends a hung xctrace as a stop does, with no stop`, async () => {
      const child = new FakeXctrace();
      await capped(deviceId, child);

      // The stall watch of a 10-minute recording: 2 min of no progress.
      await vi.advanceTimersByTimeAsync(118_000);
      expect(child.signals).toEqual(["SIGINT"]);
      await vi.advanceTimersByTimeAsync(2 * POLL_MS);
      expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    });
  }

  it("leaves one alone that ends on the cap's SIGINT", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGINT");
    const { api } = await capped(IOS, child);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(child.signals).toEqual(["SIGINT"]);
    expect(api.captureProcess).toBeNull();
  });

  it("makes the stop after the cap wait until xctrace has saved the trace, then export it", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGINT");
    // Saving a 10-minute trace takes a while; the progress changes meanwhile.
    child.exitAfterMs = 45_000;
    let n = 0;
    vi.mocked(xctraceProgressProbe).mockImplementationOnce(() => async () => `0:0${n++}|4096`);
    const { api } = await capped(IOS, child);

    const pending = stopNativeProfilerIos(api);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(vi.mocked(exportIosTraceData)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000 + POLL_MS);
    const result = await pending;
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledWith(TRACE, false);
    expect(child.signals).toEqual(["SIGINT"]);
    expect(result.warning).toMatch(/^Recording timed out at 10 min cap/);
    expect(result.warning).not.toContain("xctrace hung");
    expect(api.recordingTimedOut).toBe(false);
    expect(api.cappedEnd).toBeNull();
  });

  it("says in the stop after the cap that xctrace hung and was ended", async () => {
    const child = new FakeXctrace();
    child.respondsTo.add("SIGTERM");
    const { api } = await capped(IOS, child);

    const pending = stopNativeProfilerIos(api);
    await vi.advanceTimersByTimeAsync(120_000 + 2 * POLL_MS);
    const result = await pending;
    expect(child.signals).toEqual(["SIGINT", "SIGTERM"]);
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
    expect(result.warning).toMatch(
      /^Recording timed out at 10 min cap; xctrace hung while it ended/
    );
    // Each once: what is left of the data, and what to do.
    expect(result.warning).not.toContain("partial trace");
    expect(result.warning?.match(/Call native-profiler-start/g)).toHaveLength(1);
  });

  it("lets a teardown kill an xctrace that has not ended, and says its bundle is not saved", async () => {
    const child = new FakeXctrace();
    const instance = await capped(IOS, child);
    expect(instance.api.captureProcess).toBe(child);

    await instance.dispose();
    expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);

    const fresh = await nativeProfilerSessionBlueprint.factory({}, resolveDevice(IOS), {
      device: resolveDevice(IOS),
    } as never);
    const err = await stopNativeProfilerIos(fresh.api).catch((e: unknown) => e);
    expect((err as Error).message).toContain("without its finalize pass");
  });

  it("does not let the capped xctrace's exit end a newer recording", async () => {
    const old = new FakeXctrace();
    old.respondsTo.add("SIGINT");
    old.exitAfterMs = 30_000;
    const { api } = await capped(IOS, old);

    const next = new FakeXctrace();
    next.pid = 7474;
    api.captureProcess = next as unknown as ChildProcess;
    commitXctraceRecording(
      api,
      { child: next as unknown as ChildProcess, pid: next.pid },
      { appProcess: "ExampleExec", traceFile: TRACE, mallocStackLogging: false, cpuFilterPid: null }
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(old.signalCode).toBe("SIGINT");
    expect(api.profilingActive).toBe(true);
    expect(api.captureProcess).toBe(next);
    expect(api.recordingExitedUnexpectedly).toBe(false);
  });
});
