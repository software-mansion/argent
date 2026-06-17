import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mock harness as function-callers.test.ts: runTpQuery is stubbed to pop
// planned responses in order (matched by query name), and we record each call so
// we can assert which .sql files ran and with what substitutions. No real
// .pftrace is ever touched.
const queryResponses: Array<{ name: string; rows: unknown[] }> = [];
const calls: Array<{ query: string; substitutions: Record<string, string> }> = [];

vi.mock("@argent/native-devtools-android", () => {
  const path = require("node:path");
  return {
    ensureTraceProcessorReady: vi.fn(async () => {}),
    traceProcessorQueriesDir: () =>
      path.resolve(__dirname, "../../../native-devtools-android/assets/queries"),
  };
});
vi.mock("../../src/utils/android-profiler/pipeline/run-tp", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/android-profiler/pipeline/run-tp")>()),
  runTpQuery: vi.fn(async (opts: { query: string; substitutions: Record<string, string> }) => {
    calls.push({ query: opts.query, substitutions: opts.substitutions });
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    if (next.name !== opts.query) {
      throw new Error(`runTpQuery expected "${next.name}" but got "${opts.query}"`);
    }
    return next.rows;
  }),
  runTpInline: vi.fn(async () => []),
  parseTpJsonOutput: vi.fn(),
}));

import { runAndroidStackQuery } from "../../src/utils/android-profiler/pipeline/index";

const PKG = "com.example.app";

beforeEach(() => {
  queryResponses.length = 0;
  calls.length = 0;
});

describe("hang_stacks mode (renderHangStacksAndroid)", () => {
  function jankRow(kind: "anr" | "jank", ts_ns: number, dur_ns: number, reason: string | null) {
    return { kind, ts_ns, dur_ns, process_name: PKG, reason, error_id: null };
  }

  it("renders state breakdown + deduped main-thread samples for a valid hang_index", async () => {
    queryResponses.push(
      {
        name: "ui-hangs.sql",
        rows: [jankRow("jank", 5_000_000, 250_000_000, "App Deadline Missed")],
      },
      {
        name: "hang-state-breakdown.sql",
        rows: [
          {
            state: "Uninterruptible Sleep",
            blocked_function: "do_page_fault",
            total_dur_ns: 180_000_000,
            occurrences: 3,
          },
          { state: "Runnable", blocked_function: null, total_dur_ns: 70_000_000, occurrences: 5 },
        ],
      },
      {
        name: "hang-main-thread-samples.sql",
        rows: [
          { ts_ns: 5_100_000, callstack_text: "main <- onDraw <- inflate" },
          { ts_ns: 5_200_000, callstack_text: "main <- onDraw <- inflate" },
          { ts_ns: 5_300_000, callstack_text: "main <- measure" },
          { ts_ns: 5_400_000, callstack_text: null },
        ],
      }
    );

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "hang_stacks",
      appPackage: PKG,
      hangIndex: 0,
      topN: 15,
    });

    expect(calls.map((c) => c.query)).toEqual([
      "ui-hangs.sql",
      "hang-state-breakdown.sql",
      "hang-main-thread-samples.sql",
    ]);
    // Header: hang #0, kind, duration in ms, and reason.
    expect(out).toContain("## Hang #0 — jank (250ms)");
    expect(out).toContain("reason: `App Deadline Missed`");
    // State breakdown table: ns → ms, null blocked_function → em dash.
    expect(out).toContain("### Main-thread State Breakdown");
    expect(out).toContain("| Uninterruptible Sleep | `do_page_fault` | 180ms |");
    expect(out).toContain("| Runnable | — | 70ms |");
    // Samples deduped by callstack_text; the null-callstack row is dropped, and
    // the repeated stack collapses into a single (2×) block.
    expect(out).toContain("### Main-thread Samples During Hang");
    expect(out).toContain("(2×)");
    expect(out).toContain("main <- onDraw <- inflate");
    expect(out).toContain("(1×)");
    expect(out).toContain("main <- measure");
  });

  it("returns the out-of-range guard message for an invalid hang_index without querying state/samples", async () => {
    queryResponses.push({
      name: "ui-hangs.sql",
      rows: [jankRow("jank", 5_000_000, 120_000_000, null)],
    });

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "hang_stacks",
      appPackage: PKG,
      hangIndex: 7,
      topN: 15,
    });

    // Only the hang list is queried; the guard returns before state/sample queries.
    expect(calls.map((c) => c.query)).toEqual(["ui-hangs.sql"]);
    expect(out).toBe("_Invalid hang_index 7. There are 1 hangs (0-indexed)._");
  });

  it("throws when hang_index is omitted (the parameter is required for hang_stacks)", async () => {
    await expect(
      runAndroidStackQuery({
        tracePath: "/fake.pftrace",
        mode: "hang_stacks",
        appPackage: PKG,
        topN: 15,
      })
    ).rejects.toThrow("hang_stacks mode requires the hang_index parameter.");
    // The guard runs before any query.
    expect(calls).toHaveLength(0);
  });
});

