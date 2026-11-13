/**
 * The xctrace analyze report for a Mac app and for the tools' CPU time: the
 * report title names the platform, and a "CPU sampling" note says how much of
 * the CPU time argent's library and the Instruments recorder spent inside the
 * app, which the hotspots leave out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";

// The parse is covered by tooling-libraries.test.ts; here the pipeline hands
// analyze its totals directly.
vi.mock("../../src/utils/ios-profiler/pipeline/index", () => ({
  runIosProfilerPipeline: vi.fn(),
}));

import { runIosProfilerPipeline } from "../../src/utils/ios-profiler/pipeline/index";
import { analyzeNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";
import { aggregateCpuHotspots } from "../../src/utils/ios-profiler/pipeline/02-aggregate";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import type { Bottleneck } from "../../src/utils/ios-profiler/types";

type PipelineResult = Awaited<ReturnType<typeof runIosProfilerPipeline>>;

const NOTE = "**CPU sampling:**";

// The leaks exports of a Mac app's trace with no leak, as xctrace (Xcode 26.6) wrote them.
// The Argent template has the Leaks instrument, so the export holds its detail:
const LEAKS_CHECKED_NONE_FOUND =
  `<?xml version="1.0"?>\n<trace-query-result>\n` +
  `<node xpath='//trace-toc[1]/run[1]/tracks[1]/track[2]/details[1]/detail[1]'></node>` +
  `</trace-query-result>\n`;
// `template_path: "Time Profiler"` has no Leaks instrument, and the export still exits 0:
const LEAKS_NOT_CHECKED = `<?xml version="1.0"?>\n<trace-query-result>\n</trace-query-result>\n`;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argent-macos-analyze-"));
  for (const name of ["cpu.xml", "hangs.xml"]) writeFileSync(join(dir, name), "");
  writeFileSync(join(dir, "leaks.xml"), LEAKS_CHECKED_NONE_FOUND);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeApi(platform: "ios" | "macos"): NativeProfilerSessionApi {
  return {
    deviceId: platform === "macos" ? "macos-app-com.example.app" : "ios-sim",
    platform,
    appProcess: "ExampleExec",
    capturePid: null,
    cpuFilterPid: null,
    recordingMallocStackLogging: null,
    mallocStackLogging: null,
    recordingAppPid: null,
    appEndedDuringCapture: false,
    exportSkipReason: null,
    recordedMs: null,
    stopInProgress: null,
    suspensionWatch: null,
    appSuspensions: null,
    captureProcess: null,
    traceFile: join(dir, "native-profiler-20260101-000000.trace"),
    exportedFiles: {
      cpu: join(dir, "cpu.xml"),
      hangs: join(dir, "hangs.xml"),
      leaks: join(dir, "leaks.xml"),
    },
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

function pipeline(
  tooling: Partial<Pick<PipelineResult, "toolingCpuMs" | "totalCpuMs">>,
  bottlenecks: Bottleneck[] = [],
  uiHangs: PipelineResult["uiHangs"] = []
): void {
  vi.mocked(runIosProfilerPipeline).mockResolvedValue({
    bottlenecks,
    cpuSamples: [],
    uiHangs,
    cpuHotspots: [],
    memoryLeaks: [],
    ...tooling,
  } as PipelineResult);
}

/** A real hotspot, so the report takes its full (not all-clear) form. */
function oneHotspot(): Bottleneck[] {
  return aggregateCpuHotspots([
    {
      timestampNs: 1_000_000,
      threadFmt: "Main Thread 0x1",
      weightNs: 5_000_000,
      stack: [{ name: "-[ExampleView layout]", isSystemLibrary: false }],
    },
  ]);
}

