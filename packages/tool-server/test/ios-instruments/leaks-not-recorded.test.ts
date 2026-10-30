/**
 * A trace with no leaks export must not read as leak-free.
 *
 * The all-processes capture fallback records the built-in Time Profiler template,
 * which has no Leaks instrument, so stop exports no leaks file. The reports used to
 * treat that like a capture with zero leaks: analyze said "All clear — no CPU
 * hotspots, UI hangs, or memory issues detected", leak_stacks said "No memory leaks
 * detected" and the combined report said "0 leaks". A capture whose template has
 * the Leaks instrument exports an empty table when nothing leaked, so a missing
 * export always means the leaks were not checked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import {
  LEAKS_NOT_RECORDED,
  renderNativeProfilerReport,
} from "../../src/utils/ios-profiler/render";
import type { ProfilerPayload, UiHang } from "../../src/utils/ios-profiler/types";

// Zero bottlenecks from the pipeline, so analyze takes the all-clear path.
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
import { renderLeakStacksIos } from "../../src/tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";

const DEVICE = "ios-sim";
const PORT = 8081;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-leaks-not-recorded-"));
});

afterEach(async () => {
  clearCachedProfilerPaths(PORT, DEVICE);
  await fs.rm(dir, { recursive: true, force: true });
});

async function buildIosSession(leaksFile: string | null): Promise<NativeProfilerSessionApi> {
  const device = { id: DEVICE, platform: "ios" as const, kind: "simulator" as const };
  const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  api.traceFile = path.join(dir, "native-profiler-ios.trace");
  // Null cpu/hangs paths short-circuit the missing-file checks; only the leaks
  // export decides whether leaks were recorded.
  const cpu = path.join(dir, "raw_cpu.xml");
  const hangs = path.join(dir, "raw_hangs.xml");
  await fs.writeFile(cpu, "");
  await fs.writeFile(hangs, "");
  api.exportedFiles = { cpu, hangs, leaks: leaksFile };
  return api;
}

const hang: UiHang = {
  type: "ui_hang",
  platform: "ios",
  hangType: "Hang",
  startNs: 1_000_000,
  endNs: 2_000_000,
  durationMs: 1,
  startTimeFormatted: "0:01",
  severity: "RED",
  suspectedFunctions: [],
  appCallChains: [],
};

describe("iOS reports when no leak data was recorded", () => {
  it("analyze says leaks were not checked instead of all clear", async () => {
    const api = await buildIosSession(null);
    const res = await analyzeNativeProfilerIos(api);

    expect(res.report).toContain(LEAKS_NOT_RECORDED);
    expect(res.report).not.toContain("memory issues detected");
    expect(res.report).toContain("No CPU hotspots or UI hangs detected.");
    // Not an export failure: CPU and hangs were analyzed.
    expect(res.status).toBe("ok");
    expect(res.exportErrors).toEqual({});
    expect(api.parsedData?.leaksRecorded).toBe(false);
  });

  it("analyze keeps the all-clear wording when the leaks table was exported", async () => {
    const leaks = path.join(dir, "raw_leaks.xml");
    await fs.writeFile(leaks, "");
    const api = await buildIosSession(leaks);
    const res = await analyzeNativeProfilerIos(api);

    expect(res.report).toContain("All clear — no CPU hotspots, UI hangs, or memory issues");
    expect(res.report).not.toContain(LEAKS_NOT_RECORDED);
    expect(api.parsedData?.leaksRecorded).toBe(true);
  });

  it("the full report flags leaks as not recorded in the header and summary", async () => {
    const payload: ProfilerPayload = {
      metadata: { traceFile: null, platform: "iOS", timestamp: "2026-10-30T00:00:00Z" },
      bottlenecks: [hang],
    };
    const res = await renderNativeProfilerReport({
      payload,
      traceFile: null,
      leaksRecorded: false,
    });

    expect(res.report).toContain(LEAKS_NOT_RECORDED);
    expect(res.report).toContain("| Memory Leaks | not recorded | — |");
  });

  it("leaves reports without the flag (Android) unchanged", async () => {
    const payload: ProfilerPayload = {
      metadata: { traceFile: null, platform: "Android", timestamp: "2026-10-30T00:00:00Z" },
      bottlenecks: [],
    };
    const res = await renderNativeProfilerReport({ payload, traceFile: null });

    expect(res.report).toContain("All clear — no CPU hotspots, UI hangs, or memory issues");
    expect(res.report).not.toContain(LEAKS_NOT_RECORDED);
  });

  it("leak_stacks says leaks were not checked instead of none detected", () => {
    const out = renderLeakStacksIos([], undefined, 10, null, false);
    expect(out).toContain(LEAKS_NOT_RECORDED);
    expect(out).not.toContain("No memory leaks detected");

    expect(renderLeakStacksIos([], undefined, 10, null, true)).toContain(
      "No memory leaks detected"
    );
  });

  it("the combined report says leaks were not recorded instead of 0 leaks", async () => {
    const commitsPath = path.join(dir, "commits.json");
    const commit = {
      commitIndex: 0,
      timestamp: 1000,
      componentName: "MyComp",
      actualDuration: 500,
      selfDuration: 500,
      commitDuration: 500,
      didRender: true,
      changeDescription: null,
    };
    await fs.writeFile(
      commitsPath,
      JSON.stringify({ commits: [commit], meta: { profileStartWallMs: 1_000_000 } })
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

    const api = await buildIosSession(null);
    api.parsedData = {
      cpuSamples: [],
      uiHangs: [hang],
      cpuHotspots: [],
      memoryLeaks: [],
      leaksRecorded: false,
      mallocStackLogging: null,
      wallClockStartMs: 1_000_000,
    };
    const out = (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
      port: PORT,
      device_id: DEVICE,
    })) as string;

    expect(out).toContain("**Native Profiler:** 1 hangs, leaks not recorded");
    expect(out).not.toContain("0 leaks");
  });
});
