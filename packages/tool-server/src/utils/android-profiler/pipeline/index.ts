import type { Bottleneck, CpuHotspot, UiHang, MemoryRssGrowth } from "../../profiler-shared/types";
import {
  aggregateCpuHotspots,
  BURST_GAP_MS,
  type AggregatorInputRow,
} from "../../profiler-shared/aggregate";
import {
  classifyNativeFrame,
  summarizeHangBlocking,
} from "../../profiler-shared/native-frame-class";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { ensureTraceProcessorReady } from "@argent/native-devtools-android";
import { runTpQuery } from "./run-tp";
import { foldHangAnnotations } from "./hang-fold";
import { runBatchedHangFolds, type HangWindowInput } from "./hang-folds-batched";
import { sanitizeProcessName, sanitizeIdentifier } from "./sql-safety";
import { demangleSymbol, demangleCallstackText } from "../../profiler-shared/demangle";
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

// 100 Hz sampling (argent.tracecfg.pbtxt): each sample is ~10ms of thread CPU time.
const SAMPLE_PERIOD_NS = 10_000_000;

// Derived from BURST_GAP_MS so the SQL-side (Android) and JS-side (iOS) burst
// thresholds can't drift.
const BURST_GAP_NS = String(BURST_GAP_MS * 1_000_000);

/**
 * Trace start in CLOCK_MONOTONIC ns, so every other `ts` can be normalised to
 * trace-relative ns: raw monotonic ts on a booted device would otherwise alias
 * as a wall-clock date years in the future in `instrumentsNsToWallClock`.
 * rationale: queries/README.md "Timestamps are CLOCK_MONOTONIC nanoseconds"
 */
async function getTraceStartNs(tracePath: string): Promise<number> {
  try {
    const rows = await runTpQuery<{ start_ts: number | string }>({
      tracePath,
      query: "trace-bounds.sql",
      substitutions: {},
    });
    // Coerce before validating: Number.isFinite checks the *type*, so a numeric
    // string start_ts would silently disable the normalisation.
    const startTs = Number(rows[0]?.start_ts);
    return Number.isFinite(startTs) ? startTs : 0;
  } catch {
    return 0;
  }
}

interface AndroidPipelineResult {
  bottlenecks: Bottleneck[];
  cpuHotspots: CpuHotspot[];
  uiHangs: UiHang[];
  rssGrowth: MemoryRssGrowth[];
  exportErrors: Record<string, string>;
  /**
   * Set when CPU samples exist but none carry a usable stack. Not an
   * exportErrors entry: no query failed, and the renderer counts those as
   * failures ("N of 3 queries errored").
   */
  cpuDiagnostic?: string;
}

/**
 * Drive the in-process Perfetto WASM engine against an Android .pftrace and
 * produce the platform-agnostic Bottleneck[] the render layer consumes. CPU,
 * hangs and RSS run as parallel queries and every per-hang fold is batched into
 * one more, so the query count is fixed regardless of hang count.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "4. The per-hang fold: batched, not looped"
 */