describe("the CPU sampling note on the tools' time", () => {
  it("gives argent's share of the CPU time and says the hotspots leave it out", async () => {
    pipeline({ toolingCpuMs: { argent: 120, instruments: 0 }, totalCpuMs: 400 });

    const { report } = await analyzeNativeProfilerIos(makeApi("macos"));

    expect(report).toContain(
      `${NOTE} Of the CPU samples, 120 ms (30%) were argent's own work inside the app, such as ` +
        `describe and taps, while the trace recorded. They are left out of the CPU hotspots.`
    );
    expect(report).toContain(`marked "argent's own library" or "Instruments' own library"`);
    expect(report).not.toContain("Instruments loads into the app");
  });

  it("gives both tools' shares, Instruments' alone, and <1% for a sliver", async () => {
    pipeline({ toolingCpuMs: { argent: 300, instruments: 50 }, totalCpuMs: 1000 });
    const both = (await analyzeNativeProfilerIos(makeApi("macos"))).report;
    expect(both).toContain(
      "300 ms (30%) were argent's own work inside the app, such as describe and taps, while the " +
        "trace recorded, and 50 ms (5%) were the recorder that Instruments loads into the app " +
        "to track allocations."
    );

    pipeline({ toolingCpuMs: { argent: 0, instruments: 40 }, totalCpuMs: 200 });
    const instrumentsOnly = (await analyzeNativeProfilerIos(makeApi("macos"))).report;
    expect(instrumentsOnly).toContain(
      `${NOTE} Of the CPU samples, 40 ms (20%) were the recorder that Instruments loads`
    );
    expect(instrumentsOnly).not.toContain("argent's own work");

    pipeline({ toolingCpuMs: { argent: 3, instruments: 0 }, totalCpuMs: 1000 });
    const sliver = (await analyzeNativeProfilerIos(makeApi("macos"))).report;
    expect(sliver).toContain("3 ms (<1%) were argent's own work");
  });

  it("is in the full report, its file and the inline one, as in the all-clear one", async () => {
    pipeline({ toolingCpuMs: { argent: 120, instruments: 0 }, totalCpuMs: 400 }, oneHotspot());

    const result = await analyzeNativeProfilerIos(makeApi("macos"));

    expect(result.bottlenecksTotal).toBe(1);
    expect(result.report).toContain("120 ms (30%) were argent's own work");
    expect(readFileSync(result.reportFile!, "utf8")).toContain(
      "120 ms (30%) were argent's own work"
    );
  });

  it("is on an iOS simulator's report too", async () => {
    pipeline({ toolingCpuMs: { argent: 50, instruments: 0 }, totalCpuMs: 100 });
    const { report } = await analyzeNativeProfilerIos(makeApi("ios"));
    expect(report).toContain("50 ms (50%) were argent's own work inside the app while the trace");
    // On iOS, describe and taps run outside the app.
    expect(report).not.toContain("describe and taps");
  });

  it("is absent without tool time, without CPU time, and when the pipeline gives no totals", async () => {
    for (const tooling of [
      { toolingCpuMs: { argent: 0, instruments: 0 }, totalCpuMs: 400 },
      { toolingCpuMs: { argent: 0, instruments: 0 }, totalCpuMs: 0 },
      {},
    ]) {
      pipeline(tooling);
      const result = await analyzeNativeProfilerIos(makeApi("macos"));
      expect({ tooling, note: result.report.includes(NOTE) }).toEqual({ tooling, note: false });
      expect(result.status).toBe("ok");
    }
  });
});

describe("the note on hangs and the leak check", () => {
  const LEAK_NOTE = "**Hangs and the leak check:**";
  // The Severe Hang that a leak check made on a Mac app that argent drove.
  const hang: PipelineResult["uiHangs"][number] = {
    type: "ui_hang",
    platform: "ios",
    hangType: "Severe Hang",
    durationMs: 13827,
    startTimeFormatted: "00:03.644",
    startNs: 3_644_000_000,
    endNs: 17_471_000_000,
    suspectedFunctions: [],
    appCallChains: [],
    severity: "RED",
  };

  function withHangs(uiHangs: PipelineResult["uiHangs"]): void {
    pipeline({}, oneHotspot(), uiHangs);
  }

  it("is at the top of a Mac app's report with hangs when the recording checked for leaks", async () => {
    withHangs([hang]);
    const { report } = await analyzeNativeProfilerIos(makeApi("macos"));
    expect(report).toContain(
      `> ⚠️ ${LEAK_NOTE} Instruments pauses a Mac app for several seconds while it checks the ` +
        `app for leaks, about every 11 s.`
    );
    expect(report).toContain('`template_path: "Time Profiler"`');
    expect(report.indexOf(LEAK_NOTE)).toBeLessThan(report.indexOf("---"));
  });

  it("is absent without hangs, without leak data, and on an iOS simulator", async () => {
    withHangs([]);
    expect((await analyzeNativeProfilerIos(makeApi("macos"))).report).not.toContain(LEAK_NOTE);

    // A template without the Leaks instrument exports no leaks table (Xcode 27.2), or
    // one with no Leaks detail (Xcode 26.6).
    withHangs([hang]);
    const noLeaks = makeApi("macos");
    noLeaks.exportedFiles = { ...noLeaks.exportedFiles, leaks: null };
    expect((await analyzeNativeProfilerIos(noLeaks)).report).not.toContain(LEAK_NOTE);
    writeFileSync(join(dir, "leaks.xml"), LEAKS_NOT_CHECKED);
    expect((await analyzeNativeProfilerIos(makeApi("macos"))).report).not.toContain(LEAK_NOTE);
    writeFileSync(join(dir, "leaks.xml"), LEAKS_CHECKED_NONE_FOUND);

    withHangs([hang]);
    expect((await analyzeNativeProfilerIos(makeApi("ios"))).report).not.toContain(LEAK_NOTE);
  });
});

