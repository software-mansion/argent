import { describe, it, expect, vi, beforeEach } from "vitest";

// Each test plans the queries it expects in order and the mock pops them.
const queryResponses: Array<{ name: string; rows: unknown[] }> = [];
const substitutionsSeen: Array<{ query: string; substitutions: Record<string, string> }> = [];

vi.mock("@argent/native-devtools-android", () => ({
  traceProcessorShellPath: () => "/fake/tp",
  traceProcessorShellAvailable: () => true,
}));
vi.mock("../../src/utils/android-profiler/pipeline/run-tp", () => ({
  runTpQuery: vi.fn(async (opts: { query: string; substitutions: Record<string, string> }) => {
    substitutionsSeen.push({ query: opts.query, substitutions: opts.substitutions });
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    if (next.name !== opts.query) {
      throw new Error(
        `runTpQuery expected to be called for "${next.name}" but got "${opts.query}"`
      );
    }
    return next.rows;
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
    substitutionsSeen.length = 0;
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
      { name: "memory-rss.sql", rows: [] },
      { name: "hang-state-breakdown.sql", rows: [] },
      { name: "hang-gc-overlap.sql", rows: [] }
    );

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.uiHangs.length).toBe(1);
    const hang = result.uiHangs[0]!;
    // Trace-relative: 1_000_000_000 ns (1s) — NOT 5_001_000_000_000 (the native value)
    expect(hang.startNs).toBe(1_000_000_000);
    expect(hang.endNs).toBe(1_000_000_000 + HANG_DUR_NS);
  });

  it("passes the NATIVE-domain ns bounds to the per-hang state/gc queries", async () => {
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
      { name: "memory-rss.sql", rows: [] },
      { name: "hang-state-breakdown.sql", rows: [] },
      { name: "hang-gc-overlap.sql", rows: [] }
    );

    await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    const stateCall = substitutionsSeen.find((c) => c.query === "hang-state-breakdown.sql");
    const gcCall = substitutionsSeen.find((c) => c.query === "hang-gc-overlap.sql");
    expect(stateCall?.substitutions.HANG_START_NS).toBe(String(HANG_START_NATIVE));
    expect(stateCall?.substitutions.HANG_END_NS).toBe(String(HANG_START_NATIVE + HANG_DUR_NS));
    expect(gcCall?.substitutions.HANG_START_NS).toBe(String(HANG_START_NATIVE));
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
      { name: "memory-rss.sql", rows: [] },
      { name: "hang-state-breakdown.sql", rows: [] },
      { name: "hang-gc-overlap.sql", rows: [] }
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
      { name: "memory-rss.sql", rows: [] },
      { name: "hang-state-breakdown.sql", rows: [] },
      // GC slice in NATIVE ns — pipeline must normalise before fold
      {
        name: "hang-gc-overlap.sql",
        rows: [
          {
            gc_reason: "GC: concurrent copying",
            // 100ms after hang start, 200ms duration → 200ms overlap
            ts_ns: HANG_START_NATIVE + 100_000_000,
            dur_ns: 200_000_000,
          },
        ],
      }
    );

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.uiHangs[0]!.gcOverlapMs).toBe(200);
  });
});