export async function runAndroidProfilerPipeline(
  tracePath: string,
  appPackage: string
): Promise<AndroidPipelineResult> {
  // Load the trace up front so every query below reuses one warm engine. A
  // TraceProcessorUnavailableError propagates to the analyze handler, which
  // renders its own banner — folding it into exportErrors would read as three
  // identical per-query "Export warnings".
  await ensureTraceProcessorReady(tracePath);

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
      `The trace contains no perf_sample rows for a process with that name, so no CPU ` +
      `analysis is possible. Either the name never matched a running process (it must equal ` +
      `the process cmdline exactly), or the app was never scheduled on-CPU during the ` +
      `recording. If it was running, it must be a debug build or declare ` +
      `\`<profileable android:shell="true"/>\` under \`<application>\` in its ` +
      `AndroidManifest.xml — then re-record.`;
  }

  // Distinct from the no-rows case above: rows exist, but cpuRowsToAggregatorRows
  // drops every one for having no leaf function. Without this diagnostic the
  // report would read as "the app did no CPU work".
  const stacklessSamples = cpuRows.reduce(
    (sum, r) => (r.leaf_function ? sum : sum + Number(r.sample_count)),
    0
  );
  const cpuDiagnostic =
    cpuRows.length > 0 && !cpuRows.some((r) => r.leaf_function) && stacklessSamples > 0
      ? describeStacklessSamples(appPackage, cpuRows, stacklessSamples)
      : undefined;

  const cpuHotspots = aggregateCpuHotspots(cpuRowsToAggregatorRows(cpuRows, traceStartNs), {
    platform: "android",
  });
  // Tag app code vs system/emulator overhead so the render layer doesn't give
  // goldfish/QEMU/kernel frames app-flavoured advice.
  for (const hotspot of cpuHotspots) {
    hotspot.frameClass = classifyNativeFrame(hotspot.dominantFunction, hotspot.dominantMapping);
  }

  const uiHangsBase = hangRowsToBottlenecks(hangRows, traceStartNs);

  // On failure, degrade to empty folds rather than aborting the pipeline (same
  // as the top-level queries).
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
    // gc rows arrive in native ns; foldHangAnnotations does its overlap math
    // against trace-relative hang bounds.
    const gcRowsNative = hangFolds.gc.get(hangIndex) ?? [];
    const gcRows = gcRowsNative.map((r) => ({ ...r, ts_ns: r.ts_ns - traceStartNs }));
    return foldHangAnnotations(hang, stateRows, gcRows);
  });

  const rssGrowth = rssRowsToBottlenecks(rssRows);

  const bottlenecks: Bottleneck[] = [...cpuHotspots, ...uiHangs, ...rssGrowth];
  return {
    bottlenecks,
    cpuHotspots,
    uiHangs,
    rssGrowth,
    exportErrors,
    ...(cpuDiagnostic ? { cpuDiagnostic } : {}),
  };
}

