/**
 * Hangs without the main-thread time of the recorder that Instruments' Allocations
 * instrument loads into the app. The recorder runs inside the app's allocations, also on
 * the main thread, and its frames have no symbol, so its samples had made the app
 * function that allocated (often `main`) the hang's suspect. The pipeline now leaves out
 * a hang with under 250 ms left without the recorder (and the app's suspensions),
 * shortens and relabels the others, and analyze says what it changed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";
import { recorderNsIn } from "../../src/utils/ios-profiler/recorder-hangs";
import { removeSuspendedTime } from "../../src/utils/ios-profiler/app-suspensions";
import { runIosProfilerPipeline } from "../../src/utils/ios-profiler/pipeline/index";
import { correlateHangsWithCpu } from "../../src/utils/ios-profiler/pipeline/01-correlate";
import { analyzeNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";
import { renderHangStacksIos } from "../../src/tools/profiler/query/profiler-stack-query";
import type { CpuSample, RawHang, StackFrame } from "../../src/utils/ios-profiler/types";

const MS = 1_000_000;
const INSTRUMENTS_DIR =
  "/Applications/Xcode.app/Contents/SharedFrameworks/DVTInstrumentsFoundation.framework/Versions/A/Resources";
const APP = "/Applications/Example.app/Contents/MacOS/Example";

function rawHang(startMs: number, durationMs: number, hangType = "Hang"): RawHang {
  return { startNs: startMs * MS, durationNs: durationMs * MS, hangType, threadFmt: "Main Thread" };
}

const app = (name: string): StackFrame => ({ name, isSystemLibrary: false });
const sys = (name: string): StackFrame => ({ name, isSystemLibrary: true });
const recorderFrame: StackFrame = {
  name: "0x1201208b8",
  isSystemLibrary: false,
  tooling: "instruments",
};
/** The recorder inside an allocation of the main run loop: its only app frame is `$main`. */
const RECORDER = [
  sys("thread_stack_pcs"),
  recorderFrame,
  sys("_malloc_zone_malloc_instrumented_or_legacy"),
  sys("CA::Transaction::commit()"),
  app("static ExampleApp.$main()"),
];
const LAYOUT = [app("-[ExampleView layout]"), app("static ExampleApp.$main()")];

function samples(
  fromMs: number,
  count: number,
  stack: StackFrame[],
  thread = "Main Thread 0x1"
): CpuSample[] {
  return Array.from({ length: count }, (_, i) => ({
    timestampNs: (fromMs + i) * MS,
    threadFmt: thread,
    weightNs: MS,
    stack,
  }));
}

/** removeSuspendedTime with the recorder's time of each hang, as the pipeline calls it. */
function withoutRecorder(
  hangs: RawHang[],
  cpu: CpuSample[],
  suspensions: { startNs: number; endNs: number }[] = []
) {
  return removeSuspendedTime(hangs, suspensions, recorderNsIn(hangs, cpu));
}

