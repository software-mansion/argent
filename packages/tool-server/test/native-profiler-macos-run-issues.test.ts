/**
 * native-profiler-stop on a Mac app reports the errors that xctrace prints when
 * the recording ends ("Run issues were detected"). When xctrace could not attach
 * to the app, the trace holds no data, and the stop exports nothing: each export
 * of such a trace waits out its timeout. A stub `xctrace` first on PATH prints
 * what Xcode 26.6 printed for a failed attach; the table export is faked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo } from "@argent/registry";

// No notifyutil off macOS (CI runs on Linux): the start waits for the stub's
// "Ctrl-C to stop" line instead, as it does when notifyutil is missing.
vi.mock("../src/utils/ios-profiler/notify", () => ({
  listenForDarwinNotification: vi.fn(() => {
    throw new Error("notifyutil unavailable in this test");
  }),
}));

vi.mock("../src/utils/ios-profiler/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-profiler/export")>()),
  exportIosTraceData: vi.fn(async () => ({
    files: { cpu: "/tmp/cpu.xml", hangs: "/tmp/hangs.xml", leaks: "/tmp/leaks.xml" },
    diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
  })),
}));

import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { spawn, type ChildProcess } from "node:child_process";
import {
  analyzeNativeProfilerIos,
  stopNativeProfilerIos,
} from "../src/tools/profiler/native-profiler/platforms/ios";
import {
  commitXctraceRecording,
  spawnXctraceRecording,
} from "../src/tools/profiler/native-profiler/platforms/xctrace";
import { exportIosTraceData } from "../src/utils/ios-profiler/export";
import { LEAKS_NOT_RECORDED } from "../src/utils/ios-profiler/render";
import { resolveDevice } from "../src/utils/device-info";
import { RECORDING_CAP_MS } from "../src/utils/profiler-shared/types";

const ATTACH_FAILED = [
  "* [Error] Failed to attach to target process",
  "",
  "\t* [Error] Failed to load library /Applications/Xcode-26.6.app/Contents/SharedFrameworks/DVTInstrumentsFoundation.framework/Resources/liboainject.dylib due to missing bootstrapping symbols",
  "",
  "\t\t* [Error] Unable to find symbol named '_pthread_self' in owner: libsystem_pthread.dylib.",
].join("\n");

// What Xcode 27.2 printed at the stop of an iOS 27.0 simulator recording whose
// leak checks failed. Its Leaks export had no row.
const LEAK_AGENT_FAILED = [
  "* [Warning] This configuration of instruments creates 1 table without a known input source.",
  "",
  "\t* [Warning] Recovery Suggestion: This could be due to a missing package, or an error in a package under development.",
  "",
  "* [Error] An error occurred trying to capture Leaks data.",
  "",
  "\t* [Error] Failed to handshake with LeakAgent (pid: 46018)",
].join("\n");
const LEAK_AGENT_ERRORS =
  "An error occurred trying to capture Leaks data. Failed to handshake with LeakAgent (pid: 46018)";

let dir: string;
let originalPath: string | undefined;

/** What the stub prints after "Stopping recording...", read from a file per test. */
function runIssues(lines: string | null): void {
  const file = path.join(dir, "issues.txt");
  if (lines === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, lines + "\n");
}

/**
 * A process the stub kills when it gets SIGINT, before it ends: an app that
 * quits while xctrace saves the trace.
 */
function quitOnStop(pid: number | null): void {
  const file = path.join(dir, "quit-on-stop.txt");
  if (pid === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, `${pid}\n`);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-xctrace-run-issues-"));
  fs.writeFileSync(
    path.join(dir, "xctrace"),
    `#!/bin/bash
issues="${dir}/issues.txt"
quit="${dir}/quit-on-stop.txt"
stop() {
  if [ -f "$quit" ]; then
    pid=$(cat "$quit")
    kill -9 "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.01; done
  fi
  echo "Stopping recording..."
  if [ -f "$issues" ]; then
    echo "Run issues were detected (trace is still ready to be viewed):"
    cat "$issues"
    echo "Recording failed with errors. Saving output file..."
    exit 2
  fi
  echo "Recording completed. Saving output file..."
  exit 0
}
trap stop INT
echo "Starting recording with the Argent template. Attaching to: PM-sdbg (4321). "
echo "Ctrl-C to stop the recording"
while true; do sleep 0.05; done
`,
    { mode: 0o755 }
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(exportIosTraceData).mockClear();
  quitOnStop(null);
});

