import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import {
  traceProcessorShellAvailable,
  traceProcessorShellPath,
  traceProcessorQueriesDir,
} from "@argent/native-devtools-android";
import { runTpInline, renderSqlTemplate } from "../../src/utils/android-profiler/pipeline/run-tp";
import { runBatchedHangFolds } from "../../src/utils/android-profiler/pipeline/hang-folds-batched";
import { BURST_GAP_MS } from "../../src/utils/profiler-shared/aggregate";

// cpu-hotspots.sql needs the burst-gap threshold injected, same as the pipeline.
const BURST_GAP_NS = String(BURST_GAP_MS * 1_000_000);

/**
 * Real-SQL smoke test — runs the actual `queries/*.sql` against a real
 * `.pftrace` through `trace_processor_shell`, with NOTHING mocked. Every other
 * android-perfetto test mocks the SQL layer, so a schema/runtime breakage in
 * the SQL (the v0.7.1 failure mode) is otherwise invisible to CI. This guards
 * the queries themselves: each must run without a SQLite error and emit the
 * columns its `Android*Row` type expects.
 *
 * It is intentionally LOCAL-ONLY: it auto-skips when the binary or a fixture
 * trace is absent, so it is a no-op in CI (the unit-tests workflow has no
 * native binary). Run it by hand against a real trace:
 *
 *   ARGENT_PFTRACE_FIXTURE=/path/to/trace.pftrace \
 *     npm run test:sql-smoke --workspace packages/tool-server
 */

const PINNED_TP_VERSION = "v55.3";

const FIXTURE =
  process.env.ARGENT_PFTRACE_FIXTURE ??
  path.resolve(__dirname, "fixtures/sample.pftrace");
const fixtureExists = fsSync.existsSync(FIXTURE);
const binaryAvailable = traceProcessorShellAvailable();

/** Render a query template the same way runTpQuery does (shared renderer). */
async function render(file: string, subs: Record<string, string>): Promise<string> {
  const template = await fs.readFile(path.join(traceProcessorQueriesDir(), file), "utf8");
  return renderSqlTemplate(template, subs);
}

/**
 * Parse just the CSV header line trace_processor_shell emits — present even
 * for zero-row results, which `runTpInline`'s parsed output (rows only) cannot
 * surface. Used to assert columns when a query legitimately returns no rows.
 */
