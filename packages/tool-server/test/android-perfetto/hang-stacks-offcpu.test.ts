import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mock harness as hang-severity.test.ts: runTpQuery is fed a queue of
// { name, rows } popped in call order so each drill-down query gets its fixture.
const queryResponses: Array<{ name: string; rows: unknown[] }> = [];

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
  runTpQuery: vi.fn(async (opts: { query: string }) => {
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    if (next.name !== opts.query) {
      throw new Error(`runTpQuery expected "${next.name}" but got "${opts.query}"`);
    }
    return next.rows;
  }),
}));

import { runAndroidStackQuery } from "../../src/utils/android-profiler/pipeline/index";

const MS = 1_000_000;

describe("hang_stacks — off-CPU explanation", () => {
  beforeEach(() => {
    queryResponses.length = 0;
  });

  it("explains an empty sample set as a wait when the thread was sleeping", async () => {
    queryResponses.push(
      {
        name: "ui-hangs.sql",
        rows: [{ kind: "jank", ts_ns: 0, dur_ns: 48 * MS, reason: "App Deadline Missed" }],
      },
      // hang-state-breakdown: 44ms sleeping, 4ms running.
      {
        name: "hang-state-breakdown.sql",
        rows: [
          { state: "S", blocked_function: null, total_dur_ns: 44 * MS, occurrences: 1 },
          { state: "Running", blocked_function: null, total_dur_ns: 4 * MS, occurrences: 1 },
        ],
      },
      // hang-main-thread-samples: none captured (off-CPU).
      { name: "hang-main-thread-samples.sql", rows: [] }
    );

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "hang_stacks",
      appPackage: "com.example.app",
      hangIndex: 0,
      topN: 15,
    });

    expect(out).toContain("Main-thread State Breakdown");
    // The key fix: an empty sample set is explained, not silently omitted.
    expect(out).toMatch(/No on-CPU stack samples/);
    expect(out).toMatch(/wait/);
    expect(out).toContain("`S`");
  });

  it("does not dangle an 'above' reference when no state breakdown was captured", async () => {
    queryResponses.push(
      {
        name: "ui-hangs.sql",
        rows: [{ kind: "jank", ts_ns: 0, dur_ns: 48 * MS, reason: "App Deadline Missed" }],
      },
      // hang-state-breakdown: empty → no "Main-thread State Breakdown" header.
      { name: "hang-state-breakdown.sql", rows: [] },
      // hang-main-thread-samples: also empty (off-CPU).
      { name: "hang-main-thread-samples.sql", rows: [] }
    );

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "hang_stacks",
      appPackage: "com.example.app",
      hangIndex: 0,
      topN: 15,
    });

    // The empty result is still explained...
    expect(out).toMatch(/No on-CPU stack samples/);
    // ...but there is no state breakdown above, so it must not be referenced.
    expect(out).not.toContain("Main-thread State Breakdown");
    expect(out).not.toMatch(/breakdown above|state breakdown above/);
  });

  it("renders the on-CPU stacks when samples exist", async () => {
    queryResponses.push(
      {
        name: "ui-hangs.sql",
        rows: [{ kind: "jank", ts_ns: 0, dur_ns: 60 * MS, reason: "App Deadline Missed" }],
      },
      {
        name: "hang-state-breakdown.sql",
        rows: [{ state: "Running", blocked_function: null, total_dur_ns: 55 * MS, occurrences: 1 }],
      },
      {
        name: "hang-main-thread-samples.sql",
        rows: [
          { ts_ns: 1 * MS, callstack_text: "doWork <- main" },
          { ts_ns: 2 * MS, callstack_text: "doWork <- main" },
        ],
      }
    );

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "hang_stacks",
      appPackage: "com.example.app",
      hangIndex: 0,
      topN: 15,
    });

    expect(out).toContain("Main-thread Samples During Hang");
    expect(out).toContain("doWork <- main");
    expect(out).toMatch(/\(2×\)/);
    expect(out).not.toMatch(/No on-CPU stack samples/);
  });
});
