import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  iosInstrumentsSessionBlueprint,
  type IosProfilerSessionApi,
} from "../../src/blueprints/ios-profiler-session";

// Mock the trace exporter so tests don't shell out to xctrace or touch disk.
vi.mock("../../src/utils/ios-profiler/export", () => ({
  exportIosTraceData: vi.fn(),
}));

import { exportIosTraceData } from "../../src/utils/ios-profiler/export";
import { iosInstrumentsStopTool } from "../../src/tools/profiler/ios-profiler/ios-profiler-stop";
import { handleXctraceExit } from "../../src/tools/profiler/ios-profiler/ios-profiler-start";

const mockedExport = vi.mocked(exportIosTraceData);

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  respondsTo: Set<NodeJS.Signals> = new Set();
  respondAfterMs = 0;
  signalLog: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalLog.push(signal);
    if (this.respondsTo.has(signal) && this.exitCode === null && this.signalCode === null) {
      setTimeout(() => this.exitWith(signal), this.respondAfterMs);
    }
    return true;
  }

  exitWith(signal: NodeJS.Signals | null): void {
    this.signalCode = signal;
    this.exitCode = signal ? null : 0;
    this.emit("exit", this.exitCode, this.signalCode);
  }
}

const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess;

async function buildSession(): Promise<IosProfilerSessionApi> {
  const instance = await iosInstrumentsSessionBlueprint.factory({}, "DEVICE-UDID");
  return instance.api;
}

const FAKE_TRACE = "/tmp/argent-profiler-cwd/ios-profiler-20260101-000000.trace";
const FAKE_EXPORT_RESULT = {
  files: { cpu: "/tmp/cpu.xml", hangs: "/tmp/hangs.xml", leaks: "/tmp/leaks.xml" },
  diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
};

describe("handleXctraceExit", () => {
  it("sets recordingExitedUnexpectedly and lastExitInfo on a non-timeout exit", async () => {
    const api = await buildSession();
    const child = new FakeChild();
    api.profilingActive = true;
    api.xctracePid = 1234;
    api.xctraceProcess = asChild(child);
    api.traceFile = FAKE_TRACE;

    handleXctraceExit(api, 0, null);

    expect(api.profilingActive).toBe(false);
    expect(api.xctracePid).toBeNull();
    expect(api.xctraceProcess).toBeNull();
    expect(api.recordingExitedUnexpectedly).toBe(true);
    expect(api.recordingTimedOut).toBe(false);
    expect(api.lastExitInfo).toEqual({ code: 0, signal: null });
    expect(api.traceFile).toBe(FAKE_TRACE);
  });

  it("does not flip recordingExitedUnexpectedly when the timeout path already fired", async () => {
    const api = await buildSession();
    api.profilingActive = true;
    api.recordingTimedOut = true;

    handleXctraceExit(api, null, "SIGINT");

    expect(api.recordingExitedUnexpectedly).toBe(false);
    expect(api.recordingTimedOut).toBe(true);
    expect(api.lastExitInfo).toEqual({ code: null, signal: "SIGINT" });
  });

  it("is a no-op when profilingActive is already false", async () => {
    const api = await buildSession();
    api.profilingActive = false;

    handleXctraceExit(api, 0, null);

    expect(api.recordingExitedUnexpectedly).toBe(false);
    expect(api.lastExitInfo).toBeNull();
  });
});