function csvHeader(sql: string): string[] {
  const tmp = path.join(path.dirname(FIXTURE), `.argent-smoke-${process.pid}.sql`);
  fsSync.writeFileSync(tmp, sql, "utf8");
  try {
    const stdout = execFileSync(traceProcessorShellPath(), ["-q", tmp, FIXTURE], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const headerLine = stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
    return headerLine.split(",").map((c) => c.replace(/^"|"$/g, ""));
  } finally {
    fsSync.rmSync(tmp, { force: true });
  }
}

/** Columns the query must emit, keyed by the Android*Row type that consumes them. */
interface QuerySpec {
  file: string;
  rowType: string;
  columns: string[];
  /** Built in beforeAll once target / window / function are resolved. */
  subs: () => Record<string, string>;
}

describe.skipIf(!binaryAvailable || !fixtureExists)("PerfettoSQL smoke (real trace)", () => {
  let target: string;
  let hangStartNs: number;
  let hangEndNs: number;
  let drillThread: string;
  let drillFunction: string;
  let specs: QuerySpec[];

  beforeAll(async () => {
    // 1. Resolve the target process — env override, else the busiest one.
    target =
      process.env.ARGENT_PFTRACE_TARGET ??
      (
        await runTpInline<{ process_name: string }>({
          tracePath: FIXTURE,
          sql: `SELECT p.name AS process_name, COUNT(*) AS n
                FROM perf_sample ps JOIN thread t USING (utid) JOIN process p USING (upid)
                WHERE p.name IS NOT NULL GROUP BY p.name ORDER BY n DESC LIMIT 1;`,
        })
      )[0]?.process_name;
    if (!target) throw new Error("Could not resolve a target process from the fixture.");

    // 2. A real hang window from ui-hangs.sql (native ns). Fall back to the
    //    trace bounds when the fixture has no app-attributable jank.
    const hangs = await runTpInline<{ ts_ns: number; dur_ns: number }>({
      tracePath: FIXTURE,
      sql: await render("ui-hangs.sql", { TARGET_PROCESS: target }),
    });
    if (hangs.length > 0) {
      hangStartNs = hangs[0]!.ts_ns;
      hangEndNs = hangs[0]!.ts_ns + hangs[0]!.dur_ns;
    } else {
      const bounds = await runTpInline<{ start_ts: number; end_ts: number }>({
        tracePath: FIXTURE,
        sql: `SELECT start_ts, end_ts FROM trace_bounds;`,
      });
      hangStartNs = bounds[0]!.start_ts;
      hangEndNs = bounds[0]!.end_ts;
    }

    // 3. A real (thread, leaf_function) for the function-callers drill-down.
    const hotspots = await runTpInline<{ thread_name: string; leaf_function: string | null }>({
      tracePath: FIXTURE,
      sql: await render("cpu-hotspots.sql", { TARGET_PROCESS: target, BURST_GAP_NS }),
    });
    const withFn = hotspots.find((h) => h.leaf_function);
    drillThread = withFn?.thread_name ?? "main";
    drillFunction = withFn?.leaf_function ?? "__no_such_function__";

    specs = [
      { file: "trace-bounds.sql", rowType: "(start_ts)", columns: ["start_ts"], subs: () => ({}) },
      {
        file: "cpu-hotspots.sql",
        rowType: "AndroidCpuHotspotRow",
        columns: [
          "thread_name",
          "is_main_thread",
          "leaf_function",
          "sample_count",
          "first_ts_ns",
          "last_ts_ns",
          "total_samples",
          "burst_windows",
        ],
        subs: () => ({ TARGET_PROCESS: target, BURST_GAP_NS }),
      },
      {
        file: "ui-hangs.sql",
        rowType: "AndroidJankRow",
        columns: ["kind", "ts_ns", "dur_ns", "process_name", "reason", "error_id"],
        subs: () => ({ TARGET_PROCESS: target }),
      },
      {
        file: "memory-rss.sql",
        rowType: "AndroidRssRow",
        columns: [
          "process_name",
          "start_rss_mb",
          "peak_rss_mb",
          "growth_mb",
          "peak_anon_rss_mb",
          "peak_swap_mb",
        ],
        subs: () => ({ TARGET_PROCESS: target }),
      },
      {
        file: "thread-breakdown.sql",
        rowType: "AndroidThreadRow",
        columns: ["thread_name", "is_main_thread", "sample_count", "pct_of_app"],
        subs: () => ({ TARGET_PROCESS: target }),
      },
      {
        file: "function-callers.sql",
        rowType: "AndroidFunctionCallersRow",
        columns: ["callsite_id", "callstack_text", "occurrences"],
        subs: () => ({
          TARGET_PROCESS: target,
          THREAD_NAME: drillThread,
          FUNCTION_NAME: drillFunction,
        }),
      },
      {
        file: "hang-state-breakdown.sql",
        rowType: "AndroidHangStateRow",
        columns: ["state", "blocked_function", "total_dur_ns", "occurrences"],
        subs: () => ({
          TARGET_PROCESS: target,
          HANG_START_NS: String(hangStartNs),
          HANG_END_NS: String(hangEndNs),
        }),
      },
      {
        file: "hang-main-thread-samples.sql",
        rowType: "AndroidHangMainThreadSampleRow",
        columns: ["ts_ns", "leaf_function", "callstack_text"],
        subs: () => ({
          TARGET_PROCESS: target,
          HANG_START_NS: String(hangStartNs),
          HANG_END_NS: String(hangEndNs),
        }),
      },
    ];
  }, 120_000);

  it(`runs trace_processor_shell pinned at ${PINNED_TP_VERSION}`, () => {
    const version = execFileSync(traceProcessorShellPath(), ["--version"], {
      encoding: "utf8",
    });
    // Guards the experimental_annotated_callstack / stdlib coupling — a tp
    // version bump can silently change column shapes or remove modules.
    expect(version).toContain(PINNED_TP_VERSION);
  });

  // One assertion per query file: runs through the REAL runTpInline (throws on
  // any SQLite error) and the emitted CSV header must carry every column the
  // matching Android*Row type reads.
  it("each query file runs without error and emits the expected columns", async () => {
    for (const spec of specs) {
      const sql = await render(spec.file, spec.subs());
      // (a) No SQLite error — runTpInline rejects if trace_processor_shell does.
      const rows = await runTpInline<Record<string, unknown>>({ tracePath: FIXTURE, sql });
      // (b) Columns — from a data row if present, else the raw header (which
      // tp emits even for zero-row results).
      const header = rows.length > 0 ? Object.keys(rows[0]!) : csvHeader(sql);
      for (const col of spec.columns) {
        expect(header, `${spec.file} (${spec.rowType}) missing column "${col}"`).toContain(col);
      }
    }
  }, 120_000);

  it("batched hang folds return state rows for real hang windows", async () => {
    const windows = [
      { hangIndex: 0, startNs: hangStartNs, endNs: hangEndNs },
      { hangIndex: 1, startNs: hangStartNs, endNs: Math.round((hangStartNs + hangEndNs) / 2) },
    ];
    const folds = await runBatchedHangFolds({ tracePath: FIXTURE, target, hangs: windows });
    expect(folds.state).toBeInstanceOf(Map);
    expect(folds.gc).toBeInstanceOf(Map);
    // The main thread is always in *some* scheduler state across a real window,
    // so at least one hang must fold to a non-empty state breakdown, and each
    // state row must carry the AndroidHangStateRow shape.
    expect(folds.state.size).toBeGreaterThan(0);
    const anyStateRows = [...folds.state.values()].flat();
    expect(anyStateRows.length).toBeGreaterThan(0);
    for (const row of anyStateRows) {
      expect(row).toHaveProperty("state");
      expect(row).toHaveProperty("total_dur_ns");
      expect(row).toHaveProperty("occurrences");
    }
  }, 120_000);
});
