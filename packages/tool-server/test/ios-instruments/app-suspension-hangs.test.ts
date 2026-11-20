/**
 * Hangs of a Mac app with the time macOS held the app suspended. Instruments'
 * leak check suspends the whole app, so a hang that a check overlaps holds it in
 * xctrace's duration. The pause makes a hang of fixed work longer, but not one
 * that waits for a deadline or a sleep, and the trace cannot tell them apart. So
 * the pipeline keeps every hang with its recorded length and label, gives it the
 * suspended part, analyze says how to read it, and the reports name the suspended
 * time and the range of the app's own hang next to the duration.
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
  suspendedTimeInHangs,
  suspensionSpansInTrace,
  withSuspendedTime,
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

/** The hangs as the pipeline reports them: correlated, then with the suspended time. */
function report(hangs: RawHang[], spans: AppSuspensionSpan[]) {
  const out = suspendedTimeInHangs(hangs, spans);
  const { uiHangs } = correlateHangsWithCpu(hangs, []);
  return {
    uiHangs: uiHangs.map((h, i) => withSuspendedTime(h, out.suspendedNs[i]!)),
    summary: out.summary,
  };
}

describe("the suspended time in a hang", () => {
  it("leaves a hang with no suspension in it as recorded", () => {
    const hang = rawHang(1_000, 600, "Hang");
    const { uiHangs, summary } = report([hang], [span(5_000, 15_000)]);
    const [recorded] = correlateHangsWithCpu([hang], []).uiHangs;
    expect(uiHangs).toEqual([recorded]);
    expect(uiHangs[0]).not.toHaveProperty("suspendedMs");
    expect(summary).toEqual({ pauses: 1, pausedMs: 10_000, overlappedHangs: 0 });
  });

  it("keeps xctrace's own label on a hang with no suspension in it", () => {
    // 300 ms would be a Microhang by the thresholds; xctrace's label stays.
    const { uiHangs } = report([rawHang(1_000, 300, "Hang")], [span(5_000, 6_000)]);
    expect(uiHangs[0]).toMatchObject({ hangType: "Hang", durationMs: 300, severity: "RED" });
  });

  it("keeps the recorded length and label of a hang that a suspension covers in part", () => {
    // 11 s in the trace, of which 10 s the app was suspended for a leak check.
    const { uiHangs, summary } = report([rawHang(3_000, 11_000)], [span(4_000, 14_000)]);
    expect(uiHangs).toHaveLength(1);
    expect(uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 11_000,
      severity: "RED",
      suspendedMs: 10_000,
      startNs: 3_000 * MS,
      endNs: 14_000 * MS,
      startTimeFormatted: "00:03.000",
    });
    expect(summary).toEqual({ pauses: 1, pausedMs: 10_000, overlappedHangs: 1 });
  });

  it("keeps a hang whose main thread waited on through the pause", () => {
    // Measured on a Mac app: a 1.5 s main-thread spin to a deadline began 269 ms into a
    // 7167 ms hang, and a 6726 ms leak check began about 170 ms after the spin. The deadline
    // passed during the pause, so the app hung for about 1.77 s of its own, much more than
    // the 441 ms that was not suspended.
    const { uiHangs, summary } = report(
      [rawHang(38_998, 7_167, "Severe Hang")],
      [span(39_439, 46_165)]
    );
    expect(uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      severity: "RED",
      durationMs: 7_167,
      suspendedMs: 6_726,
    });
    expect(summary).toEqual({ pauses: 1, pausedMs: 6_726, overlappedHangs: 1 });
  });

  it("keeps a hang that the suspension covers all of", () => {
    // The 13.8 s Severe Hang that a leak check made on a Mac app that argent drove.
    const { uiHangs, summary } = report([rawHang(3_644, 13_827)], [span(3_600, 17_500)]);
    expect(uiHangs).toHaveLength(1);
    expect(uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 13_827,
      suspendedMs: 13_827,
    });
    expect(summary).toEqual({ pauses: 1, pausedMs: 13_900, overlappedHangs: 1 });
  });

  it.each([249, 250, 499, 2_000])(
    "keeps Instruments' label with %s ms outside the pause",
    (ownMs) => {
      // A 10 s pause, with half of the rest of the hang before it and half after.
      const { uiHangs } = report(
        [rawHang(1_000 - ownMs / 2, 10_000 + ownMs, "Severe Hang")],
        [span(1_000, 11_000)]
      );
      expect(uiHangs[0]).toMatchObject({
        hangType: "Severe Hang",
        severity: "RED",
        durationMs: 10_000 + ownMs,
        suspendedMs: 10_000,
      });
    }
  );

  it("adds up several suspensions in one hang", () => {
    const { uiHangs, summary } = report(
      [rawHang(0, 10_000)],
      [span(1_000, 3_000), span(5_000, 8_000)]
    );
    expect(uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 10_000,
      suspendedMs: 5_000,
    });
    expect(summary).toEqual({ pauses: 2, pausedMs: 5_000, overlappedHangs: 1 });
  });

  it("ignores an overlap under 20 ms, which the watch's 10 ms reads cannot tell from none", () => {
    const touching = report([rawHang(1_000, 2_010, "Severe Hang")], [span(2_995, 3_010)]);
    expect(touching.uiHangs[0]).toMatchObject({ hangType: "Severe Hang", durationMs: 2_010 });
    expect(touching.uiHangs[0]).not.toHaveProperty("suspendedMs");
    expect(touching.summary).toMatchObject({ overlappedHangs: 0 });
    const inside = report([rawHang(1_000, 2_010, "Severe Hang")], [span(2_985, 3_010)]);
    expect(inside.uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 2_010,
      suspendedMs: 25,
    });
    expect(inside.summary).toMatchObject({ overlappedHangs: 1 });
  });

  it("counts overlapping and touching suspensions once", () => {
    // 1-4, 2-5 and 5-6 s are one suspension from 1 to 6 s.
    const { uiHangs, summary } = report(
      [rawHang(0, 7_000)],
      [span(2_000, 5_000), span(5_000, 6_000), span(1_000, 4_000)]
    );
    expect(uiHangs[0]).toMatchObject({ durationMs: 7_000, suspendedMs: 5_000 });
    expect(summary).toEqual({ pauses: 1, pausedMs: 5_000, overlappedHangs: 1 });
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
      durationMs: 5_000,
      suspendedMs: 1_500,
    });
    expect(summary).toEqual({ pauses: 4, pausedMs: 10_500, overlappedHangs: 1 });
  });

  it("keeps every hang in its order, and the spans it was given", () => {
    const spans = [span(5_000, 15_000), span(1_000, 2_000)];
    const copy = spans.map((s) => ({ ...s }));
    const { uiHangs, summary } = report(
      [rawHang(0, 600, "Hang"), rawHang(4_900, 10_150), rawHang(20_000, 400, "Microhang")],
      spans
    );
    expect(uiHangs.map((h) => [h.startNs / MS, h.durationMs, h.suspendedMs])).toEqual([
      [0, 600, undefined],
      [4_900, 10_150, 10_000],
      [20_000, 400, undefined],
    ]);
    expect(summary).toEqual({ pauses: 2, pausedMs: 11_000, overlappedHangs: 1 });
    expect(spans).toEqual(copy);
  });

  it("changes nothing without a suspension", () => {
    const hangs = [rawHang(0, 600, "Hang"), rawHang(1_000, 3_000)];
    const out = suspendedTimeInHangs(hangs, []);
    expect(out.suspendedNs).toEqual([0, 0]);
    expect(out.summary).toEqual({ pauses: 0, pausedMs: 0, overlappedHangs: 0 });
    const [uiHang] = correlateHangsWithCpu([hangs[0]!], []).uiHangs;
    expect(withSuspendedTime(uiHang!, 0)).toBe(uiHang);
  });
});