describe("thread_breakdown mode (renderThreadBreakdownAndroid)", () => {
  function threadRow(
    thread_name: string,
    sample_count: number,
    pct_of_app: number,
    is_main_thread: 0 | 1
  ) {
    return { thread_name, is_main_thread, sample_count, pct_of_app };
  }

  it("renders all threads as a table when no filter is given", async () => {
    queryResponses.push({
      name: "thread-breakdown.sql",
      rows: [threadRow(".blueskyweb.app", 4200, 70, 1), threadRow("FrameDecoderExe", 800, 13, 0)],
    });

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "thread_breakdown",
      appPackage: PKG,
      topN: 15,
    });

    expect(calls.map((c) => c.query)).toEqual(["thread-breakdown.sql"]);
    expect(out).toContain("## Thread CPU Breakdown");
    expect(out).not.toContain("filter:");
    expect(out).toContain("| .blueskyweb.app | 4200 | 70% | Yes |");
    expect(out).toContain("| FrameDecoderExe | 800 | 13% | — |");
  });

  it("applies a case-insensitive substring filter and labels it in the header", async () => {
    queryResponses.push({
      name: "thread-breakdown.sql",
      rows: [
        threadRow(".blueskyweb.app", 4200, 70, 1),
        threadRow("FrameDecoderExe", 800, 13, 0),
        threadRow("FrameDecoderExe-2", 200, 3, 0),
      ],
    });

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "thread_breakdown",
      appPackage: PKG,
      thread: "framedecoder",
      topN: 15,
    });

    expect(out).toContain('## Thread CPU Breakdown (filter: "framedecoder")');
    expect(out).toContain("| FrameDecoderExe | 800 | 13% | — |");
    expect(out).toContain("| FrameDecoderExe-2 | 200 | 3% | — |");
    // The non-matching main thread is excluded.
    expect(out).not.toContain(".blueskyweb.app");
  });

  it("returns the no-match message when a filter excludes every thread", async () => {
    queryResponses.push({
      name: "thread-breakdown.sql",
      rows: [threadRow(".blueskyweb.app", 4200, 70, 1)],
    });

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "thread_breakdown",
      appPackage: PKG,
      thread: "nosuchthread",
      topN: 15,
    });

    expect(out).toBe('_No samples found for thread matching "nosuchthread"._');
  });

  it("returns the no-CPU-samples message when the query yields no rows and no filter", async () => {
    queryResponses.push({ name: "thread-breakdown.sql", rows: [] });

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "thread_breakdown",
      appPackage: PKG,
      topN: 15,
    });

    expect(out).toBe("_No CPU samples available._");
  });

  it("caps the table at top_n rows", async () => {
    queryResponses.push({
      name: "thread-breakdown.sql",
      rows: [
        threadRow("thread-a", 100, 50, 0),
        threadRow("thread-b", 80, 40, 0),
        threadRow("thread-c", 20, 10, 0),
      ],
    });

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "thread_breakdown",
      appPackage: PKG,
      topN: 2,
    });

    expect(out).toContain("| thread-a | 100 | 50% | — |");
    expect(out).toContain("| thread-b | 80 | 40% | — |");
    expect(out).not.toContain("thread-c");
  });
});
