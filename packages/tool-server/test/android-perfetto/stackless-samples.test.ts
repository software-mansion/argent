import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryResponses: Array<{ name: string; rows: unknown[] }> = [];

vi.mock("@argent/native-devtools-android", () => {
  const path = require("node:path");
  return {
    ensureTraceProcessorReady: vi.fn(async () => {}),
    traceProcessorQueriesDir: () =>
      path.resolve(__dirname, "../../../native-devtools-android/assets/queries"),
  };
});
vi.mock("../../src/utils/android-profiler/pipeline/run-tp", () => ({
  runTpQuery: vi.fn(async (opts: { query: string }) => {
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    return next.rows;
  }),
  runTpInline: vi.fn(async () => []),
}));

import { runAndroidProfilerPipeline } from "../../src/utils/android-profiler/pipeline/index";

/**
 * A cpu-hotspots.sql row for a thread whose samples carried no usable stack.
 * `leaf_mapping` is what separates "nothing was ever unwound" (null) from
 * "unwound, but no symbol" (a module path).
 */
function stacklessRow(threadName: string, sampleCount: number, leafMapping: string | null = null) {
  return {
    thread_name: threadName,
    is_main_thread: 0,
    leaf_function: null,
    leaf_mapping: leafMapping,
    sample_count: sampleCount,
    first_ts_ns: 0,
    last_ts_ns: 1_000_000,
    total_samples: sampleCount,
    burst_windows: "0:1:1",
  };
}

function namedRow(fn: string, sampleCount: number) {
  return {
    thread_name: "RenderThread",
    is_main_thread: 0,
    leaf_function: fn,
    leaf_mapping: "/system/lib64/libhwui.so",
    sample_count: sampleCount,
    first_ts_ns: 0,
    last_ts_ns: 1_000_000,
    total_samples: sampleCount,
    burst_windows: "0:1:1",
  };
}

function queue(cpuRows: unknown[], hangRows: unknown[] = []) {
  queryResponses.push(
    { name: "trace-bounds.sql", rows: [{ start_ts: 0 }] },
    { name: "cpu-hotspots.sql", rows: cpuRows },
    { name: "ui-hangs.sql", rows: hangRows },
    { name: "memory-rss.sql", rows: [] }
  );
}

describe("Android pipeline — samples captured but no call stacks", () => {
  beforeEach(() => {
    queryResponses.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("explains an empty CPU section instead of leaving it silently absent", async () => {
    // The reported case: perf samples exist for the app (thread_breakdown counts
    // them) but every one is dropped for having no leaf function, so the report
    // read as though the app did no CPU work.
    queue([stacklessRow("RenderThread", 238), stacklessRow("main", 44)]);

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.cpuHotspots).toHaveLength(0);
    expect(result.cpuDiagnostic).toBeDefined();
    expect(result.cpuDiagnostic).toContain("282 CPU samples");
    expect(result.cpuDiagnostic).toContain("com.example.app");
    expect(result.cpuDiagnostic).toContain("not an idle app");
  });

  it("is not an exportErrors entry, so the report cannot claim a query errored", async () => {
    // exportErrors entries are counted as failed queries by the all-clear
    // banner ("N of 3 queries errored"). Nothing errored here.
    queue([stacklessRow("RenderThread", 100)]);

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.cpuDiagnostic).toBeDefined();
    expect(result.exportErrors).toEqual({});
  });

  it("blames profileability when no frame was unwound at all", async () => {
    queue([stacklessRow("RenderThread", 296, null)]);

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.cpuDiagnostic).toContain("profileable");
    expect(result.cpuDiagnostic).toContain("dumpsys package com.example.app");
    expect(result.cpuDiagnostic).not.toContain("stripped");
  });

  it("blames stripped symbols when frames were unwound but unnamed", async () => {
    // A mapping without a name means the stack WAS unwound — only the symbol is
    // missing, which is a different problem with a different fix.
    queue([stacklessRow("RenderThread", 296, "/data/app/lib/arm64/libapp.so")]);

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.cpuDiagnostic).toContain("stripped");
    expect(result.cpuDiagnostic).not.toContain("profileable");
  });

  it("says nothing when any sample carried a usable stack", async () => {
    // Healthy traces must be untouched — including partially stackless ones,
    // where a kernel leaf routinely fails to resolve.
    queue([namedRow("writel", 38), stacklessRow("main", 5)]);

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.cpuHotspots.length).toBeGreaterThan(0);
    expect(result.cpuDiagnostic).toBeUndefined();
  });

  it("leaves the no-samples-at-all case to the existing manifest hint", async () => {
    queue([], []);

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.cpuDiagnostic).toBeUndefined();
    expect(result.exportErrors.cpu).toContain("profileable");
  });

  it("still fires when the trace also has hangs", async () => {
    // The manifest hint is deliberately suppressed once hangs exist, because
    // "your app is not profileable" would be wrong advice for a traced app.
    // This diagnostic describes a different state and must not inherit that gate
    // — a real capture almost always has hangs.
    queue(
      [stacklessRow("RenderThread", 296)],
      [
        {
          kind: "jank",
          ts_ns: 1_000_000_000,
          dur_ns: 40_000_000,
          process_name: "com.example.app",
          reason: "App Deadline Missed",
          error_id: null,
        },
      ]
    );

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.cpuDiagnostic).toBeDefined();
    expect(result.exportErrors.cpu).toBeUndefined();
  });
});
