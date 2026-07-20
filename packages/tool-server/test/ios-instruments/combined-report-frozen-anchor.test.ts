/**
 * Pass-5 finding 0: the iOS combined report used to anchor its FROZEN
 * parsedData hangs to the LIVE session wallClockStartMs. A capture started after
 * analyze re-stamps that live field, so re-running the report (e.g. the path the
 * in-flight guard's own recovery advice leads to) shifted every hang by the gap
 * between the two recordings' starts — a correlated hang silently became
 * "Hangs Without React Commit Match" and the clock offset was wrong.
 *
 * The fix freezes the recording's start time INTO parsedData at analyze, and the
 * report reads that frozen anchor for iOS. This test pins the invariant that
 * makes the whole class impossible: mutating the live wallClockStartMs (what a
 * later native-profiler-start does) must NOT change the correlation, because the
 * report no longer reads the live field.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
  type NativeProfilerParsedData,
} from "../../src/blueprints/native-profiler-session";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  type ProfilerSessionPaths,
} from "../../src/blueprints/react-profiler-session";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";

const DEVICE = "ios-sim";
const PORT = 8081;
const A_START = 1_000_000; // capture A's start wall-ms (== react start → 0.0s offset)
const GAP_MS = 120_000; // a later capture B started 120s after A

async function buildIosSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: DEVICE, platform: "ios" as const, kind: "simulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

// A hang at trace-relative 1000ms..2000ms, frozen with capture A's start.
function parsedDataA(): NativeProfilerParsedData {
  return {
    cpuSamples: [],
    uiHangs: [
      {
        type: "ui_hang",
        platform: "ios",
        hangType: "Hang",
        startNs: 1_000_000_000,
        endNs: 2_000_000_000,
        durationMs: 1000,
        startTimeFormatted: "0:01",
        severity: "RED",
        suspectedFunctions: [],
        appCallChains: [],
      },
    ],
    cpuHotspots: [],
    memoryLeaks: [],
    mallocStackLogging: true,
    wallClockStartMs: A_START, // frozen at analyze — the anchor that must be used
  };
}

async function writeReactCommits(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p5-frozen-anchor-"));
  const commitsPath = path.join(dir, "commits.json");
  const commit = {
    commitIndex: 0,
    timestamp: 1000, // react-clock ms; overlaps A's hang when anchored at A_START
    componentName: "MyComp",
    actualDuration: 500,
    selfDuration: 500,
    commitDuration: 500,
    didRender: true,
    changeDescription: null,
  };
  await fs.writeFile(
    commitsPath,
    JSON.stringify({ commits: [commit], meta: { profileStartWallMs: A_START } })
  );
  return commitsPath;
}

function cachePaths(commitsPath: string): void {
  const paths: ProfilerSessionPaths = {
    sessionId: "s",
    debugDir: path.dirname(commitsPath),
    cpuProfilePath: null,
    commitsPath,
    cpuSampleIndexPath: null,
    detectedArchitecture: null,
    anyCompilerOptimized: null,
    hotCommitIndices: [0],
    totalReactCommits: 1,
  };
  cacheProfilerPaths(PORT, paths, DEVICE);
}

async function run(api: NativeProfilerSessionApi): Promise<string> {
  return (await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
    port: PORT,
    device_id: DEVICE,
  })) as string;
}

const clockOffset = (s: string) => s.split("\n").find((l) => l.includes("Clock offset"));

describe("iOS combined-report frozen anchor (pass-5 finding 0)", () => {
  afterEach(() => clearCachedProfilerPaths(PORT, DEVICE));

  it("uses the anchor frozen in parsedData, so a re-stamped live wallClockStartMs cannot shift correlations", async () => {
    const commitsPath = await writeReactCommits();
    cachePaths(commitsPath);

    const api = await buildIosSession();
    api.parsedData = parsedDataA();
    api.wallClockStartMs = A_START;

    const before = await run(api);
    expect(before).toContain("↔ Commit #0");
    expect(before).not.toContain("Hangs Without React Commit Match");

    // Simulate the exact post-"start B then stop B" state: the live field is
    // re-stamped to B's start while parsedData (and its frozen anchor) stay on A.
    // Pre-fix this shifted the hang out of every commit window; post-fix the
    // frozen anchor makes the report byte-identical.
    api.wallClockStartMs = A_START + GAP_MS;
    const after = await run(api);

    expect(after).toContain("↔ Commit #0");
    expect(after).not.toContain("Hangs Without React Commit Match");
    expect(clockOffset(after)).toBe(clockOffset(before));
    expect(after).toBe(before);
  });
});