/**
 * Light-weight variant for profiler-combined-report: only the UI hangs the
 * cross-tool correlation needs — no CPU/RSS queries, no per-hang folds.
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

// Drill-down (profiler-stack-query Android branch)

export type AndroidStackQueryMode =
  | "hang_stacks"
  | "function_callers"
  | "thread_breakdown"
  | "leak_stacks";

interface AndroidStackQueryOptions {
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
 * Re-queries the .pftrace per call instead of caching parsed rows — the warm
 * WASM engine is the cache.
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
      return "_Memory leak detection is not yet supported on Android._";
    default:
      throw new Error(`Unknown mode: ${opts.mode as string}`);
  }
}

async function renderHangStacksAndroid(
  opts: AndroidStackQueryOptions,
  target: string
): Promise<string> {
  if (opts.hangIndex == null) {
    // Mirrors the iOS twin (executeIos): the same missing-param condition gets
    // the same classified code rather than REGISTRY_TOOL_FAILURE_UNCLASSIFIED.
    // hang_index is zod-optional, so this is reachable input, not an invariant.
    throw new FailureError("hang_stacks mode requires the hang_index parameter.", {
      error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
      failure_stage: "profiler_stack_query_params",
      failure_area: "tool_server",
      error_kind: "validation",
    });
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
  // readCell hands back any > 2^53 cell as bigint, and absolute CLOCK_MONOTONIC
  // ts_ns crosses that on a long-uptime device — coerce before the arithmetic to
  // avoid "Cannot mix BigInt and other types".
  const startNs = Number(hang.ts_ns);
  const durNs = Number(hang.dur_ns);
  const endNs = startNs + durNs;

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

  const durationMs = Math.round(durNs / 1_000_000);

  // Reused by both the rendered table and the summarizeHangBlocking fallback
  // below. total_dur_ns is hang-window-clipped and stays well under 2^53; the
  // Number() is uniformity with the other duration reads, not a live risk.
  const stateBreakdown = stateRows.map((r) => ({
    state: r.state,
    blockedFunction: r.blocked_function,
    durationMs: Math.round(Number(r.total_dur_ns) / 1_000_000),
  }));

  const lines: string[] = [
    `## Hang #${opts.hangIndex} — ${hang.kind} (${durationMs}ms)` +
      (hang.reason ? ` — reason: \`${hang.reason}\`` : ""),
    "",
  ];

  if (stateBreakdown.length > 0) {
    lines.push("### Main-thread State Breakdown", "");
    lines.push("| State | Blocked on | Duration |", "|---|---|---|");
    for (const entry of stateBreakdown) {
      lines.push(
        `| ${entry.state} | ${entry.blockedFunction ? `\`${entry.blockedFunction}\`` : "—"} | ${entry.durationMs}ms |`
      );
    }
    lines.push("");
  }

  const uniqueStacks = new Map<string, { stack: string; count: number }>();
  for (const row of sampleRows) {
    if (!row.callstack_text) continue;
    const demangled = demangleCallstackText(row.callstack_text);
    const ex = uniqueStacks.get(demangled);
    if (ex) ex.count++;
    else uniqueStacks.set(demangled, { stack: demangled, count: 1 });
  }

  if (uniqueStacks.size > 0) {
    lines.push("### Main-thread Samples During Hang", "");
    const sorted = [...uniqueStacks.values()].sort((a, b) => b.count - a.count).slice(0, opts.topN);
    for (const { stack, count } of sorted) {
      lines.push("```");
      lines.push(`(${count}×)`);
      lines.push(stack);
      lines.push("```");
    }
  } else {
    // An empty hang window is expected when the main thread was off-CPU for the
    // stall; spell that out so it doesn't read as a tool failure.
    const blocking = summarizeHangBlocking(stateBreakdown);
    lines.push("### Main-thread Samples During Hang", "");
    if (blocking && blocking.kind === "blocked") {
      lines.push(
        `_No on-CPU stack samples were captured during this hang — the main thread was off-CPU ` +
          `(state \`${blocking.dominantState}\`, sleeping/blocked) for the window. This stall is a ` +
          `**wait**, not CPU-bound work: look at what it is blocked on (GPU/vsync, a lock, binder IPC, ` +
          `or I/O) using the state breakdown above, not at a CPU call stack._`
      );
    } else if (blocking && blocking.kind === "executing") {
      lines.push(
        `_No usable on-CPU stack samples were captured during this hang, even though the main thread ` +
          `was on-CPU (state \`${blocking.dominantState}\`, executing) for most of the window — the ` +
          `sampler could not unwind a call stack (commonly stripped or missing frame symbols). This is ` +
          `genuine main-thread CPU work, not a wait; see the state breakdown above._`
      );
    } else if (stateBreakdown.length > 0) {
      lines.push(
        `_No on-CPU stack samples were captured during this hang. The main thread spent the window ` +
          `off-CPU or runnable-but-not-scheduled, so there is no CPU call stack to show; see the state ` +
          `breakdown above._`
      );
    } else {
      // No state rows either, so there is no "breakdown above" to point at.
      lines.push(
        `_No on-CPU stack samples were captured during this hang, and no main-thread state was ` +
          `captured for this window either. The main thread was likely off-CPU (sleeping/blocked) or ` +
          `runnable-but-not-scheduled, so there is no CPU call stack to show._`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Resolve the user-facing `thread` argument to the token function-callers.sql
 * understands. The Android main thread's raw perf `comm` is the truncated
 * package, not "main", so aliases map to the `__MAIN__` sentinel (matched via
 * thread.is_main_thread); an absent thread means "search every thread".
 */
function resolveFunctionCallersThread(thread: string | undefined): {
  token: string;
  label: string;
  allThreads: boolean;
} {
  if (!thread || thread.trim() === "") {
    return { token: "__ALL__", label: "all threads", allThreads: true };
  }
  const norm = thread.trim().toLowerCase();
  if (norm === "main" || norm === "main thread" || norm === "ui" || norm === "ui thread") {
    return { token: "__MAIN__", label: "main thread", allThreads: false };
  }
  const raw = thread.trim();
  return { token: raw, label: raw, allThreads: false };
}

