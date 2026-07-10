/**
 * Proof for PR #340 review comment 2 (hubgan, ios.ts:464):
 *
 * The iOS analyze path forwards `formatTraceFreshness(api.wallClockStartMs, …)`
 * exactly like Android, but `wallClockStartMs` is only ever set in-memory at
 * `native-profiler-start` (ios.ts) — iOS has NO on-disk metadata sidecar, and
 * the iOS branch of `profiler-load` never restores it. So when an old iOS
 * session is loaded from disk, `wallClockStartMs` stays `null` and the
 * stale-trace warning can never fire — the wiring is effective only for a live
 * session, which is fresh by construction.
 *
 * These tests pin that behavior: it must degrade cleanly (no crash, no
 * misleading output), NOT silently emit or suppress something wrong. If iOS
 * later grows real start-time persistence, the `wallClockStartMs` assertion
 * here is the canary that should be updated alongside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: vi.fn(),
  readCommitTree: vi.fn(),
}));

// The iOS load + analyze paths both parse xctrace XML off disk; stub the
// pipeline so this runs deterministically and isolates the freshness wiring.
vi.mock("../../src/utils/ios-profiler/pipeline/index", () => ({
  runIosProfilerPipeline: vi.fn(async () => ({
    bottlenecks: [],
    cpuSamples: [],
    uiHangs: [],
    cpuHotspots: [],
    memoryLeaks: [],
  })),
}));

import { getDebugDir } from "../../src/utils/react-profiler/debug/dump";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { analyzeNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";

const mockedGetDebugDir = vi.mocked(getDebugDir);
const SESSION_ID = "20200101-000000"; // deliberately ancient
const DAY_MS = 24 * 60 * 60 * 1000;

async function buildIosSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "ios-sim", platform: "ios" as const, kind: "simulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

describe("iOS profiler-load → analyze freshness wiring (PR #340 comment 2)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "argent-ios-load-freshness-"));
    mockedGetDebugDir.mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("leaves wallClockStartMs null after restoring an old iOS session (no sidecar exists)", async () => {
    const api = await buildIosSession();
    // The session API initializes wallClockStartMs to null; a real old session
    // captured days ago would be loaded fresh into this state.
    expect(api.wallClockStartMs).toBeNull();

    // iOS sessions persist only raw_*.xml — there is NO metadata.json sidecar to
    // carry a start time, unlike Android's .pftrace.metadata.json.
    const cpuXml = join(tempDir, `native-profiler-${SESSION_ID}_raw_cpu.xml`);
    await writeFile(cpuXml, "<trace-query-result></trace-query-result>", "utf8");

    await profilerLoadTool.execute({ session: api } as never, {
      mode: "load_native",
      session_id: SESSION_ID,
      port: 8081,
      device_id: "ios-sim",
    });

    // The load succeeded and parsed the XML into memory…
    expect(api.exportedFiles).toMatchObject({ cpu: cpuXml });
    // …but the start time was never restored: still null. THIS is why the
    // freshness note is dead on a loaded iOS session.
    expect(api.wallClockStartMs).toBeNull();

    // Drive analyze on the just-loaded session: the trace is "old" (loaded from
    // a 2020 session id) yet NO stale-trace warning is emitted, because the
    // start time the helper needs was never persisted.
    const { report } = await analyzeNativeProfilerIos(api);
    expect(report).not.toContain("Stale trace");
    // Sanity: analyze did produce a real report (degrades cleanly, no crash).
    expect(report).toContain("iOS Instruments Analysis");
  });

  it("a live iOS session WITH a start time still flags staleness (wiring is correct, just unreachable via load)", async () => {
    const api = await buildIosSession();
    // Simulate what native-profiler-start does in-process: stamp the start time.
    api.wallClockStartMs = Date.now() - 2 * DAY_MS;
    api.traceFile = join(tempDir, "live.trace");
    api.exportedFiles = { cpu: null, hangs: null, leaks: null };

    const { report } = await analyzeNativeProfilerIos(api);
    expect(report).toContain("Stale trace");
  });

  it("clears ALL of a previous live capture's per-capture residue on load", async () => {
    // The raw_*.xml carry no metadata sidecar, so nothing per-capture is known
    // about a loaded trace. A live capture earlier in the same process leaves
    // four fields behind, each of which would corrupt the loaded trace's
    // analyze if it survived: mallocStackLogging mislabels the
    // unattributed-leaks note, cpuFilterPid silently filters the loaded CPU
    // samples by a dead PID, wallClockStartMs fires the stale-trace note with
    // the wrong timestamp, and traceFile mislabels the report and writes the
    // .md over the OLD trace's report.
    const api = await buildIosSession();
    api.mallocStackLogging = true;
    api.cpuFilterPid = 4242;
    api.wallClockStartMs = Date.now() - 2 * DAY_MS;
    api.traceFile = join(tempDir, "previous-live.trace");

    const cpuXml = join(tempDir, `native-profiler-${SESSION_ID}_raw_cpu.xml`);
    await writeFile(cpuXml, "<trace-query-result></trace-query-result>", "utf8");
    await profilerLoadTool.execute({ session: api } as never, {
      mode: "load_native",
      session_id: SESSION_ID,
      port: 8081,
      device_id: "ios-sim",
    });

    expect(api.mallocStackLogging).toBeNull();
    expect(api.parsedData?.mallocStackLogging).toBeNull();
    expect(api.cpuFilterPid).toBeNull();
    expect(api.wallClockStartMs).toBeNull();
    expect(api.traceFile).toBeNull();

    // And analyze on the loaded session behaves like a fresh process: no
    // stale-trace note from the old capture's start time, no report mislabeled
    // with (or written next to) the old .trace.
    const { report, reportFile } = await analyzeNativeProfilerIos(api);
    expect(report).not.toContain("Stale trace");
    expect(report).not.toContain("previous-live.trace");
    expect(reportFile).toBeNull();
  });

  it("analyze refuses while a newer recording is in flight (would re-label the old exports)", async () => {
    // analyze re-runs the pipeline from api.exportedFiles using the LIVE
    // session fields — mid-recording those belong to the newer capture, so
    // the old exports would render under the new trace's name, freshness
    // anchor, and (on a degraded Xcode) the new capture's CPU filter PID.
    // Same contract as the profiler-load guard: stop first.
    const api = await buildIosSession();
    api.exportedFiles = { cpu: null, hangs: null, leaks: null };
    api.profilingActive = true;
    api.capturePid = 12345;
    api.traceFile = join(tempDir, "in-flight.trace");

    await expect(analyzeNativeProfilerIos(api)).rejects.toThrow(/native-profiler-stop first/);
  });

  it("analyze refuses while a crashed capture awaits its recovery export", async () => {
    const api = await buildIosSession();
    api.exportedFiles = { cpu: null, hangs: null, leaks: null };
    api.recordingExitedUnexpectedly = true;
    api.lastExitInfo = { code: 137, signal: "SIGKILL" };
    api.traceFile = join(tempDir, "crashed.trace");

    await expect(analyzeNativeProfilerIos(api)).rejects.toThrow(/native-profiler-stop first/);
  });

  it("refuses load_native while a recording is in flight (residue clearing would wedge the session)", async () => {
    // The residue clearing above nulls traceFile — with a live capture that
    // would make native-profiler-stop throw NO_ACTIVE_SESSION (its gate needs
    // traceFile) while native-profiler-start throws SESSION_ALREADY_RUNNING:
    // wedged both ways, and the in-flight capture is orphaned unexportable.
    // Loading must refuse up front and leave the live session untouched.
    const api = await buildIosSession();
    api.profilingActive = true;
    api.capturePid = 12345;
    api.captureProcess = { kill: vi.fn(), pid: 12345 } as never;
    api.traceFile = join(tempDir, "in-flight.trace");

    const cpuXml = join(tempDir, `native-profiler-${SESSION_ID}_raw_cpu.xml`);
    await writeFile(cpuXml, "<trace-query-result></trace-query-result>", "utf8");

    await expect(
      profilerLoadTool.execute({ session: api } as never, {
        mode: "load_native",
        session_id: SESSION_ID,
        port: 8081,
        device_id: "ios-sim",
      })
    ).rejects.toThrow(/native-profiler-stop first/);

    expect(api.traceFile).toBe(join(tempDir, "in-flight.trace"));
    expect(api.profilingActive).toBe(true);
  });

  it("refuses load_native while a crashed/timed-out capture awaits recovery export", async () => {
    // recordingTimedOut / recordingExitedUnexpectedly + traceFile is the state
    // stop's recovery branch exists for (export the partial trace). A load
    // nulling traceFile would make that export unreachable forever — the raw
    // .trace bundle cannot be re-ingested by profiler-load.
    const api = await buildIosSession();
    api.recordingExitedUnexpectedly = true;
    api.lastExitInfo = { code: 137, signal: "SIGKILL" };
    api.traceFile = join(tempDir, "crashed.trace");

    const cpuXml = join(tempDir, `native-profiler-${SESSION_ID}_raw_cpu.xml`);
    await writeFile(cpuXml, "<trace-query-result></trace-query-result>", "utf8");

    await expect(
      profilerLoadTool.execute({ session: api } as never, {
        mode: "load_native",
        session_id: SESSION_ID,
        port: 8081,
        device_id: "ios-sim",
      })
    ).rejects.toThrow(/native-profiler-stop first/);

    expect(api.traceFile).toBe(join(tempDir, "crashed.trace"));
    expect(api.recordingExitedUnexpectedly).toBe(true);
  });
});