const MAC = "macos-app-com.example.runissues";
const IOS = "6DBF83B4-0000-0000-0000-000000000001";

/** Ends the stub from outside, as when xctrace ends without a stop. */
async function endXctrace(api: NativeProfilerSessionApi): Promise<void> {
  const child = api.captureProcess!;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGINT");
  await exited;
  expect(api.recordingExitedUnexpectedly).toBe(true);
}

async function quit(app: ChildProcess): Promise<void> {
  const gone = new Promise((resolve) => app.once("exit", resolve));
  app.kill("SIGKILL");
  await gone;
}

/**
 * A session recording with the stub, as a successful start leaves it: a new
 * session, or `session` for its next recording. `beforeCommit` runs between the
 * spawn and the commit that sets the 10-minute cap.
 */
async function recording(
  deviceId: string,
  beforeCommit?: () => void | Promise<void>,
  session?: NativeProfilerSessionApi
): Promise<NativeProfilerSessionApi> {
  const device: DeviceInfo = resolveDevice(deviceId);
  const api =
    session ?? (await nativeProfilerSessionBlueprint.factory({}, device, { device } as never)).api;
  const traceFile = path.join(dir, `native-profiler-${Date.now()}.trace`);
  fs.mkdirSync(traceFile, { recursive: true });
  const started = await spawnXctraceRecording(api, () => ["record", "--output", traceFile]);
  await beforeCommit?.();
  commitXctraceRecording(api, started, {
    appProcess: "PM-sdbg",
    traceFile,
    mallocStackLogging: false,
    customTemplate: false,
    cpuFilterPid: null,
    // Still running, so the app-ended note stays out of the warning.
    appPid: process.pid,
  });
  return api;
}