describe("the note on a recording too short for a leak check", () => {
  const SHORT_NOTE = "**Memory leaks:** No leak was found, but the recording lasted only";

  function recorded(
    platform: "ios" | "macos",
    recordedMs: number | null
  ): NativeProfilerSessionApi {
    const api = makeApi(platform);
    api.recordedMs = recordedMs;
    return api;
  }

  it("is at the top of a Mac app's report with no leaks from a recording under 20 s", async () => {
    pipeline({});
    const { report } = await analyzeNativeProfilerIos(recorded("macos", 5_400));
    expect(report).toContain(
      `> ⚠️ ${SHORT_NOTE} 5 s. Instruments begins its first leak check about 4 s after ` +
        `native-profiler-start returns`
    );
    expect(report).toContain("Do not report the app as leak-free");
    expect(report.indexOf(SHORT_NOTE)).toBeLessThan(report.indexOf("All clear"));
  });

  it("is absent, and leaks read as not checked, when a Mac trace had no Leaks instrument", async () => {
    // A 12 s `template_path: "Time Profiler"` recording, exported by Xcode 26.6.
    writeFileSync(join(dir, "leaks.xml"), LEAKS_NOT_CHECKED);
    pipeline({});
    const mac = recorded("macos", 12_000);
    const { report } = await analyzeNativeProfilerIos(mac);
    expect(report).not.toContain(SHORT_NOTE);
    expect(report).toContain(
      "> ⚠️ **Memory leaks:** No leak data was recorded, so memory leaks were not checked."
    );
    expect(mac.parsedData?.leaksRecorded).toBe(false);

    // iOS keeps its rule: an exported leaks file is leak data.
    const ios = recorded("ios", 12_000);
    await analyzeNativeProfilerIos(ios);
    expect(ios.parsedData?.leaksRecorded).toBe(true);
  });

  it("is absent for 20 s and more, with leaks, without leak data, with no duration, and on iOS", async () => {
    pipeline({});
    expect((await analyzeNativeProfilerIos(recorded("macos", 20_000))).report).not.toContain(
      SHORT_NOTE
    );

    const leak: PipelineResult["memoryLeaks"][number] = {
      type: "memory_leak",
      platform: "ios",
      objectType: "ExampleNode",
      totalSizeBytes: 32,
      count: 1,
      responsibleFrame: "swift_slowAllocTyped",
      responsibleLibrary: "libswiftCore.dylib",
      attributed: true,
      severity: "RED",
    };
    vi.mocked(runIosProfilerPipeline).mockResolvedValue({
      bottlenecks: [leak],
      cpuSamples: [],
      uiHangs: [],
      cpuHotspots: [],
      memoryLeaks: [leak],
      toolingCpuMs: { argent: 0, instruments: 0 },
      totalCpuMs: 0,
    });
    expect((await analyzeNativeProfilerIos(recorded("macos", 5_000))).report).not.toContain(
      SHORT_NOTE
    );

    pipeline({});
    const noLeaks = recorded("macos", 5_000);
    noLeaks.exportedFiles = { ...noLeaks.exportedFiles, leaks: null };
    expect((await analyzeNativeProfilerIos(noLeaks)).report).not.toContain(SHORT_NOTE);
    expect((await analyzeNativeProfilerIos(recorded("macos", null))).report).not.toContain(
      SHORT_NOTE
    );
    expect((await analyzeNativeProfilerIos(recorded("ios", 5_000))).report).not.toContain(
      SHORT_NOTE
    );
  });
});

describe("the report title", () => {
  it("names macOS for a Mac app's capture and iOS for a simulator's", async () => {
    for (const bottlenecks of [[], oneHotspot()]) {
      pipeline({}, bottlenecks);
      const mac = await analyzeNativeProfilerIos(makeApi("macos"));
      expect(mac.report).toMatch(/^# macOS Instruments Analysis\n/);
      expect(mac.report).toContain("**Platform:** macOS");
      expect(readFileSync(mac.reportFile!, "utf8")).toMatch(/^# macOS Instruments Analysis\n/);

      const ios = await analyzeNativeProfilerIos(makeApi("ios"));
      expect(ios.report).toMatch(/^# iOS Instruments Analysis\n/);
      expect(ios.report).toContain("**Platform:** iOS");
    }
  });

  it("still names Android's Perfetto analysis", async () => {
    for (const bottlenecks of [[], oneHotspot()]) {
      const { report } = await renderNativeProfilerReport({
        payload: {
          metadata: { traceFile: null, platform: "Android", timestamp: "2026-01-01T00:00:00Z" },
          bottlenecks,
        },
        traceFile: null,
      });
      expect(report).toMatch(/^# Android Perfetto Analysis\n/);
    }
  });
});