const APP_EXECUTABLE = "/Applications/Example.app/Contents/MacOS/ExampleExec";

function cpuRow(timeMs: number, id: number, fn: string): string {
  return (
    `<row><sample-time>${timeMs * MS}</sample-time>` +
    `<thread fmt="Main Thread 0x1 (ExampleExec, pid: 4321)"></thread>` +
    `<weight>${MS}</weight>` +
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
 * checks are the spans below.
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
  it("keeps each hang that a pause overlaps, with its samples and the suspended part", async () => {
    const out = await runIosProfilerPipeline(writeTrace(), { appSuspensions: LEAK_CHECKS });

    expect(out.uiHangs).toHaveLength(2);
    expect(out.uiHangs[0]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 13_827,
      suspendedMs: 13_771,
      suspectedFunctions: ["-[ExampleView layoutA]"],
    });
    expect(out.uiHangs[1]).toMatchObject({
      hangType: "Severe Hang",
      durationMs: 11_000,
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
      "-[ExampleView layoutA]": true,
      "-[ExampleView layoutB]": true,
      "-[ExampleView idle]": false,
    });
    expect(out.suspensionAdjustment).toEqual({
      pauses: 2,
      pausedMs: 23_771,
      overlappedHangs: 2,
    });
  });

  it("keeps the hangs of 1.5 s spins to a deadline that leak checks overlapped", async () => {
    // Measured on a Mac app (the same spin each time, ended by a 1.5 s deadline): one leak
    // check left 441 ms of a 7167 ms hang outside it, and one left under 250 ms of a 3868 ms
    // hang. Without the pause, each was a hang of about 1.5 s or more.
    const hangs = join(dir, "spin-hangs.xml");
    writeFileSync(
      hangs,
      `<trace-query-result><node>` +
        hangRow(rawHang(38_998, 7_167)) +
        hangRow(rawHang(57_116, 3_868)) +
        `</node></trace-query-result>`
    );
    const out = await runIosProfilerPipeline(
      { cpu: null, hangs, leaks: null },
      { appSuspensions: [span(39_439, 46_165), span(57_300, 60_984)] }
    );
    expect(out.uiHangs.map((h) => [h.hangType, h.severity, h.durationMs, h.suspendedMs])).toEqual([
      ["Severe Hang", "RED", 7_167, 6_726],
      ["Severe Hang", "RED", 3_868, 3_684],
    ]);
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
    expect(none.uiHangs.map((h) => h.suspendedMs)).toEqual([undefined, undefined]);
    expect(none.suspensionAdjustment).toEqual({ pauses: 0, pausedMs: 0, overlappedHangs: 0 });
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
    recordingAppPid: null,
    recordingAppEnded: false,
    appEndedDuringCapture: false,
    exportSkipReason: null,
    recordedMs: null,
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
    recordingTimedOut: false,
    recordingExitedUnexpectedly: false,
    lastExitInfo: null,
    androidOnDeviceTracePath: null,
  };
}

describe("the analyze report's note on the app's suspensions", () => {
  const OLD_NOTE = "**Hangs and the leak check:**";
  const NOTE = "**Leak-check pauses:**";

  it("says how to read the hangs that the pauses overlap, in place of the leak-check warning", async () => {
    const api = makeApi("macos", LEAK_CHECKS);
    const { report } = await analyzeNativeProfilerIos(api);

    expect(report).toContain(NOTE);
    expect(report).toMatch(/2 times \(23\.8 s.*overlap 2 hangs/s);
    expect(report).toContain('template_path: "Time Profiler"');
    expect(report.indexOf(NOTE)).toBeLessThan(report.indexOf("---"));
    expect(report).not.toContain(OLD_NOTE);
    // Both hangs stay in the table, with their recorded lengths and labels.
    expect(report).toContain(
      "| 1 | Severe Hang | 00:03.644 | 13827ms, 13771ms of it while the app was suspended " +
        "(the app's own hang: 56 to 13827ms) | 🔴 |"
    );
    expect(report).toContain(
      "| 2 | Severe Hang | 00:20.000 | 11000ms, 10000ms of it while the app was suspended " +
        "(the app's own hang: 1000 to 11000ms) | 🔴 |"
    );
    // The frozen data the drill-downs read has the same hangs.
    expect(api.parsedData?.uiHangs.map((h) => [h.durationMs, h.suspendedMs])).toEqual([
      [13_827, 13_771],
      [11_000, 10_000],
    ]);
  });

  it("words one pause and one hang", async () => {
    const { report } = await analyzeNativeProfilerIos(makeApi("macos", [LEAK_CHECKS[1]!]));
    expect(report).toContain(NOTE);
    expect(report).toMatch(/10\.0 s.*overlaps 1 hang/s);
    expect(report).toContain("| 1 | Severe Hang | 00:03.644 | 13827ms | 🔴 |");
  });

  it("does not name the leak check when the recording did not check for leaks", async () => {
    const noExport = makeApi("macos", LEAK_CHECKS, false);
    // A template with no Leaks instrument, exported by Xcode 26.6: a result with no node.
    const noDetail = makeApi("macos", LEAK_CHECKS);
    writeFileSync(noDetail.exportedFiles!.leaks!, `<trace-query-result>\n</trace-query-result>`);
    for (const api of [noExport, noDetail]) {
      const { report } = await analyzeNativeProfilerIos(api);
      expect(report).toMatch(/App pauses:.*23\.8 s.*overlap 2 hangs/s);
      expect(report).toContain("debugger");
      expect(report).not.toContain(NOTE);
      expect(report).not.toContain("Time Profiler");
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
    expect(api.parsedData?.uiHangs.map((h) => [h.durationMs, h.suspendedMs])).toEqual([
      [13_827, undefined],
      [11_000, undefined],
    ]);
  });
});

const SUSPENDED =
  ", 10000ms of it while the app was suspended (the app's own hang: 1000 to 11000ms)";

function uiHang(partial: Partial<UiHang> = {}): UiHang {
  return {
    type: "ui_hang",
    platform: "ios",
    hangType: "Severe Hang",
    durationMs: 11_000,
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
    const plain = uiHang({
      hangType: "Hang",
      startTimeFormatted: "00:40.000",
      durationMs: 700,
      suspendedMs: 0,
    });
    const { report } = await renderNativeProfilerReport({
      payload: {
        metadata: { traceFile: null, platform: "macOS", timestamp: "2026-01-01T00:00:00Z" },
        bottlenecks: [uiHang(), plain],
      },
      traceFile: null,
    });
    expect(report).toContain(`| 1 | Severe Hang | 00:20.000 | 11000ms${SUSPENDED} | 🔴 |`);
    expect(report).toContain(`**Severe Hang at 00:20.000 (11000ms${SUSPENDED})**`);
    expect(report).toContain(
      `- 🔴 Severe Hang at 00:20.000 (11000ms${SUSPENDED}): Main thread stalled`
    );
    expect(report).toContain("| 2 | Hang | 00:40.000 | 700ms | 🔴 |");
    expect(report).toContain("**Hang at 00:40.000 (700ms)**");
    expect(report.split(SUSPENDED)).toHaveLength(4);
  });

  it("is in profiler-stack-query's hang_stacks heading", () => {
    expect(renderHangStacksIos([], [uiHang()], 0, 5)).toContain(
      `## Hang #0 — Severe Hang (11000ms at 00:20.000${SUSPENDED})`
    );
    expect(renderHangStacksIos([], [uiHang({ suspendedMs: undefined })], 0, 5)).toContain(
      `## Hang #0 — Severe Hang (11000ms at 00:20.000)\n`
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
        wallClockStartMs: START,
      };
      api.parsedData = parsedData;
      const out = (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
        port: PORT,
        device_id: DEVICE,
      })) as string;
      expect(out).toContain(`### Severe Hang at 00:20.000 (11000ms${SUSPENDED}) ↔ Commit #0`);
      expect(out).toContain(`- **Severe Hang** at 01:00.000 (11000ms${SUSPENDED})`);
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