describe("native-profiler-stop and the run issues xctrace prints", () => {
  it("on a Mac app xctrace did not attach to, exports nothing and says what xctrace reported", async () => {
    runIssues(ATTACH_FAILED);
    const api = await recording(MAC);
    const result = await stopNativeProfilerIos(api);

    expect(vi.mocked(exportIosTraceData)).not.toHaveBeenCalled();
    expect(result.exportedFiles).toEqual({ cpu: null, hangs: null, leaks: null });
    for (const key of ["cpu", "hangs", "leaks"]) {
      expect(result.exportDiagnostics.errors[key]).toBe(
        "Not exported: xctrace did not attach to the app, so the trace holds no data."
      );
    }
    expect(result.warning).toBe(
      "xctrace could not attach to PM-sdbg, so nothing was recorded. xctrace reported: " +
        "Failed to attach to target process " +
        "Failed to load library /Applications/Xcode-26.6.app/Contents/SharedFrameworks/" +
        "DVTInstrumentsFoundation.framework/Resources/liboainject.dylib due to missing " +
        "bootstrapping symbols " +
        "Unable to find symbol named '_pthread_self' in owner: libsystem_pthread.dylib. " +
        "Call native-profiler-start again."
    );
    expect(api.exportedFiles).toEqual({ cpu: null, hangs: null, leaks: null });
    expect(api.profilingActive).toBe(false);

    // The report gives the same reason, not a template without a Time Profiler.
    const { exportErrors } = await analyzeNativeProfilerIos(api);
    expect(exportErrors.cpu).toBe(
      "Not exported: xctrace did not attach to the app, so the trace holds no data. " +
        "Call native-profiler-start for a new recording."
    );
    expect(exportErrors.hangs).toBe(exportErrors.cpu);
  });

  it("on a Mac app, exports and warns about another error", async () => {
    runIssues("* [Error] Leaks could not be recorded");
    const api = await recording(MAC);
    const result = await stopNativeProfilerIos(api);

    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
    expect(result.exportedFiles.cpu).toBe("/tmp/cpu.xml");
    expect(result.warning).toBe(
      "xctrace reported errors for this recording, so the data may be incomplete: " +
        "Leaks could not be recorded"
    );
  });

  it("on a Mac app, gives no warning when xctrace reports no issue", async () => {
    runIssues(null);
    const api = await recording(MAC);
    const result = await stopNativeProfilerIos(api);

    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
    expect(result.warning).toBeUndefined();
  });

  it("on a Mac app, does not take a quit during the export for one during the recording", async () => {
    runIssues(null);
    const app = spawn("sleep", ["30"]);
    const api = await recording(MAC);
    api.recordingAppPid = app.pid!;
    vi.mocked(exportIosTraceData).mockImplementationOnce(async () => {
      const gone = new Promise((resolve) => app.once("exit", resolve));
      app.kill("SIGKILL");
      await gone;
      return {
        files: { cpu: "/tmp/cpu.xml", hangs: "/tmp/hangs.xml", leaks: "/tmp/leaks.xml" },
        diagnostics: { tocSchemas: [], cpuSchemaUsed: "time-profile", errors: {} },
      };
    });

    const result = await stopNativeProfilerIos(api);

    expect(result.warning).toBeUndefined();
    expect(api.appEndedDuringCapture).toBe(false);
  });

  it("on a Mac app, does not take a quit while xctrace saves the trace for one during the recording", async () => {
    runIssues(null);
    const app = spawn("sleep", ["30"]);
    const api = await recording(MAC);
    api.recordingAppPid = app.pid!;
    quitOnStop(app.pid!);

    const result = await stopNativeProfilerIos(api);

    expect(app.exitCode !== null || app.signalCode !== null).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(api.appEndedDuringCapture).toBe(false);
  });

  it("on a Mac app, says so when xctrace ended on its own and the app is gone", async () => {
    runIssues(null);
    const api = await recording(MAC);
    // macOS pids stay below 100000, so no process has this one.
    api.recordingAppPid = 999_999;
    // xctrace ends without a stop, after the app it attached to.
    await endXctrace(api);

    const result = await stopNativeProfilerIos(api);

    expect(result.warning).toContain("xctrace exited before stop was called (code=0");
    expect(result.warning).toContain("The app quit, crashed or was restarted during the recording");
    expect(api.appEndedDuringCapture).toBe(true);
    // The export may skip the tables of a trace that holds next to no data.
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledWith(api.traceFile, true);
  });

  it("on a Mac app, does not take a quit after xctrace ended on its own for one during the recording", async () => {
    runIssues(null);
    const app = spawn("sleep", ["30"]);
    const api = await recording(MAC);
    api.recordingAppPid = app.pid!;
    await endXctrace(api);
    await quit(app);

    const result = await stopNativeProfilerIos(api);

    expect(result.warning).toContain("xctrace exited before stop was called (code=0");
    expect(result.warning).not.toContain("The app quit");
    expect(api.appEndedDuringCapture).toBe(false);
  });

  describe("on a Mac app at the 10-minute cap", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A recording of `app` whose cap has fired. */
    async function capped(app: ChildProcess): Promise<NativeProfilerSessionApi> {
      const api = await recording(MAC, () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      });
      api.recordingAppPid = app.pid!;
      const exited = new Promise((resolve) => api.captureProcess!.once("exit", resolve));
      vi.advanceTimersByTime(RECORDING_CAP_MS);
      vi.useRealTimers();
      await exited;
      expect(api.recordingTimedOut).toBe(true);
      return api;
    }

    it("does not take a quit after the cap for one during the recording", async () => {
      runIssues(null);
      const app = spawn("sleep", ["30"]);
      const api = await capped(app);
      await quit(app);

      const result = await stopNativeProfilerIos(api);

      expect(result.warning).toMatch(/^Recording timed out at 10 min cap/);
      expect(result.warning).not.toContain("The app quit");
      expect(api.appEndedDuringCapture).toBe(false);
    });

    it("says so when the app was gone at the cap", async () => {
      runIssues(null);
      const app = spawn("sleep", ["30"]);
      await quit(app);
      const api = await capped(app);

      const result = await stopNativeProfilerIos(api);

      expect(result.warning).toMatch(/^Recording timed out at 10 min cap/);
      expect(result.warning).toContain(
        "The app quit, crashed or was restarted during the recording"
      );
      expect(api.appEndedDuringCapture).toBe(true);
    });
  });

  describe.each([
    ["an iOS simulator", IOS],
    ["a Mac app", MAC],
  ])("on %s whose recording ended at the 10-minute cap with run errors", (_name, deviceId) => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A recording whose cap has fired and whose xctrace has exited. */
    async function capped(): Promise<NativeProfilerSessionApi> {
      const api = await recording(deviceId, () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      });
      const exited = new Promise((resolve) => api.captureProcess!.once("exit", resolve));
      vi.advanceTimersByTime(RECORDING_CAP_MS);
      vi.useRealTimers();
      await exited;
      expect(api.recordingTimedOut).toBe(true);
      return api;
    }

    it("names the failed attach and exports nothing", async () => {
      runIssues(ATTACH_FAILED);
      const api = await capped();
      const result = await stopNativeProfilerIos(api);

      expect(vi.mocked(exportIosTraceData)).not.toHaveBeenCalled();
      expect(result.warning).toMatch(
        /^Recording timed out at 10 min cap; xctrace could not attach to PM-sdbg, so nothing was recorded\./
      );
      const { exportErrors } = await analyzeNativeProfilerIos(api);
      expect(exportErrors.cpu).toBe(
        "Not exported: xctrace did not attach to the app, so the trace holds no data. " +
          "Call native-profiler-start for a new recording."
      );
    });

    it("names a recording that xctrace could not start and exports nothing", async () => {
      runIssues(
        "* [Error] Failed to start the recording: _lockKPerf: could not lock kperf. " +
          "Likely another session just started."
      );
      const api = await capped();
      const result = await stopNativeProfilerIos(api);

      expect(vi.mocked(exportIosTraceData)).not.toHaveBeenCalled();
      expect(result.warning).toMatch(
        /^Recording timed out at 10 min cap; xctrace could not record: Failed to start the recording/
      );
      expect(result.warning?.match(/Call native-profiler-start/g)).toHaveLength(1);
    });

    it("exports after another error, and names it", async () => {
      runIssues("* [Error] Leaks could not be recorded");
      const api = await capped();
      const result = await stopNativeProfilerIos(api);

      expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
      expect(result.warning).toBe(
        "Recording timed out at 10 min cap; exported the partial trace. xctrace reported " +
          "errors for this recording, so the data may be incomplete: Leaks could not be " +
          "recorded Call native-profiler-start again for a fresh recording."
      );
    });
  });

  it("on an iOS simulator xctrace did not attach to, exports nothing and says what xctrace reported", async () => {
    runIssues(ATTACH_FAILED);
    const api = await recording(IOS);
    const result = await stopNativeProfilerIos(api);

    expect(vi.mocked(exportIosTraceData)).not.toHaveBeenCalled();
    expect(result.exportedFiles).toEqual({ cpu: null, hangs: null, leaks: null });
    expect(result.warning).toMatch(
      /^xctrace could not attach to PM-sdbg, so nothing was recorded\. xctrace reported: Failed to attach/
    );
  });

  describe.each([
    ["an iOS simulator", IOS, "iOS"],
    ["a Mac app", MAC, "macOS"],
  ])("on %s whose recording xctrace could not start", (_name, deviceId, platform) => {
    const KPERF =
      "Failed to start the recording: _lockKPerf: could not lock kperf. Likely another session just started.";
    const COULD_NOT_RECORD =
      `xctrace could not record: ${KPERF} macOS lets one recording at a time use the kernel ` +
      `trace that Instruments records CPU samples with, and another recording on this Mac ` +
      `used it (Instruments, or an xctrace of another tool or tool-server). Call ` +
      `native-profiler-start again.`;
    const NOT_EXPORTED =
      "Not exported: xctrace could not start the recording, so the trace holds no data. " +
      "Call native-profiler-start for a new recording.";

    it("exports nothing at the stop, and analyze says that the analysis failed", async () => {
      runIssues(`* [Error] ${KPERF}`);
      const api = await recording(deviceId);
      const result = await stopNativeProfilerIos(api);

      expect(vi.mocked(exportIosTraceData)).not.toHaveBeenCalled();
      expect(result.exportedFiles).toEqual({ cpu: null, hangs: null, leaks: null });
      expect(result.warning).toBe(COULD_NOT_RECORD);

      const { report, exportErrors } = await analyzeNativeProfilerIos(api);
      expect(report).toContain(`# ${platform} Instruments Analysis`);
      expect(report).toContain("**Analysis failed**");
      expect(report).not.toContain("All clear");
      expect(exportErrors).toEqual({ cpu: NOT_EXPORTED, hangs: NOT_EXPORTED });
    });

    it("exports nothing when xctrace ended on its own, and says what it reported", async () => {
      runIssues(`* [Error] ${KPERF}`);
      const api = await recording(deviceId);
      // xctrace prints the run issue and exits 2 without a stop.
      await endXctrace(api);

      const result = await stopNativeProfilerIos(api);

      expect(vi.mocked(exportIosTraceData)).not.toHaveBeenCalled();
      expect(result.exportedFiles).toEqual({ cpu: null, hangs: null, leaks: null });
      expect(result.warning).toBe(
        `xctrace exited before stop was called (code=2, signal=?); ${COULD_NOT_RECORD}`
      );
      expect(result.warning).not.toContain("Common causes");
      const { exportErrors } = await analyzeNativeProfilerIos(api);
      expect(exportErrors).toEqual({ cpu: NOT_EXPORTED, hangs: NOT_EXPORTED });
    });
  });

  it("exports when xctrace ended on its own after another error, and names it instead of causes", async () => {
    runIssues("* [Error] Leaks could not be recorded");
    const api = await recording(IOS);
    await endXctrace(api);

    const result = await stopNativeProfilerIos(api);

    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
    expect(result.warning).toBe(
      "xctrace exited before stop was called (code=2, signal=?); exported the partial trace. " +
        "xctrace reported errors for this recording, so the data may be incomplete: " +
        "Leaks could not be recorded Call native-profiler-start again for a fresh recording."
    );
  });

  // Text of Instruments' ktrace plugin in Xcode 26.6 and 27.2. No recording showed that a
  // trace with this error holds nothing, and a skip would drop the tables that it has.
  it("exports after another error about the kernel trace", async () => {
    runIssues(
      "* [Error] Failed to acquire kernel trace recording resources (Resource busy). " +
        "Possibly in use by pid 4321."
    );
    const api = await recording(IOS);
    const result = await stopNativeProfilerIos(api);

    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
    expect(result.warning).toMatch(/^xctrace reported errors for this recording/);
  });
});

