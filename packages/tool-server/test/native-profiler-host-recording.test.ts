/**
 * One xctrace recording at a time on the host: macOS gives the kernel trace to
 * one recording, so native-profiler-start on iOS and on a Mac app refuses while
 * another `xctrace record` runs, on another device of this tool-server or in
 * another process. Driven at the module boundaries: the xctrace spawn, the
 * readiness wait, simctl, argent's record of Mac apps, and the host's process list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import * as os from "node:os";
import { getFailureSignal, type DeviceInfo } from "@argent/registry";

class FakeXctrace extends EventEmitter {
  static nextPid = 5000;
  pid = FakeXctrace.nextPid++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  /** Takes SIGINT and saves the trace until it is killed, as after the 10-minute cap. */
  savesOnSigint = false;
  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    if (signal === "SIGINT" && this.savesOnSigint) {
      this.stdout.emit("data", Buffer.from("Stopping recording...\n"));
      return true;
    }
    queueMicrotask(() => this.exitWith(signal));
    return true;
  });

  /** Exits as a real ChildProcess does: the handle's fields first, then the events. */
  exitWith(signal: NodeJS.Signals | null, code: number | null = signal ? null : 0): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = code;
    this.emit("exit", this.exitCode, this.signalCode);
    this.emit("close", this.exitCode, this.signalCode);
  }
}

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: vi.fn(() => new FakeXctrace()),
  // simctl fails, so an iOS start with app_process attaches by name.
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
}));
vi.mock("../src/utils/macos-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/macos-apps")>()),
  runningTrackedApp: vi.fn(async () => ({ pid: 7777 })),
  getTrackedMacosApp: vi.fn(() => undefined),
  readCodeSignature: vi.fn(async () => null),
  inBackgroundSession: vi.fn(async () => false),
  processStartedWithEnv: vi.fn(async () => false),
}));
vi.mock("../src/utils/ios-profiler/xctrace-processes", () => ({
  runningXctraceRecordings: vi.fn(async () => []),
}));
// A stop that saves the trace makes progress at each poll.
vi.mock("../src/utils/ios-profiler/xctrace-progress", () => ({
  xctraceProgressProbe: vi.fn(() => {
    let n = 0;
    return async () => `0:0${n++}|4096`;
  }),
}));
vi.mock("../src/utils/ios-profiler/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-profiler/export")>()),
  exportIosTraceData: vi.fn(async () => ({
    files: { cpu: "/tmp/cpu.xml", hangs: "/tmp/hangs.xml", leaks: null },
    diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
  })),
}));

import { spawn } from "child_process";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import type { MacosAppApi } from "../src/blueprints/macos-app";
import {
  startNativeProfilerIos,
  stopNativeProfilerIos,
} from "../src/tools/profiler/native-profiler/platforms/ios";
import { exportIosTraceData } from "../src/utils/ios-profiler/export";
import { startNativeProfilerMacos } from "../src/tools/profiler/native-profiler/platforms/macos";
import { runningXctraceRecordings } from "../src/utils/ios-profiler/xctrace-processes";
import { RECORDING_CAP_MS } from "../src/utils/profiler-shared/types";

const IOS_A = "6DBF83B4-0000-0000-0000-00000000000A";
const IOS_B = "6DBF83B4-0000-0000-0000-00000000000B";
const MAC = "macos-app-com.example.hostrecording";
const ARM_SETTLE_MS = 1_500;

const spawnMock = vi.mocked(spawn);
const processesMock = vi.mocked(runningXctraceRecordings);
const macosApp = {
  bundleId: "com.example.hostrecording",
  watchSuspensions: vi.fn(async () => null),
} as unknown as MacosAppApi;

let sessions: NativeProfilerSessionApi[] = [];

async function session(id: string): Promise<NativeProfilerSessionApi> {
  const device = { id, platform: id === MAC ? "macos" : "ios" } as DeviceInfo;
  const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device } as never);
  sessions.push(api);
  return api;
}