async function renderFunctionCallersAndroid(
  opts: AndroidStackQueryOptions,
  target: string
): Promise<string> {
  if (!opts.functionName) {
    // Same classification as the iOS twin (see renderHangStacksAndroid above).
    throw new FailureError("function_callers mode requires the function_name parameter.", {
      error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
      failure_stage: "profiler_stack_query_params",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  const { token, label, allThreads } = resolveFunctionCallersThread(opts.thread);
  const rows = await runTpQuery<AndroidFunctionCallersRow>({
    tracePath: opts.tracePath,
    query: "function-callers.sql",
    substitutions: {
      TARGET_PROCESS: target,
      THREAD_NAME: sanitizeIdentifier(token),
      FUNCTION_NAME: sanitizeIdentifier(opts.functionName),
    },
  });
  if (rows.length === 0) {
    return renderFunctionCallersMiss(opts, target, label);
  }
  const lines: string[] = [
    `## Callers of \`${opts.functionName}\` on ${allThreads ? "all threads" : `\`${label}\``}`,
    "",
  ];
  // Frame names are stored mangled, so the SQL matches a substring; listing the
  // real leaf symbols makes an over-broad match obvious. Dedup on the DEMANGLED
  // name so overloads collapse to one bullet and the count matches.
  const distinctMatched = [...new Set(rows.map((r) => demangleSymbol(r.matched_function)))];
  if (!rows.some((r) => r.is_exact) || distinctMatched.length > 1) {
    lines.push(
      `_Substring match: \`${opts.functionName}\` hit ${distinctMatched.length} leaf symbol(s):_`,
      ...distinctMatched.slice(0, 10).map((m) => `- \`${m}\``),
      ...(distinctMatched.length > 10 ? [`- …and ${distinctMatched.length - 10} more`] : []),
      ""
    );
  }
  lines.push(`**Unique callsites:** ${rows.length}`, "");
  for (const row of rows.slice(0, opts.topN)) {
    lines.push("```");
    // The same callstack can appear on several threads; the raw name can be
    // copied straight back as a `thread` filter.
    const tag = allThreads ? ` [${row.thread_name}${row.is_main_thread ? " (main)" : ""}]` : "";
    lines.push(`(${row.occurrences}×)${tag}`);
    // Display-only: the SQL still matches on the raw mangled names.
    lines.push(row.callstack_text ? demangleCallstackText(row.callstack_text) : "<no callstack>");
    lines.push("```");
  }
  return lines.join("\n");
}

/**
 * Zero-result fallback for function_callers: the raw thread names are what the
 * SQL matches on and are not recoverable from the normalised analyze output.
 */
async function renderFunctionCallersMiss(
  opts: AndroidStackQueryOptions,
  target: string,
  label: string
): Promise<string> {
  const lines = [`_Function \`${opts.functionName}\` not found on ${label}._`];
  const threads = await runTpQuery<AndroidThreadRow>({
    tracePath: opts.tracePath,
    query: "thread-breakdown.sql",
    substitutions: { TARGET_PROCESS: target },
  }).catch(() => [] as AndroidThreadRow[]);
  if (threads.length > 0) {
    lines.push(
      "",
      "Available threads (pass the exact name as `thread`, or omit `thread` to search all):",
      ""
    );
    for (const t of threads.slice(0, 20)) {
      lines.push(
        `- \`${t.thread_name}\`${t.is_main_thread ? " (main)" : ""} — ${t.sample_count} samples`
      );
    }
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

// Row → Bottleneck transformers

/**
 * Explain a trace whose perf samples carry no usable stack. `leaf_mapping` comes
 * from the same LEFT JOIN chain as `leaf_function`, so a mapping without a name
 * means the stack was unwound and only the symbol is missing, while neither
 * means nothing was ever unwound.
 */
function describeStacklessSamples(
  appPackage: string,
  cpuRows: AndroidCpuHotspotRow[],
  stacklessSamples: number
): string {
  const unwound = cpuRows.some((r) => r.leaf_mapping);
  const head =
    `${stacklessSamples} CPU sample${stacklessSamples === 1 ? "" : "s"} were captured for ` +
    `\`${appPackage}\`, but none carry a usable call stack, so no CPU hotspots could be ` +
    `computed and \`profiler-stack-query\` mode=\`function_callers\` / mode=\`hang_stacks\` ` +
    `will find nothing. The app was running — this is a capture limitation, not an idle app. ` +
    `mode=\`thread_breakdown\` still works, since it counts samples and needs no stacks.`;

  return unwound
    ? `${head} The stacks were unwound but no frame resolved to a symbol, which points at ` +
        `stripped native libraries. Profile a build that keeps its symbols (a debug build, or a ` +
        `release build with unstripped \`.so\`s).`
    : `${head} No stack was unwound at all: Perfetto only unwinds a process it can read ` +
        `\`/proc/<pid>/mem\` for. Profile a debug build, or add ` +
        `\`<profileable android:shell="true"/>\` to \`<application>\` and rebuild — verify with ` +
        `\`adb shell dumpsys package ${appPackage}\`, which shows \`DEBUGGABLE\` for a profileable ` +
        `target. Platform packages such as \`com.android.settings\` are never profileable.`;
}

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
      // Threaded through so classifyNativeFrame can recognise `/kernel` leaves.
      ...(row.leaf_mapping != null ? { dominantMapping: row.leaf_mapping } : {}),
      thread,
      weightNs: row.sample_count * SAMPLE_PERIOD_NS,
      // Bursts are precomputed in SQL, so no raw timestamps ship; the aggregator's
      // duringHang stays false (Android never passes hangSampleTimestamps).
      timestampsNs: [],
      callChains: [{ chain: [dominant], count: row.sample_count }],
      precomputedBursts: parseBurstWindows(row.burst_windows, traceStartMs),
      // Absolute CLOCK_MONOTONIC ns passes 2^53 after ~104 days of uptime and
      // readCell hands those back as bigint — coerce before mixing with the
      // plain-Number traceStartNs.
      firstMs: Math.round((Number(row.first_ts_ns) - traceStartNs) / 1_000_000),
      lastMs: Math.round((Number(row.last_ts_ns) - traceStartNs) / 1_000_000),
      sampleCount: row.sample_count,
    });
  }
  return out;
}

