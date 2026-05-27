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

export interface RunTpInlineOptions {
  /** Path to the on-host .pftrace. */
  tracePath: string;
  /** Fully-rendered SQL — no token substitution performed. */
  sql: string;
}

/**
 * Run a SQL query against a .pftrace using trace_processor_shell, returning
 * the parsed rows. trace_processor_shell's `-q <file>` emits CSV on stdout
 * by default (header + one row per result, strings quoted, numbers bare,
 * NULL as `[NULL]`). All log noise goes to stderr, which `execFileAsync`
 * does not capture. For multi-statement scripts only the final SELECT's
 * rows reach stdout, so the parser does not need to demultiplex blocks.
 */
export async function runTpQuery<Row = Record<string, unknown>>(
  opts: RunTpQueryOptions
): Promise<Row[]> {
  const queryPath = path.join(traceProcessorQueriesDir(), opts.query);
  const template = await fs.readFile(queryPath, "utf8");
  let sql = template;
  for (const [token, value] of Object.entries(opts.substitutions)) {
    sql = sql.replaceAll(token, value);
  }
  return runTpInline<Row>({ tracePath: opts.tracePath, sql });
}

/**
 * Run a fully-rendered SQL string against a .pftrace. Used by the batched
 * hang-fold path, which composes SQL in-memory from a runtime hang list
 * rather than from a static `queries/*.sql` template.
 *
 * Each invocation still pays the trace_processor_shell trace-load cost
 * (~1.3 s for a 76 MB trace) — callers that need to run many queries should
 * fold them into a single SQL script using CREATE PERFETTO VIEW + a
 * terminal UNION SELECT, not loop this function.
 */
export async function runTpInline<Row = Record<string, unknown>>(
  opts: RunTpInlineOptions
): Promise<Row[]> {
  const tpPath = traceProcessorShellPath();
  const tmpSql = path.join(
    path.dirname(opts.tracePath),
    `.argent-tp-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`
  );
  await fs.writeFile(tmpSql, opts.sql, "utf8");
  try {
    const { stdout } = await execFileAsync(
      tpPath,
      ["-q", tmpSql, opts.tracePath],
      { timeout: QUERY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }
    );
    return parseTpCsvOutput<Row>(stdout);
  } finally {
    await fs.unlink(tmpSql).catch(() => {
      // best-effort cleanup
    });
  }
}

export function parseTpCsvOutput<Row = Record<string, unknown>>(stdout: string): Row[] {
  const rows = parseCsv(stdout);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((cell) => coerceHeader(cell));
  return rows.slice(1).map((cells) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]!] = coerce(cells[i]);
    }
    return row as Row;
  }) as Row[];
}

function coerceHeader(raw: string | undefined): string {
  if (raw === undefined) return "";
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replaceAll('""', '"');
  }
  return raw;
}

function coerce(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1).replaceAll('""', '"');
    if (inner === "[NULL]") return null;
    return inner;
  }
  if (raw === "[NULL]" || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

/**
 * RFC-4180-ish CSV parser as a state machine. Cells preserve their outer
 * quotes when quoted in the input — the caller's `coerce` uses the leading
 * `"` to tell quoted strings from bare tokens. Newlines inside a quoted
 * cell extend the current cell; newlines elsewhere terminate the row.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuoted = false;
  let cellStartedQuoted = false;

  const pushCell = (): void => {
    row.push(cellStartedQuoted ? `"${cell}"` : cell);
    cell = "";
    cellStartedQuoted = false;
  };
  const pushRow = (): void => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (inQuoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '""';
          i++;
        } else {
          inQuoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuoted = true;
      cellStartedQuoted = true;
      continue;
    }

    if (ch === ",") {
      pushCell();
      continue;
    }

    if (ch === "\n") {
      pushRow();
      continue;
    }

    if (ch === "\r") {
      // Swallow CR; the LF (if present) handles the row break.
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || cellStartedQuoted || row.length > 0) {
    pushRow();
  }

  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}