describe("ios-profiler-stop recovery branch", () => {
  beforeEach(() => {
    mockedExport.mockReset();
    mockedExport.mockReturnValue(FAKE_EXPORT_RESULT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports the trace when recordingExitedUnexpectedly is set", async () => {
    const api = await buildSession();
    api.traceFile = FAKE_TRACE;
    api.recordingExitedUnexpectedly = true;
    api.lastExitInfo = { code: 0, signal: null };

    const result = await iosInstrumentsStopTool.execute(
      { session: api } as never,
      { device_id: "DEVICE-UDID" }
    );

    expect(mockedExport).toHaveBeenCalledWith(FAKE_TRACE);
    expect(result.traceFile).toBe(FAKE_TRACE);
    expect(result.exportedFiles).toEqual(FAKE_EXPORT_RESULT.files);
    expect(result.exportDiagnostics).toEqual(FAKE_EXPORT_RESULT.diagnostics);
    expect(result.warning).toBeDefined();
    expect(api.recordingExitedUnexpectedly).toBe(false);
    expect(api.lastExitInfo).toBeNull();
  });

  it("warning string includes code= and signal= from lastExitInfo", async () => {
    const api = await buildSession();
    api.traceFile = FAKE_TRACE;
    api.recordingExitedUnexpectedly = true;
    api.lastExitInfo = { code: 137, signal: "SIGKILL" };

    const result = await iosInstrumentsStopTool.execute(
      { session: api } as never,
      { device_id: "DEVICE-UDID" }
    );

    expect(result.warning).toContain("code=137");
    expect(result.warning).toContain("signal=SIGKILL");
  });

  it("preserves the original 10-min timeout warning (regression)", async () => {
    const api = await buildSession();
    api.traceFile = FAKE_TRACE;
    api.recordingTimedOut = true;
    api.recordingExitedUnexpectedly = false;

    const result = await iosInstrumentsStopTool.execute(
      { session: api } as never,
      { device_id: "DEVICE-UDID" }
    );

    expect(result.warning).toContain("Recording timed out at 10 min cap");
    expect(result.warning).not.toContain("xctrace exited before stop");
    expect(api.recordingTimedOut).toBe(false);
  });

  it("falls through to the unrecoverable error when no recovery flag is set", async () => {
    const api = await buildSession();
    api.traceFile = FAKE_TRACE; // a stale traceFile alone must not trigger recovery

    await expect(
      iosInstrumentsStopTool.execute({ session: api } as never, { device_id: "DEVICE-UDID" })
    ).rejects.toThrow("No active iOS profiling session found");
    expect(mockedExport).not.toHaveBeenCalled();
  });

  it("throws unrecoverable when start was never called", async () => {
    const api = await buildSession();

    await expect(
      iosInstrumentsStopTool.execute({ session: api } as never, { device_id: "DEVICE-UDID" })
    ).rejects.toThrow("No active iOS profiling session found. Call ios-profiler-start first.");
    expect(mockedExport).not.toHaveBeenCalled();
  });

  it("clears recordingExitedUnexpectedly and lastExitInfo on a clean happy-path stop", async () => {
    vi.useFakeTimers();
    const api = await buildSession();
    const child = new FakeChild();
    child.respondsTo = new Set<NodeJS.Signals>(["SIGINT"]);
    child.respondAfterMs = 10;
    // Simulate the production wiring: the start tool registers handleXctraceExit
    // as the 'exit' listener. When SIGINT lands during shutdownChild, the handler
    // fires and dirties recordingExitedUnexpectedly/lastExitInfo before stop
    // resumes. The happy-path reset must scrub both.
    child.on("exit", (code, signal) => handleXctraceExit(api, code, signal));

    api.profilingActive = true;
    api.xctracePid = 4321;
    api.xctraceProcess = asChild(child);
    api.traceFile = FAKE_TRACE;

    const promise = iosInstrumentsStopTool.execute(
      { session: api } as never,
      { device_id: "DEVICE-UDID" }
    );
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result.warning).toBeUndefined();
    expect(result.traceFile).toBe(FAKE_TRACE);
    expect(api.profilingActive).toBe(false);
    expect(api.xctraceProcess).toBeNull();
    expect(api.recordingExitedUnexpectedly).toBe(false);
    expect(api.lastExitInfo).toBeNull();
  });
});

describe("ios-profiler-start fresh-start reset", () => {
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

  it("resets stale recordingExitedUnexpectedly and lastExitInfo before establishing a new session", async () => {
    class StartFakeChild extends EventEmitter {
      pid = 9999;
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      kill = vi.fn();
    }

    const fakeChild = new StartFakeChild();

    vi.doMock("child_process", () => ({
      spawn: vi.fn(() => fakeChild),
      execSync: vi.fn(() => ""), // detectRunningApp is bypassed via app_process
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
      waitForXctraceReady: vi.fn(async () => ({ stderrBuffer: "" })),
    }));

    const { iosInstrumentsStartTool: startTool } = await import(
      "../../src/tools/profiler/ios-profiler/ios-profiler-start"
    );

    const api = await buildSession();
    // Pre-populate stale state from a prior aborted run.
    api.recordingExitedUnexpectedly = true;
    api.lastExitInfo = { code: 1, signal: null };
    api.recordingTimedOut = true;

    const result = await startTool.execute(
      { session: api } as never,
      { device_id: "DEVICE-UDID", app_process: "MyApp" }
    );

    expect(result.status).toBe("recording");
    expect(api.recordingExitedUnexpectedly).toBe(false);
    expect(api.lastExitInfo).toBeNull();
    expect(api.recordingTimedOut).toBe(false);
  });
});
