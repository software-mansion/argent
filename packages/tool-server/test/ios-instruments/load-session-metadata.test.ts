/**
 * A reloaded iOS or Mac app session must report as the live one did. The
 * raw_*.xml exports carry none of the capture's own fields, so profiler-load
 * used to leave them empty: profiler-combined-report then failed with "Missing
 * wall-clock anchor from native profiler", and a Mac app's hangs kept the time
 * the app was suspended. native-profiler-stop now saves those fields next to the
 * trace, and profiler-load restores them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";

vi.mock("../../src/utils/react-profiler/debug/dump", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDebugDir: vi.fn(),
}));
vi.mock("../../src/utils/ios-profiler/export", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  exportIosTraceData: vi.fn(),
}));
// The stall watch of a Mac app's stop: an xctrace that ends on SIGINT never needs it.
vi.mock("../../src/tools/profiler/native-profiler/platforms/xctrace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  xctraceProgressProbe: vi.fn(() => async () => "0:01.20|4096"),
}));

import { getDebugDir } from "../../src/utils/react-profiler/debug/dump";
import { exportIosTraceData } from "../../src/utils/ios-profiler/export";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";
import {
  analyzeNativeProfilerIos,
  stopNativeProfilerIos,
} from "../../src/tools/profiler/native-profiler/platforms/ios";

const SESSION_ID = "20261113-135245";
const DEVICE = "macos-app-com.example.app";
const PORT = 8081;
const MS = 1_000_000;

async function buildMacSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: DEVICE, platform: "macos" as const, kind: "app" as const };
  const instance = await nativeProfilerSessionBlueprint.factory(
    {},
    device as never,
    {
      device,
    } as never
  );
  return instance.api;
}

let dir = "";
let traceFile = "";
let wallStart = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "argent-load-session-metadata-"));
  vi.mocked(getDebugDir).mockResolvedValue(dir);
  traceFile = join(dir, `native-profiler-${SESSION_ID}.trace`);
  wallStart = Date.now() - 60_000;
  // A hang at 3.644 s of 13.827 s, 6.3 s of it a leak check from 3.7 s to 10 s.
  const hangs = join(dir, `native-profiler-${SESSION_ID}_raw_hangs.xml`);
  await writeFile(
    hangs,
    `<trace-query-result><node><row><start-time>${3_644 * MS}</start-time>` +
      `<duration>${13_827 * MS}</duration><hang-type>Severe Hang</hang-type>` +
      `<thread fmt="Main Thread"></thread></row></node></trace-query-result>`
  );
  const leaks = join(dir, `native-profiler-${SESSION_ID}_raw_leaks.xml`);
  await writeFile(leaks, `<trace-query-result><node></node></trace-query-result>`);
  vi.mocked(exportIosTraceData).mockResolvedValue({
    files: { cpu: null, hangs, leaks },
    diagnostics: {
      tocSchemas: [],
      cpuSchemaUsed: null,
      errors: {},
      traceStartMs: wallStart - 1_500,
      traceDurationMs: 30_000,
    },
  });
});

afterEach(async () => {
  clearCachedProfilerPaths(PORT, DEVICE);
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** A Mac app recording that xctrace ended on its own, recovered by the stop. */
async function stoppedLiveSession(): Promise<NativeProfilerSessionApi> {
  const api = await buildMacSession();
  api.traceFile = traceFile;
  api.recordingExitedUnexpectedly = true;
  api.lastExitInfo = { code: 0, signal: null };
  api.wallClockStartMs = wallStart;
  api.recordingMallocStackLogging = true;
  // The watch's leak check, in wall-clock ms: 3.7 s to 10 s of the trace.
  const traceStart = wallStart - 1_500;
  api.suspensionWatch = {
    end: () => [{ startMs: traceStart + 3_700, endMs: traceStart + 10_000 }],
  } as never;
  await stopNativeProfilerIos(api);
  return api;
}

async function load(api: NativeProfilerSessionApi): Promise<string> {
  return profilerLoadTool.execute(
    { session: api } as never,
    {
      mode: "load_native",
      session_id: SESSION_ID,
      device_id: DEVICE,
    } as never
  );
}

const withoutAnalyzedTime = (report: string) =>
  report.replace(/\*\*Analyzed:\*\* \S+/, "**Analyzed:** <time>");

