/**
 * Hangs of a Mac app without the time macOS held the app suspended. Instruments'
 * leak check suspends the whole app, so a hang that began before or during a
 * check includes it in xctrace's duration. The pipeline leaves out a hang with
 * under 250 ms of its own, shortens and relabels the others, analyze says what
 * it changed, and the reports name the suspended time next to the duration.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  NativeProfilerParsedData,
  NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";
import {
  removeSuspendedTime,
  suspensionSpansInTrace,
  withoutSuspendedTime,
  type AppSuspensionSpan,
} from "../../src/utils/ios-profiler/app-suspensions";
import { correlateHangsWithCpu } from "../../src/utils/ios-profiler/pipeline/01-correlate";
import { runIosProfilerPipeline } from "../../src/utils/ios-profiler/pipeline/index";
import { analyzeNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import { renderHangStacksIos } from "../../src/tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import type { RawHang, UiHang } from "../../src/utils/ios-profiler/types";

const MS = 1_000_000;

function rawHang(startMs: number, durationMs: number, hangType = "Severe Hang"): RawHang {
  return {
    startNs: Math.round(startMs * MS),
    durationNs: Math.round(durationMs * MS),
    hangType,
    threadFmt: "Main Thread",
  };
}

function span(startMs: number, endMs: number): AppSuspensionSpan {
  return { startNs: startMs * MS, endNs: endMs * MS };
}

/** The hangs as the pipeline reports them: correlated, then without the suspended time. */
function report(hangs: RawHang[], spans: AppSuspensionSpan[]) {
  const out = removeSuspendedTime(hangs, spans);
  const { uiHangs } = correlateHangsWithCpu(out.hangs, []);
  return {
    uiHangs: uiHangs.map((h, i) => withoutSuspendedTime(h, out.suspendedNs[i]!)),
    summary: out.summary,
  };
}

