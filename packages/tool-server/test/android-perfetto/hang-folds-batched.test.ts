import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@argent/native-devtools-android", () => {
  const path = require("node:path");
  return {
    // Real queries dir — the batched module now loads the SQL from
    // queries/hang-folds-batched.sql and substitutes tokens into it, rather
    // than holding a SQL string literal. We assert against the rendered output.
    traceProcessorQueriesDir: () =>
      path.resolve(__dirname, "../../../native-devtools-android/assets/queries"),
  };
});

// Capture every SQL string the batched module passes to runTpInline so we
// can assert on the script's shape without standing up a real subprocess.
const inlineCalls: Array<{ sql: string; tracePath: string }> = [];
let inlineResponse: unknown[] = [];
let inlineError: Error | null = null;

vi.mock("../../src/utils/android-profiler/pipeline/run-tp", async (importActual) => ({
  // Keep the real renderSqlTemplate — the batched module renders the on-disk
  // template through it, and these tests assert on that rendered output.
  ...(await importActual<typeof import("../../src/utils/android-profiler/pipeline/run-tp")>()),
  runTpInline: vi.fn(async (opts: { sql: string; tracePath: string }) => {
    inlineCalls.push({ sql: opts.sql, tracePath: opts.tracePath });
    if (inlineError) throw inlineError;
    return inlineResponse;
  }),
  runTpQuery: vi.fn(),
}));

import { runBatchedHangFolds } from "../../src/utils/android-profiler/pipeline/hang-folds-batched";