describe.each([
  ["an iOS simulator", IOS],
  ["a Mac app", MAC],
])("on %s whose leak capture failed", (_name, deviceId) => {
  /** Exports a CPU and hangs table with no row, and the Leaks detail with no row. */
  function exportEmptyTables(): void {
    const file = (name: string, xml: string) => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, xml);
      return filePath;
    };
    vi.mocked(exportIosTraceData).mockImplementationOnce(async () => ({
      files: {
        cpu: file("cpu.xml", "<trace-query-result></trace-query-result>"),
        hangs: file("hangs.xml", "<trace-query-result></trace-query-result>"),
        leaks: file(
          "leaks.xml",
          "<trace-query-result><node xpath='//trace-toc[1]/run[1]/tracks[1]/track[2]" +
            "/details[1]/detail[1]'></node></trace-query-result>"
        ),
      },
      diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
    }));
  }

  it("analyze says that leaks were not checked, and what xctrace reported", async () => {
    runIssues(LEAK_AGENT_FAILED);
    const api = await recording(deviceId);
    exportEmptyTables();
    const result = await stopNativeProfilerIos(api);

    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
    expect(result.warning).toBe(
      `xctrace reported errors for this recording, so the data may be incomplete: ${LEAK_AGENT_ERRORS}`
    );

    const { report, status } = await analyzeNativeProfilerIos(api);
    expect(report).toContain(
      `${LEAKS_NOT_RECORDED} xctrace reported that Instruments could not capture the leak ` +
        `data: ${LEAK_AGENT_ERRORS}. Record again to check for leaks. Do not report the app as ` +
        `leak-free.`
    );
    expect(report).toContain("Memory leaks were not checked");
    expect(report).not.toContain("All clear");
    expect(status).toBe("ok");
    // leak_stacks and the combined report read this flag.
    expect(api.parsedData?.leaksRecorded).toBe(false);
  });

  it("says the same when xctrace ended on its own, and not for the next recording", async () => {
    runIssues(LEAK_AGENT_FAILED);
    const api = await recording(deviceId);
    await endXctrace(api);
    exportEmptyTables();
    await stopNativeProfilerIos(api);
    expect((await analyzeNativeProfilerIos(api)).report).toContain(LEAK_AGENT_ERRORS);
    expect(api.parsedData?.leaksRecorded).toBe(false);

    runIssues(null);
    await recording(deviceId, undefined, api);
    exportEmptyTables();
    await stopNativeProfilerIos(api);
    const { report } = await analyzeNativeProfilerIos(api);
    expect(report).not.toContain(LEAKS_NOT_RECORDED);
    expect(api.parsedData?.leaksRecorded).toBe(true);
  });

  it("says the same when the recording ended at the 10-minute cap", async () => {
    runIssues(LEAK_AGENT_FAILED);
    const api = await recording(deviceId, () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    const exited = new Promise((resolve) => api.captureProcess!.once("exit", resolve));
    try {
      vi.advanceTimersByTime(RECORDING_CAP_MS);
    } finally {
      vi.useRealTimers();
    }
    await exited;
    expect(api.recordingTimedOut).toBe(true);
    exportEmptyTables();
    await stopNativeProfilerIos(api);

    expect((await analyzeNativeProfilerIos(api)).report).toContain(LEAK_AGENT_ERRORS);
    expect(api.parsedData?.leaksRecorded).toBe(false);
  });
});