function start(api: NativeProfilerSessionApi): Promise<unknown> {
  const pending =
    api.platform === "macos"
      ? startNativeProfilerMacos(api, macosApp, { device_id: api.deviceId, template_path: "x" })
      : startNativeProfilerIos(api, {
          device_id: api.deviceId,
          app_process: "Probe",
          template_path: "x",
        });
  pending.catch(() => {});
  return pending;
}

/** Runs a start past the wait after the recording starts; resolves to its error or result. */
async function settled(pending: Promise<unknown>): Promise<unknown> {
  await vi.advanceTimersByTimeAsync(ARM_SETTLE_MS);
  return pending.catch((err: unknown) => err);
}

function xctraceOf(api: NativeProfilerSessionApi): FakeXctrace {
  return api.captureProcess as unknown as FakeXctrace;
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockClear();
  processesMock.mockReset();
  processesMock.mockResolvedValue([]);
});

afterEach(() => {
  // End every recording, so that none counts in the next test.
  for (const api of sessions) {
    if (api.recordingTimeout) clearTimeout(api.recordingTimeout);
    xctraceOf(api)?.exitWith("SIGKILL");
  }
  sessions = [];
  vi.useRealTimers();
});

describe("native-profiler-start while another xctrace recording runs", () => {
  it("refuses a second device of this tool-server, and records it once the first ends", async () => {
    const a = await session(IOS_A);
    const b = await session(MAC);
    expect(await settled(start(a))).toMatchObject({ status: "recording" });
    const first = xctraceOf(a);

    const err = await settled(start(b));

    expect(getFailureSignal(err)?.error_code).toBe("NATIVE_PROFILER_HOST_RECORDING_RUNNING");
    expect((err as Error).message).toBe(
      `argent cannot record ${MAC} now: xctrace (pid ${first.pid}) of this tool-server records ` +
        `${IOS_A}, started 2 s ago. macOS lets one recording at a time use the kernel trace that ` +
        `Instruments records CPU samples with: a second recording fails to start, and the first ` +
        `one records no CPU samples from then on. If that recording is yours, stop it with ` +
        `native-profiler-stop. Otherwise wait until it ends, or ask the user. Then call ` +
        `native-profiler-start again.`
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(b.profilingActive).toBe(false);

    // xctrace of the first recording ends, as after its stop.
    first.exitWith("SIGINT");
    expect(await settled(start(b))).toMatchObject({ status: "recording" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("refuses the later of two starts that run at the same time", async () => {
    const a = await session(IOS_A);
    const b = await session(IOS_B);

    const [ra, rb] = await Promise.all([settled(start(a)), settled(start(b))]);

    const codes = [ra, rb].map((r) => getFailureSignal(r)?.error_code ?? "recording");
    expect(codes.sort()).toEqual(["NATIVE_PROFILER_HOST_RECORDING_RUNNING", "recording"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a start of the same device while its xctrace saves the trace after the cap, and points to the stop that returns it", async () => {
    const a = await session(IOS_A);
    expect(await settled(start(a))).toMatchObject({ status: "recording" });
    const capped = xctraceOf(a);
    const cappedTrace = a.traceFile;
    capped.savesOnSigint = true;
    await vi.advanceTimersByTimeAsync(RECORDING_CAP_MS);
    expect(a.recordingTimedOut).toBe(true);
    expect(capped.kill).toHaveBeenCalledWith("SIGINT");

    const err = await settled(start(a));

    expect(getFailureSignal(err)?.error_code).toBe("NATIVE_PROFILER_HOST_RECORDING_RUNNING");
    expect((err as Error).message).toMatch(
      new RegExp(
        `^argent cannot record ${IOS_A} now: xctrace \\(pid ${capped.pid}\\) of this ` +
          `tool-server saves a recording of this device, started \\d+ s ago\\. `
      )
    );
    // A start after the save would take the session, and no stop would export the
    // capped recording.
    expect((err as Error).message).toMatch(
      /If that recording is yours, native-profiler-stop returns it once xctrace has saved it\. Otherwise wait until xctrace has saved it, then call native-profiler-start again\.$/
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // The stop that the error points to waits for the save, then exports the trace.
    vi.mocked(exportIosTraceData).mockClear();
    const stop = stopNativeProfilerIos(a);
    await vi.advanceTimersByTimeAsync(10_000);
    capped.exitWith(null, 0);
    const result = await stop;
    expect(result.traceFile).toBe(cappedTrace);
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledWith(cappedTrace, false);
  });

  it("names the device of the first of two starts at once, also when ps lists its xctrace", async () => {
    // As the real ps: it lists the xctrace processes that run 50 ms after the call.
    processesMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                sessions
                  .map(xctraceOf)
                  .filter((x) => x && x.exitCode === null && x.signalCode === null)
                  .map((x) => ({ pid: x.pid, elapsed: "00:00", command: "xctrace record" }))
              ),
            50
          )
        )
    );
    const a = await session(IOS_A);
    const b = await session(IOS_B);

    const ra = start(a);
    await vi.advanceTimersByTimeAsync(10);
    const [resultA, err] = await Promise.all([settled(ra), settled(start(b))]);

    expect(resultA).toMatchObject({ status: "recording" });
    expect(getFailureSignal(err)?.error_code).toBe("NATIVE_PROFILER_HOST_RECORDING_RUNNING");
    expect((err as Error).message).toContain(`this tool-server starts a recording of ${IOS_A}`);
    expect((err as Error).message).not.toContain("another xctrace recording");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a malloc_stack_logging start before it restarts the app, while another start runs", async () => {
    const launch = vi.fn(async () => {
      // A restart takes a moment: quit, then start again.
      await new Promise((r) => setTimeout(r, 300));
      return { pid: 8888 };
    });
    const mallocApp = { ...macosApp, launch } as unknown as MacosAppApi;
    // ps takes 50 ms, so that A is still in its first check when B starts.
    processesMock.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50, [])));
    const a = await session(IOS_A);
    const b = await session(MAC);

    const ra = start(a);
    await vi.advanceTimersByTimeAsync(10);
    const rb = startNativeProfilerMacos(b, mallocApp, {
      device_id: MAC,
      template_path: "x",
      malloc_stack_logging: true,
    });
    // It is refused while A still starts, before `settled` attaches its handler.
    rb.catch(() => {});
    const [resultA, err] = await Promise.all([settled(ra), settled(rb)]);

    expect(resultA).toMatchObject({ status: "recording" });
    expect(getFailureSignal(err)?.error_code).toBe("NATIVE_PROFILER_HOST_RECORDING_RUNNING");
    expect(launch).not.toHaveBeenCalled();
  });

  it("checks the host's processes again right before it starts xctrace", async () => {
    // Another tool-server starts xctrace while this start reads the app list.
    processesMock
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { pid: 4321, elapsed: "00:02", command: "/usr/bin/xctrace record --all-processes" },
      ]);
    const a = await session(IOS_A);

    const err = await settled(start(a));

    expect(getFailureSignal(err)?.error_code).toBe("NATIVE_PROFILER_HOST_RECORDING_RUNNING");
    expect((err as Error).message).toContain(
      "another xctrace recording runs on this Mac (pid 4321"
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses while another process records with xctrace, and starts no xctrace", async () => {
    processesMock.mockResolvedValue([
      {
        pid: 4321,
        elapsed: "01:05",
        command:
          "/Applications/Xcode.app/Contents/Developer/usr/bin/xctrace record --template Time Profiler --all-processes",
      },
    ]);
    const a = await session(IOS_A);

    const err = await settled(start(a));

    expect(getFailureSignal(err)?.error_code).toBe("NATIVE_PROFILER_HOST_RECORDING_RUNNING");
    expect((err as Error).message).toContain(
      `argent cannot record ${IOS_A} now: another xctrace recording runs on this Mac (pid 4321, ` +
        `for 01:05: /Applications/Xcode.app/Contents/Developer/usr/bin/xctrace record`
    );
    expect((err as Error).message).toMatch(/Wait until it ends, or ask the user\. Then call/);
    expect((err as Error).message).not.toContain("end it");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