describe("taking the recorder's time out of the hangs", () => {
  it("leaves out a hang with under 250 ms left without the recorder, and keeps one with more", () => {
    const cpu = [
      // Hang 1, 400 ms: 300 ms of the recorder, 100 ms of the app.
      ...samples(1_000, 300, RECORDER),
      ...samples(1_300, 100, LAYOUT),
      // Hang 2, 900 ms: 400 ms of the recorder, 500 ms of the app.
      ...samples(5_000, 400, RECORDER),
      ...samples(5_400, 500, LAYOUT),
      // The recorder outside a hang does not count.
      ...samples(8_000, 200, RECORDER),
    ];
    const out = withoutRecorder([rawHang(1_000, 400), rawHang(5_000, 900)], cpu);

    expect(out.hangs).toEqual([rawHang(5_000, 900)]);
    expect(out.recorderNs).toEqual([400 * MS]);
    expect(out.suspendedNs).toEqual([0]);
    expect(out.recorderSummary).toEqual({ removedHangs: 1, adjustedHangs: 1, recorderMs: 700 });
  });

  it("counts the recorder on the main thread only", () => {
    const cpu = samples(1_000, 300, RECORDER, "prof.leak 0x2 (Example, pid: 1)");
    expect(recorderNsIn([rawHang(1_000, 400)], cpu)).toEqual([0]);
    const out = withoutRecorder([rawHang(1_000, 400)], cpu);
    expect(out.hangs).toHaveLength(1);
    expect(out.recorderNs).toEqual([0]);
    expect(out.recorderSummary).toEqual({ removedHangs: 0, adjustedHangs: 0, recorderMs: 0 });
  });

  it("takes the recorder's time out after the app's suspended time", () => {
    const cpu = samples(1_000, 200, RECORDER);
    const suspended = (ms: number) => [{ startNs: (2_000 - ms) * MS, endNs: 2_000 * MS }];
    // 1000 ms: 500 suspended + 200 recorder leaves 300 ms.
    const kept = withoutRecorder([rawHang(1_000, 1_000)], cpu, suspended(500));
    expect(kept.hangs).toHaveLength(1);
    expect([kept.suspendedNs, kept.recorderNs]).toEqual([[500 * MS], [200 * MS]]);
    // 600 suspended + 200 recorder leaves 200 ms: the recorder's part leaves the hang out.
    const left = withoutRecorder([rawHang(1_000, 1_000)], cpu, suspended(600));
    expect(left.hangs).toHaveLength(0);
    expect(left.summary).toMatchObject({ removedHangs: 0, adjustedHangs: 1 });
    expect(left.recorderSummary).toEqual({ removedHangs: 1, adjustedHangs: 0, recorderMs: 200 });
    // 800 suspended leaves 200 ms: the suspensions leave the hang out, and the recorder's
    // time in it counts nowhere.
    const gone = withoutRecorder([rawHang(1_000, 1_000)], cpu, suspended(800));
    expect(gone.summary).toMatchObject({ removedHangs: 1, adjustedHangs: 0 });
    expect(gone.recorderSummary).toEqual({ removedHangs: 0, adjustedHangs: 0, recorderMs: 0 });
  });

  it("changes nothing without the recorder", () => {
    const hangs = [rawHang(1_000, 300), rawHang(5_000, 900)];
    const out = withoutRecorder(hangs, samples(1_000, 300, LAYOUT));
    expect(out.hangs).toEqual(hangs);
    expect(out.recorderNs).toEqual([0, 0]);
    expect(out.recorderSummary).toEqual({ removedHangs: 0, adjustedHangs: 0, recorderMs: 0 });
  });
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argent-recorder-hangs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function binaryDef(id: number, name: string, path: string): string {
  return `<binary id="${id}" name="${name}" UUID="00000000-0000-0000-0000-000000000000" arch="arm64" load-addr="0x100000000" path="${path}"/>`;
}

function row(timeMs: number, backtrace: string): string {
  return (
    `<row><sample-time>${timeMs * MS}</sample-time>` +
    `<thread fmt="Main Thread 0x1 (Example, pid: 4321)"></thread>` +
    `<weight>${MS}</weight>${backtrace}</row>`
  );
}

interface TraceHang {
  startMs: number;
  durationMs: number;
  /** Main-thread samples of the recorder, 1 ms each from the start of the hang. */
  recorderMs: number;
  /** Main-thread samples of the app, 1 ms each after the recorder's. */
  appMs: number;
}

/** Two hangs: 400 ms with 300 ms of the recorder, and 900 ms with 400 ms of it. */
const TWO_HANGS: TraceHang[] = [
  { startMs: 1_000, durationMs: 400, recorderMs: 300, appMs: 100 },
  { startMs: 5_000, durationMs: 900, recorderMs: 400, appMs: 500 },
];

/** The first hang has recorder samples: their first row defines the frames that the app's rows use. */
function writeTrace(traceHangs: TraceHang[] = TWO_HANGS): Record<string, string> {
  const recorder =
    `<backtrace id="1">` +
    `<frame id="2" name="0x1201208b8" addr="0x1">${binaryDef(3, "liboainject.dylib", `${INSTRUMENTS_DIR}/liboainject.dylib`)}</frame>` +
    `<frame id="4" name="_malloc_zone_malloc_instrumented_or_legacy" addr="0x1">${binaryDef(5, "libsystem_malloc.dylib", "/usr/lib/system/libsystem_malloc.dylib")}</frame>` +
    `<frame id="6" name="static ExampleApp.$main()" addr="0x1">${binaryDef(7, "Example", APP)}</frame>` +
    `</backtrace>`;
  const layout =
    `<backtrace id="8">` +
    `<frame id="9" name="-[ExampleView layout]" addr="0x1"><binary ref="7"/></frame>` +
    `<frame ref="6"/></backtrace>`;
  const rows: string[] = [];
  let recorderRow = recorder;
  let layoutRow = layout;
  for (const { startMs, recorderMs, appMs } of traceHangs) {
    for (let ms = startMs; ms < startMs + recorderMs; ms++) {
      rows.push(row(ms, recorderRow));
      recorderRow = `<backtrace ref="1"/>`;
    }
    for (let ms = startMs + recorderMs; ms < startMs + recorderMs + appMs; ms++) {
      rows.push(row(ms, layoutRow));
      layoutRow = `<backtrace ref="8"/>`;
    }
  }
  const cpu = join(dir, "cpu.xml");
  writeFileSync(cpu, `<trace-query-result><node>${rows.join("\n")}</node></trace-query-result>`);
  const hang = (startMs: number, durationMs: number) =>
    `<row><start-time>${startMs * MS}</start-time><duration>${durationMs * MS}</duration>` +
    `<hang-type>Hang</hang-type><thread fmt="Main Thread"></thread></row>`;
  const hangs = join(dir, "hangs.xml");
  const hangRows = traceHangs.map((h) => hang(h.startMs, h.durationMs)).join("");
  writeFileSync(hangs, `<trace-query-result><node>${hangRows}</node></trace-query-result>`);
  return { cpu, hangs };
}

describe("runIosProfilerPipeline: hangs of Instruments' recorder", () => {
  it("reports only the app's hang, with its own length, and not the recorder's function as a suspect", async () => {
    const out = await runIosProfilerPipeline({ ...writeTrace(), leaks: null });

    expect(out.uiHangs).toHaveLength(1);
    expect(out.uiHangs[0]).toMatchObject({
      hangType: "Hang",
      durationMs: 500,
      recorderMs: 400,
      severity: "RED",
      suspectedFunctions: ["-[ExampleView layout]"],
    });
    expect(out.uiHangs[0]!.appCallChains.map((c) => c.chain)).toEqual([
      ["-[ExampleView layout]", "static ExampleApp.$main()"],
    ]);
    expect(out.recorderAdjustment).toEqual({ removedHangs: 1, adjustedHangs: 1, recorderMs: 700 });
    expect(renderHangStacksIos(out.cpuSamples, out.uiHangs, 0, 15)).toContain(
      "## Hang #0 — Hang (500ms at 00:05.000, not counting 400ms of Instruments' recorder)"
    );
  });

  it("does not count the recorder's time as a run of the hang's thread", async () => {
    // A 600 ms hang: 300 ms of the recorder and 25 ms of the app on the main thread, and
    // 200 ms of a worker. Without the recorder, the main thread ran 25 ms of its 300 ms.
    const files = writeTrace([{ startMs: 1_000, durationMs: 600, recorderMs: 300, appMs: 25 }]);
    const worker =
      `<backtrace id="20"><frame id="21" name="ExampleStore.loadAll()" addr="0x1">` +
      `<binary ref="7"/></frame></backtrace>`;
    const workerRows = Array.from({ length: 200 }, (_, i) =>
      row(1_000 + i, i === 0 ? worker : `<backtrace ref="20"/>`).replace(
        "Main Thread 0x1",
        "Example 0x3"
      )
    );
    const cpu = readFileSync(files.cpu!, "utf8");
    writeFileSync(files.cpu!, cpu.replace("</node>", `${workerRows.join("\n")}</node>`));

    const out = await runIosProfilerPipeline({ ...files, leaks: null });
    expect(out.uiHangs[0]).toMatchObject({
      durationMs: 300,
      recorderMs: 300,
      suspectsFromOtherThreads: true,
      hangThreadRanMs: 25,
    });
    expect(out.uiHangs[0]!.suspectedFunctions[0]).toBe("ExampleStore.loadAll()");
  });

  it("does not count the recorder on another thread as a run of another thread", () => {
    // A 400 ms hang in which the main thread did not run, and only the recorder ran on a
    // worker: no thread ran the app's code, so the hang has no suspects.
    const cpu = [
      ...samples(0, 10, LAYOUT),
      ...samples(1_000, 50, [recorderFrame, app("ExampleStore.loadAll()")], "Example 0x3"),
    ];
    const { uiHangs } = correlateHangsWithCpu([rawHang(1_000, 400)], cpu);

    expect(uiHangs[0]).toMatchObject({
      hangThreadRanMs: 0,
      suspectedFunctions: [],
      appCallChains: [],
    });
    expect(uiHangs[0]!.suspectsFromOtherThreads).toBeUndefined();
  });

  it("leaves the recorder's samples out of hang_stacks, as out of the suspects", () => {
    // The recorder's frames have no symbol, so its dominant frame is the app's allocation.
    const recorderInLayout = [recorderFrame, ...LAYOUT];
    const cpu = [...samples(1_000, 5, LAYOUT), ...samples(1_005, 5, recorderInLayout)];
    const { uiHangs } = correlateHangsWithCpu([rawHang(1_000, 20)], cpu);

    expect(uiHangs[0]!.appCallChains).toEqual([
      { chain: ["-[ExampleView layout]", "static ExampleApp.$main()"], sampleCount: 5 },
    ]);
    expect(renderHangStacksIos(cpu, uiHangs, 0, 15)).toContain(
      "### Full Stack Samples (matching suspected functions)\n\n" +
        "- (5×) `-[ExampleView layout]` → `static ExampleApp.$main()`"
    );
  });
});

function makeApi(
  platform: "ios" | "macos",
  files: Record<string, string> = writeTrace()
): NativeProfilerSessionApi {
  return {
    deviceId: platform === "macos" ? "macos-app-com.example.app" : "ios-sim",
    platform,
    appProcess: "Example",
    capturePid: null,
    cpuFilterPid: null,
    recordingMallocStackLogging: null,
    mallocStackLogging: null,
    recordingCustomTemplate: null,
    customTemplate: null,
    recordingAppPid: null,
    recordingAppEnded: false,
    appEndedDuringCapture: false,
    exportSkipReason: null,
    leaksCaptureError: null,
    recordedMs: null,
    startReturnedMs: null,
    stopInProgress: null,
    suspensionWatch: null,
    appSuspensions: platform === "macos" ? [] : null,
    captureProcess: null,
    traceFile: join(dir, "native-profiler-20260101-000000.trace"),
    exportedFiles: { ...files, leaks: null },
    disposed: false,
    profilingActive: false,
    wallClockStartMs: Date.now(),
    parsedData: null,
    recordingTimeout: null,
    cappedEnd: null,
    recordingTimedOut: false,
    recordingExitedUnexpectedly: false,
    lastExitInfo: null,
    androidOnDeviceTracePath: null,
  };
}

describe("the analyze report on hangs of Instruments' recorder", () => {
  it.each(["ios", "macos"] as const)(
    "says what argent took out of the hangs (%s)",
    async (platform) => {
      const api = makeApi(platform);
      const { report } = await analyzeNativeProfilerIos(api);

      expect(report).toContain(
        "> ℹ️ **Instruments' recorder:** The recorder that Instruments loads into the app to track " +
          "allocations ran on the main thread for 700 ms in the hangs. argent left out 1 hang that " +
          "had under 250 ms of the app's own time without the recorder (xctrace reports no " +
          "shorter hang), and took the recorder's time out of the length of 1 other hang. The " +
          "recorder stays in the app until the app quits: to see the hangs without it, start the " +
          'app again and record the same actions with `template_path: "Time Profiler"`.'
      );
      expect(report).toContain(
        "| 1 | Hang | 00:05.000 | 500ms, not counting 400ms of Instruments' recorder | 🔴 |"
      );
      expect(report).not.toMatch(/Likely caused by: `static ExampleApp\.\$main\(\)/);
      expect(api.parsedData?.uiHangs.map((h) => [h.durationMs, h.recorderMs])).toEqual([
        [500, 400],
      ]);
    }
  );

  it("gives the rule by which it left a hang out, also for one that was less than half the recorder", async () => {
    // 316 ms with 133 ms (42%) of the recorder leaves 183 ms of the app's own time. On Food
    // Truck for macOS, 2 of the 3 hangs left out were less than half the recorder.
    const files = writeTrace([{ startMs: 1_000, durationMs: 316, recorderMs: 133, appMs: 150 }]);
    const api = makeApi("macos", files);
    const { report } = await analyzeNativeProfilerIos(api);

    expect(report).toContain(
      "ran on the main thread for 133 ms in the hangs. argent left out 1 hang that had under " +
        "250 ms of the app's own time without the recorder (xctrace reports no shorter hang). "
    );
    expect(report).not.toContain("mostly the recorder");
    expect(api.parsedData?.uiHangs).toEqual([]);
  });
});