function hangRowsToBottlenecks(rows: AndroidJankRow[], traceStartNs: number): UiHang[] {
  return rows.map((row) => {
    // Same bigint coercion as cpuRowsToAggregatorRows: readCell keeps a > 2^53
    // ts_ns as bigint and traceStartNs is a plain Number.
    const durNs = Number(row.dur_ns);
    const startNs = Number(row.ts_ns) - traceStartNs;
    return {
      type: "ui_hang",
      platform: "android",
      hangType: row.kind,
      durationMs: Math.round(durNs / 1_000_000),
      startTimeFormatted: formatTraceTime(startNs),
      startNs,
      endNs: startNs + durNs,
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

function normaliseAndroidThread(threadName: string | null, isMainThread: boolean): string {
  if (isMainThread) return "Main Thread";
  if (!threadName) return "Unknown";
  // Hermes JS thread names vary across RN versions.
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
  // reason is Perfetto's jank_type, which ui-hangs.sql has already filtered to
  // rows containing "App Deadline Missed". Exact === isolates the pure form (the
  // app's own work alone blew the frame budget → RED) from comma-combined forms
  // like "Prediction Error, App Deadline Missed", which share blame with the
  // scheduler/SurfaceFlinger pipeline and stay RED only when the stall is long
  // enough to be user-perceptible.
  if (row.reason === "App Deadline Missed") return "RED";
  // Same bigint risk as the other dur_ns reads (see readCell).
  const durationMs = Number(row.dur_ns) / 1_000_000;
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
