import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mock harness as pipeline-offset.test.ts: the top-level queries flow
// through runTpQuery (planned in order, popped by the mock) and the batched
// hang-fold goes through runTpInline (no annotations needed here).
const queryResponses: Array<{ name: string; rows: unknown[] }> = [];
const inlineCalls: Array<{ sql: string }> = [];
let inlineResponse: unknown[] = [];

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
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    if (next.name !== opts.query) {
      throw new Error(`runTpQuery expected "${next.name}" but got "${opts.query}"`);
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

const TRACE_START_NS = 5_000_000_000_000;
const MS = 1_000_000;

// reason carries Perfetto's space-separated jank_type, exactly as ui-hangs.sql
// emits it (MAX(aft.jank_type), GLOB-filtered to include "App Deadline Missed").
function jank(reason: string | null, durMs: number, kind: "jank" | "anr" = "jank") {
  return {
    kind,
    ts_ns: TRACE_START_NS + 1_000_000_000,
    dur_ns: durMs * MS,
    process_name: "com.example.app",
    reason,
    error_id: null,
  };
}

describe("classifyAndroidHangSeverity (via pipeline)", () => {
  beforeEach(() => {
    queryResponses.length = 0;
    inlineCalls.length = 0;
    inlineResponse = [];
  });

  async function severityFor(...rows: ReturnType<typeof jank>[]) {
    queryResponses.push(
      { name: "trace-bounds.sql", rows: [{ start_ts: TRACE_START_NS }] },
      { name: "cpu-hotspots.sql", rows: [] },
      { name: "ui-hangs.sql", rows },
      { name: "memory-rss.sql", rows: [] }
    );
    const result = await runAndroidProfilerPipeline("/fake.pftrace", "com.example.app");
    return result.uiHangs.map((h) => h.severity);
  }

  it("classifies a standalone short App Deadline Missed frame as RED (the regression)", async () => {
    // 133ms, well under the 500ms duration gate — RED comes purely from the
    // reason. This is the case the no-space "AppDeadlineMissed" literal missed.
    expect(await severityFor(jank("App Deadline Missed", 133))).toEqual(["RED"]);
  });

  it("keeps a short comma-combined frame YELLOW (shared blame, below duration gate)", async () => {
    expect(await severityFor(jank("Prediction Error, App Deadline Missed", 133))).toEqual([
      "YELLOW",
    ]);
  });

  it("escalates a long comma-combined frame to RED via the duration gate", async () => {
    expect(await severityFor(jank("Buffer Stuffing, App Deadline Missed", 600))).toEqual(["RED"]);
  });

  it("always classifies ANRs as RED regardless of reason/duration", async () => {
    expect(await severityFor(jank("Input dispatching timed out", 5000, "anr"))).toEqual(["RED"]);
  });
});
