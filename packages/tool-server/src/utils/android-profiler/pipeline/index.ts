import type {
  Bottleneck,
  CpuHotspot,
  UiHang,
  MemoryRssGrowth,
} from "../../profiler-shared/types";
import {
  aggregateCpuHotspots,
  BURST_GAP_MS,
  type AggregatorInputRow,
} from "../../profiler-shared/aggregate";
import { ensureTraceProcessorRunnable } from "@argent/native-devtools-android";
import { runTpQuery } from "./run-tp";
import { foldHangAnnotations } from "./hang-fold";
import { runBatchedHangFolds, type HangWindowInput } from "./hang-folds-batched";
import { sanitizeProcessName, sanitizeIdentifier } from "./sql-safety";
import type {
  AndroidCpuHotspotRow,
  AndroidJankRow,
  AndroidHangStateRow,
  AndroidHangGcRow,
  AndroidRssRow,
  AndroidThreadRow,
  AndroidFunctionCallersRow,
  AndroidHangMainThreadSampleRow,
} from "../types";

// Sampling at 100 Hz (see argent.tracecfg.pbtxt). Each sample represents
// ~10ms of CPU time on the sampled thread. weightNs is sample_count × this.
const SAMPLE_PERIOD_NS = 10_000_000;

// Burst-gap threshold injected into cpu-hotspots.sql as BURST_GAP_NS. Derived
// from BURST_GAP_MS so SQL-side (Android) and JS-side (iOS) bursts can't drift.
const BURST_GAP_NS = String(BURST_GAP_MS * 1_000_000);

/**
 * Query the trace's CLOCK_MONOTONIC start so every other `ts` can be normalised
 * to trace-relative ns: raw monotonic ts is tens-of-billions of ns on a booted
 * device and would otherwise alias as a wall-clock date years in the future in
 * `instrumentsNsToWallClock`.
 * rationale: queries/README.md "Timestamps are CLOCK_MONOTONIC nanoseconds"
 */
async function getTraceStartNs(tracePath: string): Promise<number> {
  try {
    const rows = await runTpQuery<{ start_ts: number | string }>({
      tracePath,
      query: "trace-bounds.sql",
      substitutions: {},
    });
    // Coerce-then-validate: `Number.isFinite("5000000000000")` returns false
    // because it checks the input *type*, not the value. A future
    // trace_processor_shell that emits start_ts as a JSON string would
    // silently disable the normalisation if we validated first.
    const startTs = Number(rows[0]?.start_ts);
    return Number.isFinite(startTs) ? startTs : 0;
  } catch {
    return 0;
  }
}

export interface AndroidPipelineResult {
  bottlenecks: Bottleneck[];
  cpuHotspots: CpuHotspot[];
  uiHangs: UiHang[];
  rssGrowth: MemoryRssGrowth[];
  exportErrors: Record<string, string>;
}

/**
 * Drive trace_processor_shell against an Android .pftrace and produce the
 * platform-agnostic Bottleneck[] the render layer consumes. CPU + hangs + RSS
 * run as parallel top-level queries; all per-hang folds are batched into one
 * more invocation, so the worst case is fixed-cost (~4 invocations end-to-end).
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "4. The per-hang fold: batched, not looped"
 */
