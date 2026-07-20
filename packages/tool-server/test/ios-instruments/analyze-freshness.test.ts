import { describe, it, expect, vi } from "vitest";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";

// The iOS pipeline parses xctrace XML off disk; stub it so analyze runs
// deterministically with zero bottlenecks (the all-clear path), isolating the
// freshness-note wiring this test is about.
vi.mock("../../src/utils/ios-profiler/pipeline/index", () => ({
  runIosProfilerPipeline: vi.fn(async () => ({
    bottlenecks: [],
    cpuSamples: [],
    uiHangs: [],
    cpuHotspots: [],
    memoryLeaks: [],
  })),
}));

import { analyzeNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeApi(wallClockStartMs: number | null): NativeProfilerSessionApi {
  return {
    deviceId: "ios-sim",
    platform: "ios",
    appProcess: "MyApp",
    capturePid: null,
    cpuFilterPid: null,
    recordingMallocStackLogging: null,
    mallocStackLogging: null,
    captureProcess: null,
    traceFile: "/tmp/native-profiler-ios.trace",
    // null exporter paths → checkExportFileMissing short-circuits (no fs access);
    // the freshness note still renders in the all-clear header regardless.
    exportedFiles: { cpu: null, hangs: null, leaks: null },
    profilingActive: false,
    wallClockStartMs,
    parsedData: null,
    recordingTimeout: null,
    recordingTimedOut: false,
    recordingExitedUnexpectedly: false,
    lastExitInfo: null,
    androidOnDeviceTracePath: null,
  };
}

// Regression for PR #340 review: the iOS analyze path uses the same session api
// and renderer as Android but previously did not forward the freshness note, so
// a trace reused from an earlier session never got flagged on iOS.
describe("analyzeNativeProfilerIos — freshness note wiring", () => {
  it("emits the stale-trace warning when wallClockStartMs is from an earlier session", async () => {
    const { report } = await analyzeNativeProfilerIos(makeApi(Date.now() - DAY_MS));
    expect(report).toContain("Stale trace");
  });

  it("omits the warning for a freshly-started recording", async () => {
    const { report } = await analyzeNativeProfilerIos(makeApi(Date.now()));
    expect(report).not.toContain("Stale trace");
  });

  it("omits the warning when the start time is unknown (null)", async () => {
    const { report } = await analyzeNativeProfilerIos(makeApi(null));
    expect(report).not.toContain("Stale trace");
  });
});
