import { promises as fs } from "fs";
import * as path from "path";
import { traceProcessorQueriesDir } from "@argent/native-devtools-android";
import { runTpInline, renderSqlTemplate } from "./run-tp";
import { sanitizeProcessName } from "./sql-safety";
import type { AndroidHangStateRow, AndroidHangGcRow } from "../types";

/**
 * Per-hang annotation rows keyed by the caller's hang index. A hang with no
 * matching rows has no entry at all.
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
  /** Process / package name; validated against the package alphabet here. */
  target: string;
  hangs: HangWindowInput[];
}

/**
 * Main-thread state breakdown + GC overlap for ALL hang windows in one query:
 * the per-hang work becomes a JOIN over a runtime-built `argent_hang_windows`
 * table. Rejects on failure; the pipeline then degrades every hang to empty folds.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "4. The per-hang fold: batched, not looped"
 *
 * Injection safety:
 *   • `startNs`/`endNs` are inlined as bare unquoted digits, so non-numeric
 *     input yields a SQL syntax error rather than an injection;
 *     `assertSafeWindow` is defence-in-depth.
 *   • `target` is single-quoted in the template, and the package alphabet
 *     disallows a literal `'`.
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