export async function runAndroidProfilerPipeline(
  tracePath: string,
  appPackage: string
): Promise<AndroidPipelineResult> {
  // Probe presence + architecture of trace_processor_shell up front. A
  // TraceProcessorUnavailableError propagates to the analyze handler (which
  // renders the actionable download banner) — deliberately NOT folded into
  // exportErrors, where a missing binary would read as three identical per-query
  // "Export warnings" instead of one clear "run `argent init
  // --download-dependencies`" message.
  await ensureTraceProcessorRunnable();

  const target = sanitizeProcessName(appPackage);
  const exportErrors: Record<string, string> = {};

  // Per-hang fold queries need NATIVE (monotonic) ns bounds, so re-add
  // traceStartNs below; UiHang values stay trace-relative. See getTraceStartNs.
  const traceStartNs = await getTraceStartNs(tracePath);

  const [cpuRowsResult, hangRowsResult, rssRowsResult] = await Promise.allSettled([
    runTpQuery<AndroidCpuHotspotRow>({
      tracePath,
      query: "cpu-hotspots.sql",
      substitutions: { TARGET_PROCESS: target, BURST_GAP_NS },
    }),
    runTpQuery<AndroidJankRow>({
      tracePath,
      query: "ui-hangs.sql",
      substitutions: { TARGET_PROCESS: target },
    }),
    runTpQuery<AndroidRssRow>({
      tracePath,
      query: "memory-rss.sql",
      substitutions: { TARGET_PROCESS: target },
    }),
  ]);

  const cpuRows = unwrapOr(cpuRowsResult, [], (msg) => {
    exportErrors.cpu = msg;
  });
  const hangRows = unwrapOr(hangRowsResult, [], (msg) => {
    exportErrors.hangs = msg;
  });
  const rssRows = unwrapOr(rssRowsResult, [], (msg) => {
    exportErrors.rss = msg;
  });

  if (cpuRows.length === 0 && hangRows.length === 0 && !exportErrors.cpu) {
    exportErrors.cpu =
      `No CPU samples were captured for cmdline \`${appPackage}\`. ` +
      `The most common cause is the target app being non-debuggable (release build) ` +
      `without a \`<profileable shell=\"true\">\` entry in its AndroidManifest.xml. ` +
      `Without that, Perfetto silently drops the linux.perf data source. ` +
      `Add \`<profileable android:shell=\"true\"/>\` to the \`<application>\` element ` +
      `and rebuild, or run a debug variant of the app.`;
  }

  const cpuHotspots = aggregateCpuHotspots(
    cpuRowsToAggregatorRows(cpuRows, traceStartNs),
    { platform: "android" }
  );

  const uiHangsBase = hangRowsToBottlenecks(hangRows, traceStartNs);

  // Single batched call replaces the legacy 2N per-hang loop. On failure,
  // degrade to empty folds rather than aborting the pipeline (same as the top-level queries).
  const hangFolds = await runBatchedHangFolds({
    tracePath,
    target,
    hangs: uiHangsBase.map<HangWindowInput>((hang, hangIndex) => ({
      hangIndex,
      startNs: hang.startNs + traceStartNs,
      endNs: hang.endNs + traceStartNs,
    })),
  }).catch<{
    state: Map<number, AndroidHangStateRow[]>;
    gc: Map<number, AndroidHangGcRow[]>;
  }>((err: unknown) => {
    exportErrors.hang_folds = err instanceof Error ? err.message : String(err);
    return { state: new Map(), gc: new Map() };
  });

  const uiHangs: UiHang[] = uiHangsBase.map((hang, hangIndex) => {
    const stateRows = hangFolds.state.get(hangIndex) ?? [];
    // Normalise gc rows into trace-relative ns so foldHangAnnotations can do
    // the overlap math against trace-relative hang.startNs/endNs.
    const gcRowsNative = hangFolds.gc.get(hangIndex) ?? [];
    const gcRows = gcRowsNative.map((r) => ({ ...r, ts_ns: r.ts_ns - traceStartNs }));
    return foldHangAnnotations(hang, stateRows, gcRows);
  });

  const rssGrowth = rssRowsToBottlenecks(rssRows);

  const bottlenecks: Bottleneck[] = [...cpuHotspots, ...uiHangs, ...rssGrowth];
  return { bottlenecks, cpuHotspots, uiHangs, rssGrowth, exportErrors };
}

/**
 * Light-weight variant for profiler-combined-report: fetches only the UI hangs
 * (with start/end ns) the cross-tool correlation needs — skips CPU/RSS queries
 * and the per-hang folds.
 */