describe("profiler-load restores an xctrace session's own fields", () => {
  it("the stop saves them next to the trace", async () => {
    const live = await stoppedLiveSession();
    const saved = JSON.parse(await readFile(`${traceFile}.metadata.json`, "utf8"));
    expect(saved).toEqual({
      wallClockStartMs: wallStart,
      cpuFilterPid: null,
      mallocStackLogging: true,
      appSuspensions: live.appSuspensions,
      recordedMs: null,
      appEndedDuringCapture: false,
    });
    expect(live.appSuspensions).toEqual([{ startNs: 3_700 * MS, endNs: 10_000 * MS }]);
  });

  it("a reloaded session analyzes to the live session's report", async () => {
    const live = await stoppedLiveSession();
    const { report: liveReport, reportFile: liveReportFile } = await analyzeNativeProfilerIos(live);

    const loaded = await buildMacSession();
    await load(loaded);
    expect(loaded.wallClockStartMs).toBe(wallStart);
    expect(loaded.mallocStackLogging).toBe(true);
    expect(loaded.appSuspensions).toEqual(live.appSuspensions);
    expect(loaded.parsedData?.uiHangs[0]?.suspendedMs).toBeGreaterThan(0);
    const { report: loadedReport, reportFile } = await analyzeNativeProfilerIos(loaded);

    expect(liveReport).toContain("not counting 6300ms when the app was suspended");
    expect(withoutAnalyzedTime(loadedReport)).toBe(withoutAnalyzedTime(liveReport));
    // As exact as the live report, so it may take its place.
    expect(reportFile).toBe(liveReportFile);
    expect(reportFile).toBe(join(dir, `native-profiler-${SESSION_ID}-report.md`));
  });

  it("a reloaded Mac app session reports its leaks as the live session did", async () => {
    // The Time Profiler template on Xcode 26.6: a leaks export with no Leaks detail.
    await writeFile(
      join(dir, `native-profiler-${SESSION_ID}_raw_leaks.xml`),
      "<trace-query-result></trace-query-result>"
    );
    const live = await stoppedLiveSession();
    await analyzeNativeProfilerIos(live);
    expect(live.parsedData?.leaksRecorded).toBe(false);

    const loaded = await buildMacSession();
    const loadResult = await load(loaded);
    expect(loaded.parsedData?.leaksRecorded).toBe(false);
    expect(loadResult).toContain("- Memory leaks: not recorded");
  });

  it("a stop that ends the recording itself saves the recording's length", async () => {
    // xctrace that ends on SIGINT, as on a normal stop.
    const child = Object.assign(new EventEmitter(), {
      pid: 7373,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string) {
        queueMicrotask(() => {
          child.signalCode = signal;
          child.emit("exit", null, signal);
        });
        return true;
      },
    });
    const api = await buildMacSession();
    api.profilingActive = true;
    api.captureProcess = child as unknown as ChildProcess;
    api.capturePid = child.pid;
    api.traceFile = traceFile;
    api.wallClockStartMs = Date.now() - 20_000;
    api.recordingMallocStackLogging = false;
    await stopNativeProfilerIos(api);

    const saved = JSON.parse(await readFile(`${traceFile}.metadata.json`, "utf8"));
    expect(saved.wallClockStartMs).toBe(api.wallClockStartMs);
    expect(saved.mallocStackLogging).toBe(false);
    expect(saved.recordedMs).toBe(api.recordedMs);
    expect(saved.recordedMs).toBeGreaterThanOrEqual(20_000);
  });

  it("profiler-combined-report works on a reloaded session", async () => {
    await stoppedLiveSession();
    const loaded = await buildMacSession();
    await load(loaded);

    const commitsPath = join(dir, `react-profiler-${SESSION_ID}_commits.json`);
    const commit = {
      commitIndex: 0,
      timestamp: 3_000,
      componentName: "MyComp",
      actualDuration: 500,
      selfDuration: 500,
      commitDuration: 500,
      didRender: true,
      changeDescription: null,
    };
    await writeFile(
      commitsPath,
      JSON.stringify({ commits: [commit], meta: { profileStartWallMs: wallStart + 500 } })
    );
    cacheProfilerPaths(
      PORT,
      {
        sessionId: SESSION_ID,
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

    const report = (await profilerCombinedReportTool.execute({ nativeSession: loaded } as never, {
      port: PORT,
      device_id: DEVICE,
    })) as string;
    expect(report).toContain("**Clock offset:** React started 0.5s after native profiler");
  });

  it("restores each saved field as it was saved", async () => {
    const saved = {
      wallClockStartMs: wallStart,
      cpuFilterPid: 4242,
      mallocStackLogging: true,
      appSuspensions: [{ startNs: 1 * MS, endNs: 2 * MS }],
      recordedMs: 12_345,
      appEndedDuringCapture: true,
    };
    await writeFile(`${traceFile}.metadata.json`, JSON.stringify(saved), "utf8");
    const loaded = await buildMacSession();
    await load(loaded);
    expect({
      wallClockStartMs: loaded.wallClockStartMs,
      cpuFilterPid: loaded.cpuFilterPid,
      mallocStackLogging: loaded.mallocStackLogging,
      appSuspensions: loaded.appSuspensions,
      recordedMs: loaded.recordedMs,
      appEndedDuringCapture: loaded.appEndedDuringCapture,
    }).toEqual(saved);
    expect(loaded.parsedData?.mallocStackLogging).toBe(true);
    expect(loaded.parsedData?.wallClockStartMs).toBe(wallStart);
  });

  it("refuses a metadata file that is not valid", async () => {
    await writeFile(`${traceFile}.metadata.json`, "{ not json", "utf8");
    await expect(load(await buildMacSession())).rejects.toMatchObject({
      message: expect.stringContaining("is not valid"),
    });
  });
});
