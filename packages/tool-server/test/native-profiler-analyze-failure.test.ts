/**
 * Bug 4 — `native-profiler-analyze` must not return "All clear" when every
 * trace_processor query failed. The result envelope must carry a machine-
 * readable `status` field (`"ok"` vs `"analysis_failed"`) plus the per-query
 * `exportErrors` so MCP / CLI callers can tell a truly clean trace apart from
 * a run where the analyzer itself blew up.
 *
 * Shape mirrors `native-profiler-missing-trace.test.ts`: stub the lowest-level
 * driver (`runTpQuery`) at the module boundary, then drive the analyze tool
 * with a synthetic session whose `exportedFiles.pftrace` points at a real
 * (empty-but-readable) file so the existence guard passes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

// Mocking runTpQuery is enough to control the entire Android pipeline output —
// `runAndroidProfilerPipeline` is just `Promise.allSettled` over three calls
// plus per-hang follow-ups. Any rejected promise becomes an `exportErrors`
// entry; resolved rows feed into the bottleneck transformers.
vi.mock("../src/utils/android-profiler/pipeline/run-tp", () => ({
  runTpQuery: vi.fn(),
  parseTpCsvOutput: vi.fn(),
}));

import { runTpQuery } from "../src/utils/android-profiler/pipeline/run-tp";
import { nativeProfilerAnalyzeTool } from "../src/tools/profiler/native-profiler/native-profiler-analyze";
import type { NativeProfilerSessionApi } from "../src/blueprints/native-profiler-session";

const runTpQueryMock = runTpQuery as unknown as ReturnType<typeof vi.fn>;

interface RunTpQueryOpts {
  tracePath: string;
  query: string;
  substitutions: Record<string, string>;
}

interface QueryRouter {
  "trace-bounds.sql"?: unknown[] | (() => Promise<unknown[]>);
  "cpu-hotspots.sql"?: unknown[] | (() => Promise<unknown[]>);
  "ui-hangs.sql"?: unknown[] | (() => Promise<unknown[]>);
  "memory-rss.sql"?: unknown[] | (() => Promise<unknown[]>);
}

function routeQueries(router: QueryRouter): void {
  runTpQueryMock.mockImplementation(async (opts: RunTpQueryOpts) => {
    const entry = router[opts.query as keyof QueryRouter];
    if (entry === undefined) {
      throw new Error(`unrecognized option: ${opts.query}`);
    }
    if (typeof entry === "function") return entry();
    return entry;
  });
}

async function buildSessionWithTrace(): Promise<{
  session: NativeProfilerSessionApi;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "native-profiler-failure-"));
  const tracePath = join(dir, "fake.pftrace");
  // Just needs to exist — runTpQuery is mocked, no real parsing happens.
  await writeFile(tracePath, "", "utf8");

  const session: NativeProfilerSessionApi = {
    deviceId: "emulator-5554",
    platform: "android",
    appProcess: "com.example.app",
    capturePid: null,
    captureProcess: null,
    traceFile: tracePath,
    exportedFiles: { pftrace: tracePath },
    profilingActive: false,
    wallClockStartMs: null,
    parsedData: null,
    recordingTimeout: null,
    recordingTimedOut: false,
    recordingExitedUnexpectedly: false,
    lastExitInfo: null,
    androidOnDeviceTracePath: null,
  };

  return {
    session,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("native-profiler-analyze: status + exportErrors envelope (Bug 4)", () => {
  beforeEach(() => {
    runTpQueryMock.mockReset();
  });

  it("status=ok with empty exportErrors when all queries succeed and find nothing", async () => {
    const { session, cleanup } = await buildSessionWithTrace();
    try {
      // Pipeline guards against a "blank" trace by synthesising a
      // `no CPU samples` exportError when BOTH cpu and hang queries return
      // zero rows (see pipeline/index.ts: the `<profileable>` hint). To test
      // the truly-clean case we feed one CPU row whose leaf_function is
      // null — the aggregator drops it, so we get bottlenecksTotal === 0
      // without tripping the fallback.
      routeQueries({
        "trace-bounds.sql": [{ start_ts: 0 }],
        "cpu-hotspots.sql": [
          {
            thread_name: "main",
            is_main_thread: 1,
            leaf_function: null,
            leaf_mapping: null,
            sample_count: 0,
            first_ts_ns: 0,
            last_ts_ns: 0,
            ts_array: "",
            total_samples: 0,
          },
        ],
        "ui-hangs.sql": [],
        "memory-rss.sql": [],
      });

      const result = await nativeProfilerAnalyzeTool.execute(
        { session },
        { device_id: "emulator-5554" }
      );

      expect(result.status).toBe("ok");
      expect(result.exportErrors).toEqual({});
      expect(result.bottlenecksTotal).toBe(0);
      // Renderer keeps the verbatim "All clear" sentence on the happy path.
      expect(result.report).toContain(
        "All clear — no CPU hotspots, UI hangs, or memory issues detected."
      );
      expect(result.report).not.toContain("Analysis failed");
    } finally {
      await cleanup();
    }
  });

  it("status=analysis_failed with per-query errors when every query rejects, and no 'All clear'", async () => {
    const { session, cleanup } = await buildSessionWithTrace();
    try {
      // trace-bounds.sql failure is swallowed by `getTraceStartNs` (returns 0)
      // so it does NOT land in exportErrors — that's by design. The three
      // pipeline queries are the ones the user-facing failure banner tracks.
      const reject = (q: string) => () =>
        Promise.reject(new Error(`unrecognized option: --query-output=json (${q})`));
      routeQueries({
        "trace-bounds.sql": reject("trace-bounds.sql"),
        "cpu-hotspots.sql": reject("cpu-hotspots.sql"),
        "ui-hangs.sql": reject("ui-hangs.sql"),
        "memory-rss.sql": reject("memory-rss.sql"),
      });

      const result = await nativeProfilerAnalyzeTool.execute(
        { session },
        { device_id: "emulator-5554" }
      );

      expect(result.status).toBe("analysis_failed");
      expect(result.bottlenecksTotal).toBe(0);
      expect(Object.keys(result.exportErrors).sort()).toEqual(["cpu", "hangs", "rss"]);
      expect(result.exportErrors.cpu).toMatch(/unrecognized option/);
      expect(result.exportErrors.hangs).toMatch(/unrecognized option/);
      expect(result.exportErrors.rss).toMatch(/unrecognized option/);

      // The misleading "All clear" line must not appear.
      expect(result.report).not.toContain(
        "All clear — no CPU hotspots, UI hangs, or memory issues detected."
      );
      // The new banner must appear, plus the existing Export-warnings block.
      expect(result.report).toContain("Analysis failed");
      expect(result.report).toContain("Export warnings");
    } finally {
      await cleanup();
    }
  });

  it("status=analysis_failed (partial) when only some queries fail but others return data", async () => {
    const { session, cleanup } = await buildSessionWithTrace();
    try {
      // CPU + hangs succeed, rss fails. The renderer's full-report path will
      // still produce a `## Summary` table because bottlenecksTotal > 0; the
      // envelope's `status` flips to analysis_failed regardless.
      routeQueries({
        "trace-bounds.sql": [{ start_ts: 0 }],
        "cpu-hotspots.sql": [
          {
            thread_name: "main",
            is_main_thread: 1,
            leaf_function: "doFrame",
            leaf_mapping: "libgui.so",
            sample_count: 50,
            first_ts_ns: 0,
            last_ts_ns: 500_000_000,
            ts_array: "0,10000000,20000000",
            total_samples: 500,
          },
        ],
        "ui-hangs.sql": [],
        "memory-rss.sql": () =>
          Promise.reject(new Error("unrecognized option: --query-output=json")),
      });

      const result = await nativeProfilerAnalyzeTool.execute(
        { session },
        { device_id: "emulator-5554" }
      );

      expect(result.status).toBe("analysis_failed");
      expect(Object.keys(result.exportErrors)).toEqual(["rss"]);
      expect(result.bottlenecksTotal).toBeGreaterThan(0);

      // Both the Export-warnings block AND the normal Summary table must
      // appear — the report is informative, not just a banner.
      expect(result.report).toContain("Export warnings");
      expect(result.report).toContain("## Summary");
      // No misleading "All clear" + no full-failure banner (because we have
      // real bottlenecks, the renderer never reaches the all-clear branch).
      expect(result.report).not.toContain(
        "All clear — no CPU hotspots, UI hangs, or memory issues detected."
      );
      expect(result.report).not.toContain("Analysis failed");
    } finally {
      await cleanup();
    }
  });
});