describe("a native-profiler-stop that is still exporting", () => {
  /** An export that waits until the test lets it end. */
  function slowExport(files: Record<"cpu" | "hangs" | "leaks", string>): () => void {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    vi.mocked(exportIosTraceData).mockImplementationOnce(async () => {
      await done;
      return { files, diagnostics: { tocSchemas: [], cpuSchemaUsed: "time-profile", errors: {} } };
    });
    return finish;
  }

  it("is joined by a second stop, which gets its result and exports nothing again", async () => {
    runIssues(null);
    const api = await recording(MAC);
    const finish = slowExport({
      cpu: "/tmp/new-cpu.xml",
      hangs: "/tmp/h.xml",
      leaks: "/tmp/l.xml",
    });

    const first = stopNativeProfilerIos(api);
    await vi.waitFor(() => expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1));
    // xctrace has ended, so without the join this stop found no active session.
    expect(api.profilingActive).toBe(false);
    const second = stopNativeProfilerIos(api);
    finish();

    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(a.exportedFiles.cpu).toBe("/tmp/new-cpu.xml");
    expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1);
    expect(api.stopInProgress).toBeNull();
  });

  it("makes analyze wait for the new exports instead of reading the previous ones", async () => {
    runIssues(null);
    const api = await recording(MAC);
    api.exportedFiles = {
      cpu: "/tmp/old-cpu.xml",
      hangs: "/tmp/old-h.xml",
      leaks: "/tmp/old-l.xml",
    };
    const finish = slowExport({
      cpu: "/tmp/new-cpu.xml",
      hangs: "/tmp/h.xml",
      leaks: "/tmp/l.xml",
    });

    const stop = stopNativeProfilerIos(api);
    await vi.waitFor(() => expect(vi.mocked(exportIosTraceData)).toHaveBeenCalledTimes(1));
    let analyzedWith: string | null | undefined;
    const analyze = analyzeNativeProfilerIos(api).then(
      () => (analyzedWith = api.exportedFiles?.cpu),
      () => (analyzedWith = api.exportedFiles?.cpu)
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(analyzedWith).toBeUndefined();

    finish();
    await stop;
    await analyze;
    expect(analyzedWith).toBe("/tmp/new-cpu.xml");
  });

  it("stamps how long a Mac app's recording ran, and not an iOS one's", async () => {
    runIssues(null);
    const mac = await recording(MAC);
    await stopNativeProfilerIos(mac);
    expect(mac.recordedMs).toBeGreaterThanOrEqual(0);
    expect(mac.recordedMs).toBeLessThan(60_000);

    const ios = await recording(IOS);
    await stopNativeProfilerIos(ios);
    expect(ios.recordedMs).toBeNull();
  });
});