describe("taking the suspended time out of a hang", () => {
  it("leaves a hang with no suspension in it as recorded", () => {
    const hang = rawHang(1_000, 600, "Hang");
    const { uiHangs, summary } = report([hang], [span(5_000, 15_000)]);
    const [recorded] = correlateHangsWithCpu([hang], []).uiHangs;
    expect(uiHangs).toEqual([recorded]);
    expect(uiHangs[0]).not.toHaveProperty("suspendedMs");
    expect(summary).toEqual({ pauses: 1, pausedMs: 10_000, removedHangs: 0, adjustedHangs: 0 });
  });

  it("keeps xctrace's own label on a hang with no suspension in it", () => {
    // 300 ms would be a Microhang by the thresholds; xctrace's label stays.
    const { uiHangs } = report([rawHang(1_000, 300, "Hang")], [span(5_000, 6_000)]);
    expect(uiHangs[0]).toMatchObject({ hangType: "Hang", durationMs: 300, severity: "RED" });
  });

  it("shortens and relabels a hang that a suspension covers in part, on its recorded span", () => {
    // 11 s in the trace, of which 10 s the app was suspended for a leak check.
    const { uiHangs, summary } = report([rawHang(3_000, 11_000)], [span(4_000, 14_000)]);
    expect(uiHangs).toHaveLength(1);
    expect(uiHangs[0]).toMatchObject({
      hangType: "Hang",
      durationMs: 1_000,
      severity: "RED",
      suspendedMs: 10_000,
      startNs: 3_000 * MS,
      endNs: 14_000 * MS,
      startTimeFormatted: "00:03.000",
    });
    expect(summary).toEqual({ pauses: 1, pausedMs: 10_000, removedHangs: 0, adjustedHangs: 1 });
  });

  it("leaves out a hang that was only the suspension", () => {
    // The 13.8 s Severe Hang that a leak check made on a Mac app that argent drove.
    const { uiHangs, summary } = report([rawHang(3_644, 13_827)], [span(3_600, 17_500)]);
    expect(uiHangs).toEqual([]);
    expect(summary).toEqual({ pauses: 1, pausedMs: 13_900, removedHangs: 1, adjustedHangs: 0 });
  });

  it.each([
    [249, null, null],
    [249.999999, null, null],
    [250, "Microhang", "YELLOW"],
    [499, "Microhang", "YELLOW"],
    [500, "Hang", "RED"],
    [1_999, "Hang", "RED"],
    [2_000, "Severe Hang", "RED"],
  ] as const)("with %s ms of its own: %s", (ownMs, label, severity) => {
    // A 10 s pause, with half of the hang's own time before it and half after.
    const { uiHangs, summary } = report(
      [rawHang(1_000 - ownMs / 2, 10_000 + ownMs)],
      [span(1_000, 11_000)]
    );
    if (label === null) {
      expect(uiHangs).toEqual([]);
      expect(summary.removedHangs).toBe(1);
      return;
    }
    expect(uiHangs[0]).toMatchObject({
      hangType: label,
      severity,
      durationMs: Math.round(ownMs),
      suspendedMs: 10_000,
    });
    expect(summary.adjustedHangs).toBe(1);
  });

  it("adds up several suspensions in one hang", () => {
    const { uiHangs, summary } = report(
      [rawHang(0, 10_000)],
      [span(1_000, 3_000), span(5_000, 8_000)]
    );
    expect(uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 5_000,
      suspendedMs: 5_000,
    });
    expect(summary).toEqual({ pauses: 2, pausedMs: 5_000, removedHangs: 0, adjustedHangs: 1 });
  });

  it("ignores an overlap under 20 ms, which the watch's 10 ms reads cannot tell from none", () => {
    const touching = report([rawHang(1_000, 2_010, "Severe Hang")], [span(2_995, 3_010)]);
    expect(touching.uiHangs[0]).toMatchObject({ hangType: "Severe Hang", durationMs: 2_010 });
    expect(touching.uiHangs[0]).not.toHaveProperty("suspendedMs");
    expect(touching.summary).toMatchObject({ removedHangs: 0, adjustedHangs: 0 });
    const inside = report([rawHang(1_000, 2_010, "Severe Hang")], [span(2_985, 3_010)]);
    expect(inside.uiHangs[0]).toMatchObject({
      hangType: "Hang",
      durationMs: 1_985,
      suspendedMs: 25,
    });
  });

  it("counts overlapping and touching suspensions once", () => {
    // 1-4, 2-5 and 5-6 s are one suspension from 1 to 6 s.
    const { uiHangs, summary } = report(
      [rawHang(0, 7_000)],
      [span(2_000, 5_000), span(5_000, 6_000), span(1_000, 4_000)]
    );
    expect(uiHangs[0]).toMatchObject({ durationMs: 2_000, suspendedMs: 5_000 });
    expect(summary).toEqual({ pauses: 1, pausedMs: 5_000, removedHangs: 0, adjustedHangs: 1 });
  });

  it("counts only the part of a suspension inside the hang", () => {
    const { uiHangs, summary } = report(
      [rawHang(10_000, 5_000)],
      [
        span(0, 2_000), // before the hang
        span(9_000, 11_000), // its first second
        span(14_500, 20_000), // its last half second
        span(30_000, 31_000), // after the hang
        span(40_000, 40_000), // empty
      ]
    );
    expect(uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 3_500,
      suspendedMs: 1_500,
    });
    expect(summary).toEqual({ pauses: 4, pausedMs: 10_500, removedHangs: 0, adjustedHangs: 1 });
  });

  it("keeps the order of the hangs it keeps, and the spans it was given", () => {
    const spans = [span(5_000, 15_000), span(1_000, 2_000)];
    const copy = spans.map((s) => ({ ...s }));
    const { uiHangs, summary } = report(
      [rawHang(0, 600, "Hang"), rawHang(4_900, 10_150), rawHang(20_000, 400, "Microhang")],
      spans
    );
    expect(uiHangs.map((h) => [h.startNs / MS, h.durationMs])).toEqual([
      [0, 600],
      [20_000, 400],
    ]);
    expect(summary).toEqual({ pauses: 2, pausedMs: 11_000, removedHangs: 1, adjustedHangs: 0 });
    expect(spans).toEqual(copy);
  });

  it("changes nothing without a suspension", () => {
    const hangs = [rawHang(0, 600, "Hang"), rawHang(1_000, 3_000)];
    const out = removeSuspendedTime(hangs, []);
    expect(out.hangs).toEqual(hangs);
    expect(out.suspendedNs).toEqual([0, 0]);
    expect(out.summary).toEqual({ pauses: 0, pausedMs: 0, removedHangs: 0, adjustedHangs: 0 });
    const [uiHang] = correlateHangsWithCpu([hangs[0]!], []).uiHangs;
    expect(withoutSuspendedTime(uiHang!, 0)).toBe(uiHang);
  });
});

