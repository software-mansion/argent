import { describe, it, expect, vi, beforeEach } from "vitest";

// Top-level queries (cpu-hotspots, ui-hangs, memory-rss, trace-bounds) still
// flow through runTpQuery — each test plans the queries it expects in order
// and the mock pops them.
const queryResponses: Array<{ name: string; rows: unknown[] }> = [];

// The per-hang fold path now goes through runTpInline (one batched call),
// so we capture the rendered SQL and respond with a precanned row set.
const inlineCalls: Array<{ sql: string }> = [];
let inlineResponse: unknown[] = [];

vi.mock("@argent/native-devtools-android", () => {
  const path = require("node:path");
  return {
    traceProcessorShellPath: () => "/fake/tp",
    traceProcessorShellAvailable: () => true,
    // Real queries dir — runBatchedHangFolds loads hang-folds-batched.sql from
    // here and substitutes the windows/target before calling runTpInline.
    traceProcessorQueriesDir: () =>
      path.resolve(__dirname, "../../../native-devtools-android/queries"),
  };
});
vi.mock("../../src/utils/android-profiler/pipeline/run-tp", async (importActual) => ({
  // Keep the real renderSqlTemplate so the batched hang-fold path renders the
  // on-disk template; only the trace_processor_shell calls are stubbed.
  ...(await importActual<typeof import("../../src/utils/android-profiler/pipeline/run-tp")>()),
  runTpQuery: vi.fn(async (opts: { query: string; substitutions: Record<string, string> }) => {
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    if (next.name !== opts.query) {
      throw new Error(
        `runTpQuery expected to be called for "${next.name}" but got "${opts.query}"`
      );
    }
    return next.rows;
  }),
  runTpInline: vi.fn(async (opts: { sql: string }) => {
    inlineCalls.push({ sql: opts.sql });
    return inlineResponse;
  }),
  parseTpJsonOutput: vi.fn(),
}));

import { runAndroidProfilerPipeline } from "../../src/utils/android-profiler/pipeline/index";

const TRACE_START_NS = 5_000_000_000_000; // realistic monotonic-since-boot offset
const HANG_START_NATIVE = TRACE_START_NS + 1_000_000_000; // 1s into the trace
const HANG_DUR_NS = 500_000_000; // 500ms

describe("runAndroidProfilerPipeline timestamp normalisation", () => {
  beforeEach(() => {
    queryResponses.length = 0;
    inlineCalls.length = 0;
    inlineResponse = [];
  });

  it("subtracts trace_bounds.start_ts from hang ts before storing UiHang.startNs/endNs", async () => {
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: TRACE_START_NS }] },
      { name: "cpu-hotspots.sql", rows: [] },
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: HANG_START_NATIVE,
            dur_ns: HANG_DUR_NS,
            process_name: "com.example.app",
            reason: "AppDeadlineMissed",
            error_id: null,
          },
        ],
      },
      { name: "memory-rss.sql", rows: [] }
    );

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.uiHangs.length).toBe(1);
    const hang = result.uiHangs[0]!;
    // Trace-relative: 1_000_000_000 ns (1s) — NOT 5_001_000_000_000 (the native value)
    expect(hang.startNs).toBe(1_000_000_000);
    expect(hang.endNs).toBe(1_000_000_000 + HANG_DUR_NS);
  });

  it("inlines NATIVE-domain ns bounds into the batched hang-fold SQL", async () => {
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: TRACE_START_NS }] },
      { name: "cpu-hotspots.sql", rows: [] },
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: HANG_START_NATIVE,
            dur_ns: HANG_DUR_NS,
            process_name: "com.example.app",
            reason: "AppDeadlineMissed",
            error_id: null,
          },
        ],
      },
      { name: "memory-rss.sql", rows: [] }
    );

    await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(inlineCalls).toHaveLength(1);
    const sql = inlineCalls[0]!.sql;
    // The VALUES row for the single hang must carry the native (not
    // trace-relative) ns bounds, since the JOIN matches against thread_state.ts
    // and slice.ts, both of which are in the native CLOCK_MONOTONIC domain.
    expect(sql).toContain(String(HANG_START_NATIVE));
    expect(sql).toContain(String(HANG_START_NATIVE + HANG_DUR_NS));
    // And the negative-test: the trace-relative value (1s) must NOT appear as
    // a bound — that would mean we mixed domains and the JOIN finds nothing.
    expect(sql).not.toMatch(/,1000000000,1500000000\)/);
  });

  it("accepts trace_bounds.start_ts emitted as a JSON string (tp version drift)", async () => {
    queryResponses.push(
      // String-typed start_ts mimics a hypothetical future tp version that
      // emits 64-bit ns values as strings to avoid JS-number precision loss.
      { name: "trace-bounds.sql", rows: [{ start_ts: String(TRACE_START_NS) }] },
      { name: "cpu-hotspots.sql", rows: [] },
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: HANG_START_NATIVE,
            dur_ns: HANG_DUR_NS,
            process_name: "com.example.app",
            reason: null,
            error_id: null,
          },
        ],
      },
      { name: "memory-rss.sql", rows: [] }
    );

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");
    // If string coercion silently failed, the test would see startNs=HANG_START_NATIVE (5e12).
    expect(result.uiHangs[0]!.startNs).toBe(1_000_000_000);
  });

  it("computes gcOverlapMs against trace-relative hang bounds (no domain mix-up)", async () => {
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: TRACE_START_NS }] },
      { name: "cpu-hotspots.sql", rows: [] },
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: HANG_START_NATIVE,
            dur_ns: HANG_DUR_NS,
            process_name: "com.example.app",
            reason: null,
            error_id: null,
          },
        ],
      },
      { name: "memory-rss.sql", rows: [] }
    );
    // The batched-fold call returns the GC slice in NATIVE ns — the pipeline
    // must normalise to trace-relative before handing it to foldHangAnnotations.
    inlineResponse = [
      {
        hang_index: 0,
        row_kind: "gc",
        state_v: null,
        blocked_function_v: null,
        total_dur_ns_v: null,
        occurrences_v: null,
        gc_reason_v: "GC: concurrent copying",
        // 100ms after hang start, 200ms duration → 200ms overlap
        gc_ts_ns_v: String(HANG_START_NATIVE + 100_000_000),
        gc_dur_ns_v: String(200_000_000),
      },
    ];

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.uiHangs[0]!.gcOverlapMs).toBe(200);
  });
});