describe.each([
  ["an iOS simulator", IOS],
  ["a Mac app", MAC],
])("the wall clock at trace time 0 on %s", (_name, deviceId) => {
  const NO_TABLES = { cpu: null, hangs: null, leaks: null };

  /**
   * A recording whose start returned 300 ms after xctrace said "Starting
   * recording", the stub's first line, where the readiness wait ends. A real
   * start returns about 2.4 s after it, and the trace starts 0.2 s after it.
   */
  async function startedLate(): Promise<{ api: NativeProfilerSessionApi; ready: number }> {
    let ready = 0;
    const api = await recording(deviceId, async () => {
      ready = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    return { api, ready };
  }

  function exportWithTraceStart(traceStartMs: number | undefined): void {
    vi.mocked(exportIosTraceData).mockResolvedValueOnce({
      files: NO_TABLES,
      diagnostics: { tocSchemas: [], cpuSchemaUsed: null, errors: {}, traceStartMs },
    });
  }

  it("is when xctrace said that it starts the recording, until the stop", async () => {
    runIssues(null);
    const { api, ready } = await startedLate();
    const stamped = api.wallClockStartMs;
    // No start date in the table of contents: the stamp stays.
    exportWithTraceStart(undefined);
    await stopNativeProfilerIos(api);

    expect(stamped).not.toBeNull();
    expect(stamped!).toBeLessThanOrEqual(ready);
    expect(api.wallClockStartMs).toBe(stamped);
  });

  it("is the trace's start date after the stop, also in the analyzed data", async () => {
    runIssues(null);
    const { api } = await startedLate();
    const traceStartMs = api.wallClockStartMs! + 220;
    exportWithTraceStart(traceStartMs);

    await stopNativeProfilerIos(api);
    expect(api.wallClockStartMs).toBe(traceStartMs);

    // The combined report anchors the analyzed hangs with this value.
    await analyzeNativeProfilerIos(api);
    expect(api.parsedData?.wallClockStartMs).toBe(traceStartMs);
  });

  it("is the trace's start date after xctrace exited before the stop", async () => {
    runIssues(null);
    const { api } = await startedLate();
    const traceStartMs = api.wallClockStartMs! + 220;
    exportWithTraceStart(traceStartMs);

    await endXctrace(api);
    await stopNativeProfilerIos(api);
    expect(api.wallClockStartMs).toBe(traceStartMs);
  });
});

// The note about a short leak recording counts from there: Instruments begins its
// first leak check about 4 s after native-profiler-start returns.
it("counts a Mac app's recording time from the return of the start", async () => {
  runIssues(null);
  let ready = 0;
  const api = await recording(MAC, async () => {
    ready = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await stopNativeProfilerIos(api);

  expect(api.recordedMs).not.toBeNull();
  expect(api.recordedMs!).toBeLessThan(Date.now() - ready - 250);
});
