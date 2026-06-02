import { promises as fs } from "fs";
import * as path from "path";
import { traceProcessorQueriesDir } from "@argent/native-devtools-android";
import { runTpInline, renderSqlTemplate } from "./run-tp";
import { sanitizeProcessName } from "./sql-safety";
import type { AndroidHangStateRow, AndroidHangGcRow } from "../types";

/**
 * Per-hang annotation data, keyed by the caller-assigned hang index. Hangs with
 * no thread_state rows get an empty `state`; no GC overlap → empty `gc`.
 */
export interface HangFoldsBatched {
  state: Map<number, AndroidHangStateRow[]>;
  gc: Map<number, AndroidHangGcRow[]>;
}

export interface HangWindowInput {
  /** Caller's stable index. Returned untouched in the output maps. */
  hangIndex: number;
  /** Hang start in NATIVE (CLOCK_MONOTONIC) ns — not trace-relative. */
  startNs: number;
  /** Hang end in NATIVE (CLOCK_MONOTONIC) ns — not trace-relative. */
  endNs: number;
}

export interface RunBatchedHangFoldsOptions {
  tracePath: string;
  /** Sanitised process / package name. Caller validates the alphabet. */
  target: string;
  hangs: HangWindowInput[];
}

/**
 * Compute main-thread state breakdown + GC overlap for ALL hang windows in one
 * trace_processor_shell invocation, replacing the legacy per-hang loop (the
 * per-hang work moves into a JOIN over a runtime-built `argent_hang_windows`
 * table). On failure the promise rejects and the pipeline degrades every hang
 * to empty folds.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "4. The per-hang fold: batched, not looped"
 *
 * Schema invariants:
 *   • Each hang's `startNs`/`endNs` is inlined into SQL as bare digits — not
 *     quoted — so any non-numeric input produces a SQL syntax error rather than
 *     an injection. We assert finite non-negative integers for defence-in-depth.
 *   • `target` must already be validated against the package alphabet; it's
 *     wrapped in single quotes with literal `'` disallowed.
 */
export async function runBatchedHangFolds(
  opts: RunBatchedHangFoldsOptions
): Promise<HangFoldsBatched> {
  const empty: HangFoldsBatched = { state: new Map(), gc: new Map() };
  if (opts.hangs.length === 0) return empty;

  opts.target = sanitizeProcessName(opts.target);
  const valuesTuples: string[] = [];
  for (const hang of opts.hangs) {
    assertSafeWindow(hang);
    valuesTuples.push(`(${hang.hangIndex},${hang.startNs},${hang.endNs})`);
  }

  // SQL lives in queries/hang-folds-batched.sql; we only build the validated
  // VALUES tuples (bare digits) + already-validated target and fill the template.
  const templatePath = path.join(traceProcessorQueriesDir(), "hang-folds-batched.sql");
  const template = await fs.readFile(templatePath, "utf8");
  const sql = renderSqlTemplate(template, {
    HANG_WINDOWS_VALUES: valuesTuples.join(",\n  "),
    TARGET_PROCESS: opts.target,
  });

  interface BatchRow {
    hang_index: number;
    row_kind: "state" | "gc";
    state_v: string | null;
    blocked_function_v: string | null;
    total_dur_ns_v: string | number | null;
    occurrences_v: string | number | null;
    gc_reason_v: string | null;
    gc_ts_ns_v: string | number | null;
    gc_dur_ns_v: string | number | null;
  }

  const rows = await runTpInline<BatchRow>({ tracePath: opts.tracePath, sql });

  const result: HangFoldsBatched = { state: new Map(), gc: new Map() };
  for (const row of rows) {
    if (row.row_kind === "state") {
      const total_dur_ns = toFiniteNumber(row.total_dur_ns_v);
      const occurrences = toFiniteNumber(row.occurrences_v);
      if (total_dur_ns == null || occurrences == null || row.state_v == null) continue;
      const list = result.state.get(row.hang_index) ?? [];
      list.push({
        state: row.state_v,
        blocked_function: row.blocked_function_v,
        total_dur_ns,
        occurrences,
      });
      result.state.set(row.hang_index, list);
    } else if (row.row_kind === "gc") {
      const ts_ns = toFiniteNumber(row.gc_ts_ns_v);
      const dur_ns = toFiniteNumber(row.gc_dur_ns_v);
      if (ts_ns == null || dur_ns == null || row.gc_reason_v == null) continue;
      const list = result.gc.get(row.hang_index) ?? [];
      list.push({ gc_reason: row.gc_reason_v, ts_ns, dur_ns });
      result.gc.set(row.hang_index, list);
    }
  }
  return result;
}

function assertSafeWindow(hang: HangWindowInput): void {
  if (
    !Number.isInteger(hang.hangIndex) ||
    !Number.isInteger(hang.startNs) ||
    !Number.isInteger(hang.endNs) ||
    hang.hangIndex < 0 ||
    hang.startNs < 0 ||
    hang.endNs < 0
  ) {
    throw new Error(
      `runBatchedHangFolds: refusing to inline non-integer/negative hang window: ${JSON.stringify(hang)}`
    );
  }
}

function toFiniteNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
