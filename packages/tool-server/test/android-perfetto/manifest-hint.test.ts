import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryResponses: Array<{ name: string; rows: unknown[] }> = [];

vi.mock("@argent/native-devtools-android", () => {
  const path = require("node:path");
  return {
    traceProcessorShellPath: () => "/fake/tp",
    // Real queries dir so the batched-fold path can load hang-folds-batched.sql.
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
  // Batched hang folds go through runTpInline — return no rows so every hang
  // gets an empty fold (this test only cares about the manifest-hint logic).
  runTpInline: vi.fn(async () => []),
  parseTpJsonOutput: vi.fn(),
}));

import { runAndroidProfilerPipeline } from "../../src/utils/android-profiler/pipeline/index";

describe("Android pipeline manifest hint", () => {
  beforeEach(() => {
    queryResponses.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits a manifest hint in exportErrors.cpu when zero CPU rows AND zero hang rows come back", async () => {
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: 0 }] },
      { name: "cpu-hotspots.sql", rows: [] },
      { name: "ui-hangs.sql", rows: [] },
      { name: "memory-rss.sql", rows: [] }
    );

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");

    expect(result.exportErrors.cpu).toBeDefined();
    expect(result.exportErrors.cpu).toContain("profileable");
    expect(result.exportErrors.cpu).toContain("com.example.app");
  });

  it("does NOT emit a manifest hint when hangs were found but CPU was empty", async () => {
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: 0 }] },
      { name: "cpu-hotspots.sql", rows: [] },
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "anr",
            ts_ns: 1_000_000_000,
            dur_ns: 100_000_000,
            process_name: "com.example.app",
            reason: "Input dispatching timed out",
            error_id: null,
          },
        ],
      },
      { name: "memory-rss.sql", rows: [] }
    );

    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");
    expect(result.exportErrors.cpu).toBeUndefined();
  });
});