export async function loadAndroidCombinedData(
  tracePath: string,
  appPackage: string
): Promise<{ uiHangs: UiHang[] }> {
  const target = sanitizeProcessName(appPackage);
  const traceStartNs = await getTraceStartNs(tracePath);
  const hangRows = await runTpQuery<AndroidJankRow>({
    tracePath,
    query: "ui-hangs.sql",
    substitutions: { TARGET_PROCESS: target },
  }).catch(() => [] as AndroidJankRow[]);
  return { uiHangs: hangRowsToBottlenecks(hangRows, traceStartNs) };
}

// ---------------------------------------------------------------------------
// Drill-down (profiler-stack-query Android branch)
// ---------------------------------------------------------------------------

export type AndroidStackQueryMode =
  | "hang_stacks"
  | "function_callers"
  | "thread_breakdown"
  | "leak_stacks";

export interface AndroidStackQueryOptions {
  tracePath: string;
  mode: AndroidStackQueryMode;
  appPackage: string;
  hangIndex?: number;
  functionName?: string;
  thread?: string;
  topN: number;
}

/**
 * Drill-down entry point for the Android branch of profiler-stack-query.
 * Re-queries the .pftrace per call instead of caching parsed data in memory —
 * trace_processor_shell is fast enough (~30 ms/query) that caching isn't worth it.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "3. Drill-down: re-query, don't cache"
 */
export async function runAndroidStackQuery(opts: AndroidStackQueryOptions): Promise<string> {
  const target = sanitizeProcessName(opts.appPackage);
  switch (opts.mode) {
    case "hang_stacks":
      return renderHangStacksAndroid(opts, target);
    case "function_callers":
      return renderFunctionCallersAndroid(opts, target);
    case "thread_breakdown":
      return renderThreadBreakdownAndroid(opts, target);
    case "leak_stacks":
      return "_Memory leak detection is not yet supported on Android in v1._";
    default:
      throw new Error(`Unknown mode: ${opts.mode as string}`);
  }
}

async function renderHangStacksAndroid(
  opts: AndroidStackQueryOptions,
  target: string
): Promise<string> {
  if (opts.hangIndex == null) {
    throw new Error("hang_stacks mode requires the hang_index parameter.");
  }
  const hangRows = await runTpQuery<AndroidJankRow>({
    tracePath: opts.tracePath,
    query: "ui-hangs.sql",
    substitutions: { TARGET_PROCESS: target },
  });
  if (opts.hangIndex < 0 || opts.hangIndex >= hangRows.length) {
    return `_Invalid hang_index ${opts.hangIndex}. There are ${hangRows.length} hangs (0-indexed)._`;
  }
  const hang = hangRows[opts.hangIndex]!;
  const startNs = hang.ts_ns;
  const endNs = hang.ts_ns + hang.dur_ns;

  const [stateRows, sampleRows] = await Promise.all([
    runTpQuery<AndroidHangStateRow>({
      tracePath: opts.tracePath,
      query: "hang-state-breakdown.sql",
      substitutions: {
        TARGET_PROCESS: target,
        HANG_START_NS: String(startNs),
        HANG_END_NS: String(endNs),
      },
    }),
    runTpQuery<AndroidHangMainThreadSampleRow>({
      tracePath: opts.tracePath,
      query: "hang-main-thread-samples.sql",
      substitutions: {
        TARGET_PROCESS: target,
        HANG_START_NS: String(startNs),
        HANG_END_NS: String(endNs),
      },
    }).catch(() => [] as AndroidHangMainThreadSampleRow[]),
  ]);

  const durationMs = Math.round(hang.dur_ns / 1_000_000);
  const lines: string[] = [
    `## Hang #${opts.hangIndex} — ${hang.kind} (${durationMs}ms)` +
      (hang.reason ? ` — reason: \`${hang.reason}\`` : ""),
    "",
  ];

  if (stateRows.length > 0) {
    lines.push("### Main-thread State Breakdown", "");
    lines.push("| State | Blocked on | Duration |", "|---|---|---|");
    for (const row of stateRows) {
      const ms = Math.round(row.total_dur_ns / 1_000_000);
      lines.push(
        `| ${row.state} | ${row.blocked_function ? `\`${row.blocked_function}\`` : "—"} | ${ms}ms |`
      );
    }
    lines.push("");
  }

  if (sampleRows.length > 0) {
    lines.push("### Main-thread Samples During Hang", "");
    const uniqueStacks = new Map<string, { stack: string; count: number }>();
    for (const row of sampleRows) {
      if (!row.callstack_text) continue;
      const key = row.callstack_text;
      const ex = uniqueStacks.get(key);
      if (ex) ex.count++;
      else uniqueStacks.set(key, { stack: row.callstack_text, count: 1 });
    }
    const sorted = [...uniqueStacks.values()].sort((a, b) => b.count - a.count).slice(0, opts.topN);
    for (const { stack, count } of sorted) {
      lines.push("```");
      lines.push(`(${count}×)`);
      lines.push(stack);
      lines.push("```");
    }
  }

  return lines.join("\n");
}

