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
import {
  runAndroidProfilerPipeline,
  runAndroidStackQuery,
} from "../src/utils/android-profiler/pipeline/index";
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
            // Forced > 2^53 bigint (mechanical guard). dur_ns is a bounded
            // duration, not uptime-scaled — TRACE_START_NS is reused here only
            // as a convenient > 2^53 value to exercise the coercion.
            dur_ns: TRACE_START_NS,
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

describe("android stack drill-down handles bigint native-ns columns", () => {
  beforeEach(() => {
    queryResponses.length = 0;
    inlineResponse = [];
  });

  it("renders the hang-stacks drill-down for a bigint ts_ns/dur_ns hang without throwing", async () => {
    // renderHangStacksAndroid reads the hang's own ts_ns/dur_ns and does
    // `startNs + dur_ns` and `dur_ns / 1_000_000`. ts_ns is an absolute
    // CLOCK_MONOTONIC value that crosses 2^53 after ~104 days of uptime, so it
    // decodes as bigint on a long-uptime device (see readCell). dur_ns is a
    // bounded duration (the ANR length or longest janky-frame slice), NOT
    // uptime-scaled — it would exceed 2^53 only if a single hang lasted ~104
    // days, so the bigint dur_ns forced below is a mechanical guard, not a
    // realistic value. readCell keeps any > 2^53 cell as bigint regardless, so
    // without the Number() coercions the arithmetic throws "Cannot mix BigInt
    // and other types". state total_dur_ns is a hang-window-clipped duration sum
    // (hang-state-breakdown.sql) that stays well under 2^53 in practice, but is
    // now coerced defensively too — the second state row below forces a bigint
    // to prove that read is robust.
    const HANG_TS_NS = TRACE_START_NS + 1_000_000_000n; // absolute, > 2^53
    // Mechanical guard: forced > 2^53 so it decodes as bigint. A real hang dur
    // is ms-scale; this value is not physically realistic.
    const HANG_DUR_NS = 9_500_000_000_000_000n;
    expect(Number.isSafeInteger(Number(HANG_TS_NS))).toBe(false);
    expect(Number.isSafeInteger(Number(HANG_DUR_NS))).toBe(false);
    const expectedDurationMs = Math.round(Number(HANG_DUR_NS) / 1_000_000);

    queryResponses.push(
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: HANG_TS_NS,
            dur_ns: HANG_DUR_NS,
            process_name: "com.example.app",
            reason: "App Deadline Missed",
            error_id: null,
          },
        ],
      },
      {
        name: "hang-state-breakdown.sql",
        rows: [
          {
            state: "Uninterruptible Sleep",
            blocked_function: "do_page_fault",
            total_dur_ns: 400_000_000, // Number: clipped duration sum, < 2^53
            occurrences: 3,
          },
          {
            // Defensive: force a bigint total_dur_ns (> 2^53). It can't happen
            // for a clipped sum in practice, but the read is coerced anyway, so
            // this must render rather than throw "Cannot mix BigInt".
            state: "Runnable",
            blocked_function: null,
            total_dur_ns: 9_600_000_000_000_000n,
            occurrences: 1,
          },
        ],
      },
      {
        name: "hang-main-thread-samples.sql",
        rows: [{ ts_ns: HANG_TS_NS + 500_000_000n, callstack_text: "main <- onDraw <- inflate" }],
      }
    );

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "hang_stacks",
      appPackage: "com.example.app",
      hangIndex: 0,
      topN: 15,
    });

    // (b) correct millisecond math from the bigint dur_ns in the header, and the
    // state row's Number ns → ms conversion, both survive the coercion.
    expect(out).toContain(`## Hang #0 — jank (${expectedDurationMs}ms)`);
    expect(out).toContain("reason: `App Deadline Missed`");
    expect(out).toContain("| Uninterruptible Sleep | `do_page_fault` | 400ms |");
    // The bigint total_dur_ns row rendered (coerced) instead of throwing.
    expect(out).toContain(
      `| Runnable | — | ${Math.round(Number(9_600_000_000_000_000n) / 1_000_000)}ms |`
    );
    expect(out).toContain("### Main-thread Samples During Hang");
    expect(out).toContain("main <- onDraw <- inflate");
  });

  it("renders the no-samples blocking fallback with a bigint state total_dur_ns without throwing", async () => {
    // The `uniqueStacks.size === 0` fallback (main thread off-CPU: no on-CPU
    // stack samples) reuses the same coerced stateBreakdown as the table, and
    // summarizeHangBlocking sorts it by durationMs. With no samples, the
    // hang-main-thread-samples.sql result is empty, so the fallback branch runs
    // — the one previously uncovered by the drill-down test above, which always
    // supplied a sample. Force a bigint state total_dur_ns to prove the fallback
    // path coerces it instead of throwing "Cannot mix BigInt and other types".
    const HANG_TS_NS = TRACE_START_NS + 1_000_000_000n; // absolute, > 2^53
    const STATE_DUR_NS = 9_600_000_000_000_000n; // mechanical > 2^53 guard
    expect(Number.isSafeInteger(Number(STATE_DUR_NS))).toBe(false);
    const expectedStateMs = Math.round(Number(STATE_DUR_NS) / 1_000_000);

    queryResponses.push(
      {
        name: "ui-hangs.sql",
        rows: [
          {
            kind: "jank",
            ts_ns: HANG_TS_NS,
            dur_ns: 500_000_000, // realistic ms-scale hang duration
            process_name: "com.example.app",
            reason: "App Deadline Missed",
            error_id: null,
          },
        ],
      },
      {
        name: "hang-state-breakdown.sql",
        rows: [
          {
            state: "Uninterruptible Sleep",
            blocked_function: "do_page_fault",
            total_dur_ns: STATE_DUR_NS,
            occurrences: 3,
          },
        ],
      },
      // No usable main-thread samples → uniqueStacks stays empty → the off-CPU
      // "blocked" fallback branch runs.
      { name: "hang-main-thread-samples.sql", rows: [] }
    );

    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "hang_stacks",
      appPackage: "com.example.app",
      hangIndex: 0,
      topN: 15,
    });

    // The state table rendered the bigint total_dur_ns (coerced), and the
    // off-CPU fallback message names the dominant blocking state that
    // summarizeHangBlocking derived from the same coerced breakdown.
    expect(out).toContain(`| Uninterruptible Sleep | \`do_page_fault\` | ${expectedStateMs}ms |`);
    expect(out).toContain("(state `Uninterruptible Sleep`, sleeping/blocked)");
    // Fallback path, not the sample-stacks path: no folded stack blocks.
    expect(out).not.toContain("main <- onDraw <- inflate");
  });
});
