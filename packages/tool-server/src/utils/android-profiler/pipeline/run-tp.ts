import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as path from "path";
import {
  traceProcessorShellPath,
  traceProcessorQueriesDir,
} from "@argent/native-devtools-android";

const execFileAsync = promisify(execFile);

const QUERY_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface RunTpQueryOptions {
  /** Path to the on-host .pftrace. */
  tracePath: string;
  /** Filename in queries/ (e.g. "cpu-hotspots.sql"). */
  query: string;
  /**
   * Token → replacement substitutions applied before running. Used for
   * TARGET_PROCESS, HANG_START_NS, HANG_END_NS, THREAD_NAME, FUNCTION_NAME.
   * Values are NOT shell-escaped — they're interpolated into SQL via a
   * tempfile, not a shell command. Callers are expected to validate values
   * (numeric for ns; identifier-shaped for thread/function/process names).
   */
  substitutions: Record<string, string>;
}

/**
 * Run a SQL query against a .pftrace using trace_processor_shell, returning
 * the parsed JSON rows. trace_processor_shell's `-q <file> --query-output=json`
 * emits a single JSON object on stdout with `columns` + `values`; we
 * normalise that to a `Row[]` shape.
 */
export async function runTpQuery<Row = Record<string, unknown>>(
  opts: RunTpQueryOptions
): Promise<Row[]> {
  const tpPath = traceProcessorShellPath();
  const queryPath = path.join(traceProcessorQueriesDir(), opts.query);

  const template = await fs.readFile(queryPath, "utf8");
  let sql = template;
  for (const [token, value] of Object.entries(opts.substitutions)) {
    sql = sql.replaceAll(token, value);
  }

  const tmpSql = path.join(
    path.dirname(opts.tracePath),
    `.argent-tp-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`
  );
  await fs.writeFile(tmpSql, sql, "utf8");

  try {
    const { stdout } = await execFileAsync(
      tpPath,
      ["-q", tmpSql, "--query-output=json", opts.tracePath],
      { timeout: QUERY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }
    );
    return parseTpJsonOutput<Row>(stdout);
  } finally {
    await fs.unlink(tmpSql).catch(() => {
      // best-effort cleanup
    });
  }
}

interface TpJsonObject {
  android_logs?: unknown;
  columns?: string[];
  values?: unknown[][];
  /** Newer trace_processor_shell wraps query results under a top-level `query` array. */
  query?: TpJsonObject[];
}

/**
 * Normalise trace_processor_shell's JSON output to a row-shaped array.
 *
 * trace_processor_shell prints one JSON object whose shape depends on its
 * version. The common cases we handle:
 *   - `{ columns: [...], values: [[...], ...] }` — legacy
 *   - `[{ ... }, { ... }]` — modern (one row object per result row)
 *   - Newline-delimited rows (`{...}\n{...}\n`) — rare but seen
 *   - `{ query: [{ columns, values }] }` — wrapper for multi-statement scripts
 */
export function parseTpJsonOutput<Row = Record<string, unknown>>(stdout: string): Row[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try top-level JSON parse first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Fallback: newline-delimited JSON
    const rows: Row[] = [];
    for (const line of trimmed.split("\n")) {
      const ln = line.trim();
      if (!ln) continue;
      rows.push(JSON.parse(ln) as Row);
    }
    return rows;
  }

  if (Array.isArray(parsed)) {
    return parsed as Row[];
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as TpJsonObject;
    if (Array.isArray(obj.query) && obj.query.length > 0) {
      // Multi-statement script: take the last result set (the one our SELECT
      // produces; earlier results are DDL like DROP VIEW / CREATE VIEW).
      return tpColumnsValuesToRows<Row>(obj.query[obj.query.length - 1]!);
    }
    return tpColumnsValuesToRows<Row>(obj);
  }

  return [];
}

function tpColumnsValuesToRows<Row>(obj: TpJsonObject): Row[] {
  if (!obj || !Array.isArray(obj.columns) || !Array.isArray(obj.values)) return [];
  const cols = obj.columns;
  return obj.values.map((rowArr) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]!] = rowArr[i];
    }
    return row as Row;
  });
}