async function renderFunctionCallersAndroid(
  opts: AndroidStackQueryOptions,
  target: string
): Promise<string> {
  if (!opts.functionName) {
    throw new Error("function_callers mode requires the function_name parameter.");
  }
  const thread = opts.thread ?? "main";
  const rows = await runTpQuery<AndroidFunctionCallersRow>({
    tracePath: opts.tracePath,
    query: "function-callers.sql",
    substitutions: {
      TARGET_PROCESS: target,
      THREAD_NAME: sanitizeIdentifier(thread),
      FUNCTION_NAME: sanitizeIdentifier(opts.functionName),
    },
  });
  if (rows.length === 0) {
    return `_Function \`${opts.functionName}\` not found on thread \`${thread}\`._`;
  }
  const lines: string[] = [
    `## Callers of \`${opts.functionName}\` on \`${thread}\``,
    "",
    `**Unique callsites:** ${rows.length}`,
    "",
  ];
  for (const row of rows.slice(0, opts.topN)) {
    lines.push("```");
    lines.push(`(${row.occurrences}×)`);
    lines.push(row.callstack_text ?? "<no callstack>");
    lines.push("```");
  }
  return lines.join("\n");
}

async function renderThreadBreakdownAndroid(
  opts: AndroidStackQueryOptions,
  target: string
): Promise<string> {
  const rows = await runTpQuery<AndroidThreadRow>({
    tracePath: opts.tracePath,
    query: "thread-breakdown.sql",
    substitutions: { TARGET_PROCESS: target },
  });
  let filtered = rows;
  if (opts.thread) {
    filtered = rows.filter((r) =>
      (r.thread_name ?? "").toLowerCase().includes(opts.thread!.toLowerCase())
    );
  }
  if (filtered.length === 0) {
    return opts.thread
      ? `_No samples found for thread matching "${opts.thread}"._`
      : "_No CPU samples available._";
  }
  const lines: string[] = [
    `## Thread CPU Breakdown${opts.thread ? ` (filter: "${opts.thread}")` : ""}`,
    "",
    "| Thread | Samples | % | Main? |",
    "|---|---|---|---|",
  ];
  for (const row of filtered.slice(0, opts.topN)) {
    lines.push(
      `| ${row.thread_name} | ${row.sample_count} | ${row.pct_of_app}% | ${row.is_main_thread ? "Yes" : "—"} |`
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Row → Bottleneck transformers
// ---------------------------------------------------------------------------

function cpuRowsToAggregatorRows(
  rows: AndroidCpuHotspotRow[],
  traceStartNs: number
): AggregatorInputRow[] {
  // Bursts arrive in NATIVE (monotonic) ms; pipeline is 0-anchored, so subtract trace start.
  const traceStartMs = Math.round(traceStartNs / 1_000_000);
  const out: AggregatorInputRow[] = [];
  for (const row of rows) {
    const dominant = row.leaf_function;
    if (!dominant) continue;
    const thread = normaliseAndroidThread(row.thread_name, row.is_main_thread === 1);
    out.push({
      dominantFunction: dominant,
      thread,
      weightNs: row.sample_count * SAMPLE_PERIOD_NS,
      // Android ships SQL-precomputed bursts, no raw timestamps. Empty array
      // keeps the aggregator's duringHang check false (Android never passes hangSampleTimestamps).
      timestampsNs: [],
      callChains: [{ chain: [dominant], count: row.sample_count }],
      precomputedBursts: parseBurstWindows(row.burst_windows, traceStartMs),
      firstMs: Math.round((row.first_ts_ns - traceStartNs) / 1_000_000),
      lastMs: Math.round((row.last_ts_ns - traceStartNs) / 1_000_000),
      sampleCount: row.sample_count,
    });
  }
  return out;
}

function hangRowsToBottlenecks(rows: AndroidJankRow[], traceStartNs: number): UiHang[] {
  return rows.map((row) => {
    const durationMs = Math.round(row.dur_ns / 1_000_000);
    const startNs = row.ts_ns - traceStartNs;
    return {
      type: "ui_hang",
      platform: "android",
      hangType: row.kind,
      durationMs,
      startTimeFormatted: formatTraceTime(startNs),
      startNs,
      endNs: startNs + row.dur_ns,
      suspectedFunctions: [],
      appCallChains: [],
      severity: classifyAndroidHangSeverity(row),
      ...(row.reason ? { jankReason: row.reason } : {}),
    };
  });
}

function rssRowsToBottlenecks(rows: AndroidRssRow[]): MemoryRssGrowth[] {
  return rows
    .filter((r) => r.growth_mb > 0)
    .map((r) => ({
      type: "memory_rss_growth",
      platform: "android",
      startMb: round1(r.start_rss_mb),
      peakMb: round1(r.peak_rss_mb),
      growthMb: round1(r.growth_mb),
      severity: "YELLOW",
    }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseAndroidThread(threadName: string | null, isMainThread: boolean): string {
  if (isMainThread) return "Main Thread";
  if (!threadName) return "Unknown";
  // Hermes JS threads — render-target names vary across RN versions.
  if (/hermes|jsthread|js_/i.test(threadName)) return "JS/Hermes";
  return threadName;
}

/**
 * Parse the SQL-side `burst_windows` column (`start_ms:end_ms:count` triples,
 * NATIVE ms) into trace-relative windows. Malformed triples are skipped.
 */
function parseBurstWindows(
  s: string | null,
  traceStartMs: number
): { startMs: number; endMs: number; sampleCount: number }[] {
  if (!s) return [];
  const out: { startMs: number; endMs: number; sampleCount: number }[] = [];
  for (const part of s.split(",")) {
    const fields = part.split(":");
    if (fields.length !== 3) continue;
    const startMs = Number(fields[0]);
    const endMs = Number(fields[1]);
    const sampleCount = Number(fields[2]);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(sampleCount)) {
      continue;
    }
    out.push({ startMs: startMs - traceStartMs, endMs: endMs - traceStartMs, sampleCount });
  }
  return out;
}

function formatTraceTime(ns: number): string {
  const totalMs = Math.round(ns / 1_000_000);
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function classifyAndroidHangSeverity(row: AndroidJankRow): "RED" | "YELLOW" {
  if (row.kind === "anr") return "RED";
  // BufferStuffing / SfCpuDeadlineMissed / PredictionError → YELLOW (rendering pipeline)
  // AppDeadlineMissed → RED (the app's own work missed the frame)
  if (row.reason === "AppDeadlineMissed") return "RED";
  const durationMs = row.dur_ns / 1_000_000;
  if (durationMs > 500) return "RED";
  return "YELLOW";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function unwrapOr<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  onError: (msg: string) => void
): T {
  if (result.status === "fulfilled") return result.value;
  const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
  onError(msg);
  return fallback;
}
