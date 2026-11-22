/**
 * A reloaded Mac app session must keep the notes of the live one. The raw_*.xml
 * exports hold none of the fields that the notes need, so profiler-load used to
 * clear them: a short recording with no leak then read "All clear", and the hangs
 * lost the part when the app was suspended. native-profiler-stop now saves those
 * fields next to the trace, and profiler-load restores them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

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
import {
  analyzeNativeProfilerIos,
  stopNativeProfilerIos,
} from "../../src/tools/profiler/native-profiler/platforms/ios";

const SESSION_ID = "20261117-090000";
const MS = 1_000_000;

async function buildSession(platform: "macos" | "ios"): Promise<NativeProfilerSessionApi> {
  const device =
    platform === "macos"
      ? { id: "macos-app-com.example.app", platform, kind: "app" as const }
      : { id: "11111111-2222-3333-4444-555555555555", platform, kind: "simulator" as const };
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
let hangsXml = "";
let wallStart = 0;

/** A hang of `durationMs` at 3.644 s of the trace. */
async function writeHangs(durationMs: number | null): Promise<void> {
  const rows =
    durationMs === null
      ? ""
      : `<row><start-time>${3_644 * MS}</start-time><duration>${durationMs * MS}</duration>` +
        `<hang-type>Severe Hang</hang-type><thread fmt="Main Thread"></thread></row>`;
  await writeFile(hangsXml, `<trace-query-result><node>${rows}</node></trace-query-result>`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "argent-load-mac-notes-"));
  vi.mocked(getDebugDir).mockResolvedValue(dir);
  traceFile = join(dir, `native-profiler-${SESSION_ID}.trace`);
  hangsXml = join(dir, `native-profiler-${SESSION_ID}_raw_hangs.xml`);
  wallStart = Date.now() - 60_000;
  await writeHangs(null);
  // A CPU table with no sample, and a Leaks table with no leak: the recording
  // checked for leaks and found none.
  const cpu = join(dir, `native-profiler-${SESSION_ID}_raw_cpu.xml`);
  await writeFile(cpu, `<trace-query-result><node></node></trace-query-result>`);
  const leaks = join(dir, `native-profiler-${SESSION_ID}_raw_leaks.xml`);
  await writeFile(leaks, `<trace-query-result><node></node></trace-query-result>`);
  vi.mocked(exportIosTraceData).mockResolvedValue({
    files: { cpu, hangs: hangsXml, leaks },
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
  await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** A recording that native-profiler-stop ends with SIGINT, `recordedMs` after its start. */
async function stoppedRecording(
  platform: "macos" | "ios",
  recordedMs: number
): Promise<NativeProfilerSessionApi> {
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
  const api = await buildSession(platform);
  api.profilingActive = true;
  api.captureProcess = child as unknown as ChildProcess;
  api.capturePid = child.pid;
  api.traceFile = traceFile;
  api.wallClockStartMs = Date.now() - recordedMs;
  api.recordingMallocStackLogging = false;
  await stopNativeProfilerIos(api);
  return api;
}

/** A Mac app recording that xctrace ended on its own, with a leak check from 3.7 s to 10 s. */
async function recoveredRecording(): Promise<NativeProfilerSessionApi> {
  const api = await buildSession("macos");
  api.traceFile = traceFile;
  api.recordingExitedUnexpectedly = true;
  api.lastExitInfo = { code: 0, signal: null };
  api.wallClockStartMs = wallStart;
  api.recordingMallocStackLogging = false;
  api.recordingAppEnded = true;
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
    { mode: "load_native", session_id: SESSION_ID, device_id: api.deviceId } as never
  );
}

describe("profiler-load keeps the notes of a Mac app session", () => {
  it("keeps the short-recording note, so a reloaded 2 s recording does not read all clear", async () => {
    const live = await stoppedRecording("macos", 2_000);
    const saved = JSON.parse(await readFile(`${traceFile}.metadata.json`, "utf8"));
    expect(saved).toEqual({
      appSuspensions: null,
      recordedMs: live.recordedMs,
      appEndedDuringCapture: false,
    });
    expect(live.recordedMs).toBeGreaterThanOrEqual(2_000);
    const { report: liveReport } = await analyzeNativeProfilerIos(live);
    expect(liveReport).toContain("the recording lasted only 2 s");

    const loaded = await buildSession("macos");
    await load(loaded);
    expect(loaded.recordedMs).toBe(live.recordedMs);
    const { report } = await analyzeNativeProfilerIos(loaded);
    expect(report).toContain("the recording lasted only 2 s");
    expect(report).toContain("but this trace can miss them");
    expect(report).not.toContain("All clear");
  });

  it("keeps the suspended part of each hang and the app-ended note", async () => {
    await writeHangs(13_827);
    const live = await recoveredRecording();
    expect(live.appSuspensions).toEqual([{ startNs: 3_700 * MS, endNs: 10_000 * MS }]);
    const notes = [
      "13827ms, 6300ms of it while the app was suspended (the app's own hang: 7527 to 13827ms)",
      "**The app ended during the recording:**",
      "**Leak-check pauses:** Instruments held the app suspended once (6.3 s)",
    ];
    const { report: liveReport } = await analyzeNativeProfilerIos(live);
    for (const note of notes) expect(liveReport).toContain(note);

    const loaded = await buildSession("macos");
    await load(loaded);
    expect(loaded.appSuspensions).toEqual(live.appSuspensions);
    expect(loaded.appEndedDuringCapture).toBe(true);
    // The load's own parse has the suspended part too, for profiler-stack-query.
    expect(loaded.parsedData?.uiHangs[0]?.suspendedMs).toBe(6_300);
    const { report } = await analyzeNativeProfilerIos(loaded);
    for (const note of notes) expect(report).toContain(note);
    expect(report).not.toContain("**Hangs and the leak check:**");
  });

  it("restores each saved field as it was saved", async () => {
    const saved = {
      appSuspensions: [{ startNs: 1 * MS, endNs: 2 * MS }],
      recordedMs: 12_345,
      appEndedDuringCapture: true,
    };
    await writeFile(`${traceFile}.metadata.json`, JSON.stringify(saved), "utf8");
    const loaded = await buildSession("macos");
    await load(loaded);
    expect({
      appSuspensions: loaded.appSuspensions,
      recordedMs: loaded.recordedMs,
      appEndedDuringCapture: loaded.appEndedDuringCapture,
    }).toEqual(saved);
  });

  it("loads a session with no metadata file as before", async () => {
    const loaded = await buildSession("macos");
    loaded.recordedMs = 1_000;
    loaded.appEndedDuringCapture = true;
    loaded.appSuspensions = [{ startNs: 1 * MS, endNs: 2 * MS }];
    await load(loaded);
    expect(loaded.recordedMs).toBeNull();
    expect(loaded.appEndedDuringCapture).toBe(false);
    expect(loaded.appSuspensions).toBeNull();
  });

  it("refuses a metadata file that is not valid", async () => {
    await writeFile(`${traceFile}.metadata.json`, "{ not json", "utf8");
    const err = await load(await buildSession("macos")).catch((e: unknown) => e);
    expect((err as Error).message).toContain("is not valid");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.PROFILER_NATIVE_METADATA_INVALID);
  });

  it("an iOS simulator stop saves no metadata file", async () => {
    await stoppedRecording("ios", 2_000);
    await expect(access(`${traceFile}.metadata.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