const APP_EXECUTABLE = "/Applications/Example.app/Contents/MacOS/ExampleExec";

function cpuRow(timeMs: number, id: number, fn: string): string {
  return (
    `<row><sample-time>${timeMs * MS}</sample-time>` +
    `<thread fmt="Main Thread 0x1 (ExampleExec, pid: 4321)"></thread>` +
    `<weight>${150 * MS}</weight>` +
    `<backtrace id="${id}"><frame id="${id + 1}" name="${fn}" addr="0x${(0x1000 + id).toString(16)}">` +
    `<binary id="${id + 2}" name="ExampleExec" UUID="00000000-0000-0000-0000-000000000000" ` +
    `arch="arm64" load-addr="0x100000000" path="${APP_EXECUTABLE}"/></frame></backtrace></row>`
  );
}

function hangRow(hang: RawHang): string {
  return (
    `<row><start-time>${hang.startNs}</start-time><duration>${hang.durationNs}</duration>` +
    `<hang-type>${hang.hangType}</hang-type><thread fmt="Main Thread"></thread></row>`
  );
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argent-app-suspension-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A trace of two hangs: one at 3.644 s that a leak check filled but for 56 ms
 * (with a sample of `-[ExampleView layoutA]` in those 56 ms), and one at 20 s of
 * 11 s, 10 s of it a leak check (with `-[ExampleView layoutB]`). The two leak
 * checks are the spans below. Each sample weighs 150 ms, so the main thread ran
 * for more than 10% of the second hang's own 1 s.
 */
function writeTrace(leaks = true): Record<string, string | null> {
  const files = {
    cpu: join(dir, "cpu.xml"),
    hangs: join(dir, "hangs.xml"),
    leaks: leaks ? join(dir, "leaks.xml") : null,
  };
  writeFileSync(
    files.cpu,
    `<trace-query-result><node>` +
      [
        cpuRow(3_650, 1, "-[ExampleView layoutA]"),
        cpuRow(20_100, 4, "-[ExampleView layoutB]"),
        cpuRow(40_000, 7, "-[ExampleView idle]"),
      ].join("") +
      `</node></trace-query-result>`
  );
  writeFileSync(
    files.hangs,
    `<trace-query-result><node>` +
      hangRow(rawHang(3_644, 13_827)) +
      hangRow(rawHang(20_000, 11_000)) +
      `</node></trace-query-result>`
  );
  if (files.leaks)
    writeFileSync(files.leaks, `<trace-query-result><node></node></trace-query-result>`);
  return files;
}

const LEAK_CHECKS = [span(3_700, 17_471), span(21_000, 31_000)];

describe("runIosProfilerPipeline with the app's suspensions", () => {
  it("leaves out the hang that was the pause, before its samples mark a hotspot as during a hang", async () => {
    const out = await runIosProfilerPipeline(writeTrace(), { appSuspensions: LEAK_CHECKS });

    expect(out.uiHangs).toHaveLength(1);
    expect(out.uiHangs[0]).toMatchObject({
      hangType: "Hang",
      durationMs: 1_000,
      suspendedMs: 10_000,
      startNs: 20_000 * MS,
      endNs: 31_000 * MS,
      suspectedFunctions: ["-[ExampleView layoutB]"],
    });
    expect(out.bottlenecks.filter((b) => b.type === "ui_hang")).toEqual(out.uiHangs);
    const duringHang = Object.fromEntries(
      out.cpuHotspots.map((h) => [h.dominantFunction, h.duringHang])
    );
    expect(duringHang).toEqual({
      "-[ExampleView layoutA]": false,
      "-[ExampleView layoutB]": true,
      "-[ExampleView idle]": false,
    });
    expect(out.suspensionAdjustment).toEqual({
      pauses: 2,
      pausedMs: 23_771,
      removedHangs: 1,
      adjustedHangs: 1,
    });
  });

  it("leaves the hangs as recorded without suspensions, and counts nothing for an empty list", async () => {
    const files = writeTrace();
    for (const appSuspensions of [undefined, null]) {
      const out = await runIosProfilerPipeline(files, { appSuspensions });
      expect(out.uiHangs.map((h) => [h.hangType, h.durationMs])).toEqual([
        ["Severe Hang", 13_827],
        ["Severe Hang", 11_000],
      ]);
      expect(out.cpuHotspots.find((h) => h.dominantFunction.includes("layoutA"))?.duringHang).toBe(
        true
      );
      expect(out.suspensionAdjustment).toBeNull();
    }

    const none = await runIosProfilerPipeline(files, { appSuspensions: [] });
    expect(none.uiHangs.map((h) => h.durationMs)).toEqual([13_827, 11_000]);
    expect(none.suspensionAdjustment).toEqual({
      pauses: 0,
      pausedMs: 0,
      removedHangs: 0,
      adjustedHangs: 0,
    });
  });
});

function makeApi(
  platform: "ios" | "macos",
  appSuspensions: AppSuspensionSpan[] | null,
  leaks = true
): NativeProfilerSessionApi {
  return {
    deviceId: platform === "macos" ? "macos-app-com.example.app" : "ios-sim",
    platform,
    appProcess: "ExampleExec",
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
    appSuspensions,
    captureProcess: null,
    traceFile: join(dir, "native-profiler-20260101-000000.trace"),
    exportedFiles: writeTrace(leaks),
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

describe("the analyze report's note on the app's suspensions", () => {
  const OLD_NOTE = "**Hangs and the leak check:**";
  const NOTE = "**Leak-check pauses:**";

  it("says what argent took out of the hangs, in place of the leak-check warning", async () => {
    const api = makeApi("macos", LEAK_CHECKS);
    const { report } = await analyzeNativeProfilerIos(api);

    expect(report).toContain(
      `> ℹ️ ${NOTE} Instruments held the app suspended 2 times (23.8 s in all) to check it for ` +
        `leaks. argent left out 1 hang that was only these pauses, and took the pauses out of ` +
        `the length of 1 other hang.`
    );
    expect(report.indexOf(NOTE)).toBeLessThan(report.indexOf("---"));
    expect(report).not.toContain(OLD_NOTE);
    // The frozen data the drill-downs read has the same hangs.
    expect(api.parsedData?.uiHangs.map((h) => [h.durationMs, h.suspendedMs])).toEqual([
      [1_000, 10_000],
    ]);
  });

  it("words one pause and one kind of change", async () => {
    const removed = await analyzeNativeProfilerIos(makeApi("macos", [LEAK_CHECKS[0]!]));
    expect(removed.report).toContain(
      `> ℹ️ ${NOTE} Instruments held the app suspended once (13.8 s) to check it for leaks. ` +
        `argent left out 1 hang that was only this pause.`
    );

    const adjusted = await analyzeNativeProfilerIos(makeApi("macos", [LEAK_CHECKS[1]!]));
    expect(adjusted.report).toContain(
      `> ℹ️ ${NOTE} Instruments held the app suspended once (10.0 s) to check it for leaks. ` +
        `argent took the pause out of the length of 1 hang.`
    );
  });

  it("does not name the leak check when the recording did not check for leaks", async () => {
    const noExport = makeApi("macos", LEAK_CHECKS, false);
    // A template with no Leaks instrument, exported by Xcode 26.6: a result with no node.
    const noDetail = makeApi("macos", LEAK_CHECKS);
    writeFileSync(noDetail.exportedFiles!.leaks!, `<trace-query-result>\n</trace-query-result>`);
    for (const api of [noExport, noDetail]) {
      const { report } = await analyzeNativeProfilerIos(api);
      expect(report).toContain(
        `> ℹ️ **App pauses:** macOS held the app suspended 2 times (23.8 s in all). argent left ` +
          `out 1 hang that was only these pauses, and took the pauses out of the length of 1 other hang.`
      );
      expect(report).not.toContain(NOTE);
    }
  });

  it("is absent, and so is the warning, when argent watched the app and no hang changed", async () => {
    const { report } = await analyzeNativeProfilerIos(makeApi("macos", [span(50_000, 55_000)]));
    expect(report).not.toContain(NOTE);
    expect(report).not.toContain(OLD_NOTE);

    const none = await analyzeNativeProfilerIos(makeApi("macos", []));
    expect(none.report).not.toContain(NOTE);
    expect(none.report).not.toContain(OLD_NOTE);
    expect(none.report).toContain("| 1 | Severe Hang | 00:03.644 | 13827ms |");
  });

  it("keeps the leak-check warning when argent did not watch the app", async () => {
    const { report } = await analyzeNativeProfilerIos(makeApi("macos", null));
    expect(report).toContain(
      `> ⚠️ ${OLD_NOTE} Instruments pauses a Mac app for several seconds while it checks the ` +
        `app for leaks, about every 11 s.`
    );
    expect(report).not.toContain(NOTE);
    expect(report).toContain("| 1 | Severe Hang | 00:03.644 | 13827ms |");
  });

  it("leaves an iOS simulator's hangs as recorded", async () => {
    const api = makeApi("ios", LEAK_CHECKS);
    const { report } = await analyzeNativeProfilerIos(api);
    expect(report).not.toContain(NOTE);
    expect(api.parsedData?.uiHangs.map((h) => h.durationMs)).toEqual([13_827, 11_000]);
  });
});

const SUSPENDED = ", not counting 10000ms when the app was suspended";

function uiHang(partial: Partial<UiHang> = {}): UiHang {
  return {
    type: "ui_hang",
    platform: "ios",
    hangType: "Hang",
    durationMs: 1_000,
    startTimeFormatted: "00:20.000",
    startNs: 20_000 * MS,
    endNs: 31_000 * MS,
    suspectedFunctions: ["-[ExampleView layoutB]"],
    appCallChains: [],
    severity: "RED",
    suspendedMs: 10_000,
    ...partial,
  };
}

describe("the suspended time next to a hang's duration", () => {
  it("is in the hang table, the hang's heading and its advice", async () => {
    const plain = uiHang({ startTimeFormatted: "00:40.000", durationMs: 700, suspendedMs: 0 });
    const { report } = await renderNativeProfilerReport({
      payload: {
        metadata: { traceFile: null, platform: "macOS", timestamp: "2026-01-01T00:00:00Z" },
        bottlenecks: [uiHang(), plain],
      },
      traceFile: null,
    });
    expect(report).toContain(`| 1 | Hang | 00:20.000 | 1000ms${SUSPENDED} | 🔴 |`);
    expect(report).toContain(`**Hang at 00:20.000 (1000ms${SUSPENDED})**`);
    expect(report).toContain(`- 🔴 Hang at 00:20.000 (1000ms${SUSPENDED}): Main thread stalled`);
    expect(report).toContain("| 2 | Hang | 00:40.000 | 700ms | 🔴 |");
    expect(report).toContain("**Hang at 00:40.000 (700ms)**");
    expect(report.split(SUSPENDED)).toHaveLength(4);
  });

  it("is in profiler-stack-query's hang_stacks heading", () => {
    expect(renderHangStacksIos([], [uiHang()], 0, 5)).toContain(
      `## Hang #0 — Hang (1000ms at 00:20.000${SUSPENDED})`
    );
    expect(renderHangStacksIos([], [uiHang({ suspendedMs: undefined })], 0, 5)).toContain(
      `## Hang #0 — Hang (1000ms at 00:20.000)\n`
    );
  });

  it("is in the combined report, for a hang with a React commit and one without", async () => {
    const DEVICE = "macos-app-com.example.app";
    const PORT = 8081;
    const START = 1_000_000;
    const commitsPath = join(dir, "commits.json");
    await fs.writeFile(
      commitsPath,
      JSON.stringify({
        commits: [
          {
            commitIndex: 0,
            timestamp: 20_100,
            componentName: "MyComp",
            actualDuration: 500,
            selfDuration: 500,
            commitDuration: 500,
            didRender: true,
            changeDescription: null,
          },
        ],
        meta: { profileStartWallMs: START },
      })
    );
    cacheProfilerPaths(
      PORT,
      {
        sessionId: "s",
        debugDir: dir,
        cpuProfilePath: null,
        commitsPath,
        cpuSampleIndexPath: null,
        detectedArchitecture: null,
        anyCompilerOptimized: null,
        hotCommitIndices: [0],
        totalReactCommits: 1,
      },
      DEVICE
    );
    try {
      const api = makeApi("macos", null);
      const parsedData: NativeProfilerParsedData = {
        cpuSamples: [],
        uiHangs: [
          uiHang(),
          uiHang({ startNs: 60_000 * MS, endNs: 72_000 * MS, startTimeFormatted: "01:00.000" }),
        ],
        cpuHotspots: [],
        memoryLeaks: [],
        leaksRecorded: true,
        mallocStackLogging: null,
        customTemplate: null,
        wallClockStartMs: START,
      };
      api.parsedData = parsedData;
      const out = (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
        port: PORT,
        device_id: DEVICE,
      })) as string;
      expect(out).toContain(`### Hang at 00:20.000 (1000ms${SUSPENDED}) ↔ Commit #0`);
      expect(out).toContain(`- **Hang** at 01:00.000 (1000ms${SUSPENDED})`);
    } finally {
      clearCachedProfilerPaths(PORT, DEVICE);
    }
  });
});

describe("suspensionSpansInTrace", () => {
  const START = 1_794_550_000_000;
  it("puts the watch's windows on the trace's timeline and cuts them to the trace", () => {
    const windows = [
      { startMs: START - 2_000, endMs: START - 500 }, // before the trace
      { startMs: START - 100, endMs: START + 70 }, // the attach, cut at the start
      { startMs: START + 5_200, endMs: START + 6_540 },
      { startMs: START + 9_900, endMs: START + 10_400 }, // past the end
      { startMs: START + 10_500, endMs: START + 11_000 }, // after the trace, at the stop
      { startMs: START + 3_000, endMs: START + 3_000 }, // empty
    ];
    expect(suspensionSpansInTrace(windows, START, 10_000)).toEqual([
      { startNs: 0, endNs: 70 * MS },
      { startNs: 5_200 * MS, endNs: 6_540 * MS },
      { startNs: 9_900 * MS, endNs: 10_000 * MS },
    ]);
    // With no known length, only the start cuts.
    expect(suspensionSpansInTrace(windows, START)).toHaveLength(4);
  });
});
