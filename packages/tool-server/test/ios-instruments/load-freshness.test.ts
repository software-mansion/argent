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

  it("clears a previous live capture's mallocStackLogging on load (the loaded trace's mode is unknown)", async () => {
    // Same staleness class as wallClockStartMs, but this one IS resettable at
    // load time: a live malloc_stack_logging capture stamps the session flag,
    // and the raw_*.xml carry no capture-mode sidecar — so restoring an OLDER
    // session must clear the flag, or analyze/combined-report would attribute
    // the loaded trace to the previous session's capture mode.
    const api = await buildIosSession();
    api.mallocStackLogging = true; // what native-profiler-start(malloc) leaves behind

    const cpuXml = join(tempDir, `native-profiler-${SESSION_ID}_raw_cpu.xml`);
    await writeFile(cpuXml, "<trace-query-result></trace-query-result>", "utf8");
    await profilerLoadTool.execute({ session: api } as never, {
      mode: "load_native",
      session_id: SESSION_ID,
      port: 8081,
      device_id: "ios-sim",
    });

    expect(api.mallocStackLogging).toBeNull();
  });
});