describe("runBatchedHangFolds", () => {
  beforeEach(() => {
    inlineCalls.length = 0;
    inlineResponse = [];
    inlineError = null;
  });

  it("returns empty maps without invoking trace_processor_shell when the hang list is empty", async () => {
    const result = await runBatchedHangFolds({
      tracePath: "/fake.pftrace",
      target: "com.example.app",
      hangs: [],
    });
    expect(result.state.size).toBe(0);
    expect(result.gc.size).toBe(0);
    expect(inlineCalls).toHaveLength(0);
  });

  it("inlines every hang window as a VALUES tuple in a single SQL invocation", async () => {
    await runBatchedHangFolds({
      tracePath: "/fake.pftrace",
      target: "com.example.app",
      hangs: [
        { hangIndex: 0, startNs: 1_000_000_000, endNs: 1_500_000_000 },
        { hangIndex: 1, startNs: 2_000_000_000, endNs: 2_200_000_000 },
        { hangIndex: 2, startNs: 3_000_000_000, endNs: 3_400_000_000 },
      ],
    });

    expect(inlineCalls).toHaveLength(1);
    const sql = inlineCalls[0]!.sql;
    expect(sql).toContain("(0,1000000000,1500000000)");
    expect(sql).toContain("(1,2000000000,2200000000)");
    expect(sql).toContain("(2,3000000000,3400000000)");
    // CREATE PERFETTO TABLE is what holds the per-hang windows
    expect(sql).toContain("CREATE PERFETTO TABLE argent_hang_windows");
    // Two VIEWs feed the final UNION ALL — state breakdown + GC overlap
    expect(sql).toContain("CREATE PERFETTO VIEW argent_hang_state");
    expect(sql).toContain("CREATE PERFETTO VIEW argent_hang_gc");
    // TARGET_PROCESS token was substituted with the validated target — it now
    // lands once in the _argent_args view, and the body references it by name.
    expect(sql).toContain("'com.example.app' AS target_process");
    expect(sql).toContain("p.name = (SELECT target_process FROM _argent_args)");
    // The HANG_WINDOWS_VALUES placeholder must be fully replaced.
    expect(sql).not.toContain("HANG_WINDOWS_VALUES");
    expect(sql).not.toContain("TARGET_PROCESS");
    // Point 4: state durations are clipped to the hang window (overlap test +
    // MIN(end,end)-MAX(start,start)), not a raw SUM(ts.dur) over BETWEEN.
    expect(sql).toContain(
      "SUM(MIN(ts.ts + ts.dur, hw.end_ns) - MAX(ts.ts, hw.start_ns))"
    );
    expect(sql).toContain("ts.ts < hw.end_ns AND ts.ts + ts.dur > hw.start_ns");
  });

  it("scales the SQL linearly with hang count but stays in one invocation (regression for the 1013-hang case)", async () => {
    const hangs = Array.from({ length: 1013 }, (_, i) => ({
      hangIndex: i,
      startNs: 1_000_000_000 + i * 10_000_000,
      endNs: 1_000_000_000 + i * 10_000_000 + 16_000_000,
    }));

    await runBatchedHangFolds({
      tracePath: "/fake.pftrace",
      target: "com.example.app",
      hangs,
    });

    // The N+1 bug was "1 invocation per hang per query = 2026 invocations,
    // ~47 minutes serial." After the fix, the count must be ONE regardless
    // of hang count.
    expect(inlineCalls).toHaveLength(1);
    const sql = inlineCalls[0]!.sql;
    // First and last hang must both appear, proving nothing was truncated.
    expect(sql).toContain(`(0,${hangs[0]!.startNs},${hangs[0]!.endNs})`);
    expect(sql).toContain(`(1012,${hangs[1012]!.startNs},${hangs[1012]!.endNs})`);
  });

  it("demultiplexes state/gc rows by hang_index", async () => {
    inlineResponse = [
      {
        hang_index: 0,
        row_kind: "state",
        state_v: "Sleeping",
        blocked_function_v: "futex_wait",
        total_dur_ns_v: "400000000",
        occurrences_v: "1",
        gc_reason_v: null,
        gc_ts_ns_v: null,
        gc_dur_ns_v: null,
      },
      {
        hang_index: 0,
        row_kind: "state",
        state_v: "Running",
        blocked_function_v: null,
        total_dur_ns_v: "100000000",
        occurrences_v: "3",
        gc_reason_v: null,
        gc_ts_ns_v: null,
        gc_dur_ns_v: null,
      },
      {
        hang_index: 1,
        row_kind: "state",
        state_v: "Running",
        blocked_function_v: null,
        total_dur_ns_v: "200000000",
        occurrences_v: "1",
        gc_reason_v: null,
        gc_ts_ns_v: null,
        gc_dur_ns_v: null,
      },
      {
        hang_index: 0,
        row_kind: "gc",
        state_v: null,
        blocked_function_v: null,
        total_dur_ns_v: null,
        occurrences_v: null,
        gc_reason_v: "GC: concurrent copying",
        gc_ts_ns_v: "1100000000",
        gc_dur_ns_v: "200000000",
      },
    ];

    const result = await runBatchedHangFolds({
      tracePath: "/fake.pftrace",
      target: "com.example.app",
      hangs: [
        { hangIndex: 0, startNs: 1_000_000_000, endNs: 1_500_000_000 },
        { hangIndex: 1, startNs: 2_000_000_000, endNs: 2_200_000_000 },
      ],
    });

    expect(result.state.get(0)).toEqual([
      { state: "Sleeping", blocked_function: "futex_wait", total_dur_ns: 400_000_000, occurrences: 1 },
      { state: "Running", blocked_function: null, total_dur_ns: 100_000_000, occurrences: 3 },
    ]);
    expect(result.state.get(1)).toEqual([
      { state: "Running", blocked_function: null, total_dur_ns: 200_000_000, occurrences: 1 },
    ]);
    expect(result.gc.get(0)).toEqual([
      { gc_reason: "GC: concurrent copying", ts_ns: 1_100_000_000, dur_ns: 200_000_000 },
    ]);
    // Hang 1 had no GC rows — must not appear in the gc map at all.
    expect(result.gc.has(1)).toBe(false);
  });

  it("rejects a non-identifier-shaped process name (defence-in-depth against SQL injection)", async () => {
    await expect(
      runBatchedHangFolds({
        tracePath: "/fake.pftrace",
        target: "com.example.app'; DROP TABLE process; --",
        hangs: [{ hangIndex: 0, startNs: 1, endNs: 2 }],
      })
    ).rejects.toThrow(/non-identifier-shaped process name/);
    expect(inlineCalls).toHaveLength(0);
  });

  it("rejects non-integer or negative hang windows", async () => {
    await expect(
      runBatchedHangFolds({
        tracePath: "/fake.pftrace",
        target: "com.example.app",
        hangs: [{ hangIndex: 0, startNs: 1.5, endNs: 2 }],
      })
    ).rejects.toThrow(/non-integer\/negative hang window/);
    await expect(
      runBatchedHangFolds({
        tracePath: "/fake.pftrace",
        target: "com.example.app",
        hangs: [{ hangIndex: 0, startNs: -1, endNs: 2 }],
      })
    ).rejects.toThrow(/non-integer\/negative hang window/);
    expect(inlineCalls).toHaveLength(0);
  });

  it("propagates the underlying trace_processor_shell error verbatim", async () => {
    inlineError = new Error("trace_processor_shell: timed out after 60000ms");
    await expect(
      runBatchedHangFolds({
        tracePath: "/fake.pftrace",
        target: "com.example.app",
        hangs: [{ hangIndex: 0, startNs: 1, endNs: 2 }],
      })
    ).rejects.toThrow(/timed out after 60000ms/);
  });
});
