import { describe, it, expect, vi, beforeEach } from "vitest";
const queryResponses: Array<{ name: string; rows: unknown[] }> = [];
let inlineResponse: unknown[] = [];
vi.mock("@argent/native-devtools-android", () => {
  const path = require("node:path");
  return {
    ensureTraceProcessorReady: vi.fn(async () => {}),
    traceProcessorQueriesDir: () =>
      path.resolve(__dirname, "../../native-devtools-android/assets/queries"),
  };
});
vi.mock("../src/utils/android-profiler/pipeline/run-tp", async (importActual) => ({
  ...(await importActual<typeof import("../src/utils/android-profiler/pipeline/run-tp")>()),
  runTpQuery: vi.fn(async (opts: { query: string }) => {
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    if (next.name !== opts.query) throw new Error(`expected "${next.name}" got "${opts.query}"`);
    return next.rows;
  }),
  runTpInline: vi.fn(async () => inlineResponse),
}));
import { runAndroidProfilerPipeline } from "../src/utils/android-profiler/pipeline/index";
const TRACE_START_NS = 9_100_000_000_000_000n; // ~105 days uptime, > 2^53
describe("android profiler pipeline handles bigint native-ns columns", () => {
  beforeEach(() => {
    queryResponses.length = 0;
    inlineResponse = [];
  });
  it("does not throw on a long-uptime (bigint ts) trace", async () => {
    expect(Number.isSafeInteger(Number(TRACE_START_NS))).toBe(false);
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: TRACE_START_NS }] },
      {
        name: "cpu-hotspots.sql",
        rows: [
          {
            thread_name: "main",
            is_main_thread: 1,
            leaf_function: "doFrame",
            leaf_mapping: "/system/lib64/libhwui.so",
            sample_count: 50,
            first_ts_ns: TRACE_START_NS + 1_000_000_000n,
            last_ts_ns: TRACE_START_NS + 2_000_000_000n,
            burst_windows: null,
            total_samples: 50,
          },
        ],
      },
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: TRACE_START_NS + 1_000_000_000n,
            dur_ns: 500_000_000,
            process_name: "com.example.app",
            reason: "App Deadline Missed",
            error_id: null,
          },
        ],
      },
      { name: "memory-rss.sql", rows: [] }
    );
    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");
    expect(result.uiHangs).toHaveLength(1);
    expect(result.cpuHotspots.length).toBeGreaterThan(0);
  });

  it("does not throw classifying severity for a bigint dur_ns hang with a combined reason", async () => {
    // classifyAndroidHangSeverity's own `row.dur_ns / 1_000_000` division is
    // only reached when `reason` isn't the exact "App Deadline Missed" string
    // (that branch short-circuits earlier) and `kind` isn't "anr" — a combined
    // reason like Perfetto's comma-joined form exercises it.
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: TRACE_START_NS }] },
      { name: "cpu-hotspots.sql", rows: [] },
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: TRACE_START_NS + 1_000_000_000n,
            dur_ns: TRACE_START_NS, // bigint — same magnitude source as ts_ns
            process_name: "com.example.app",
            reason: "Prediction Error, App Deadline Missed",
            error_id: null,
          },
        ],
      },
      { name: "memory-rss.sql", rows: [] }
    );
    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");
    expect(result.uiHangs).toHaveLength(1);
    expect(result.uiHangs[0]!.severity).toBe("RED");
  });
});
