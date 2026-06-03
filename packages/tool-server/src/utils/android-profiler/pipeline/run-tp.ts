import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as path from "path";
import {
  traceProcessorShellPath,
  traceProcessorQueriesDir,
  isExecFormatError,
  wrongArchError,
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
   * `{{NAME}}` → replacement map for `renderSqlTemplate`. Values are interpolated
   * into SQL (not parameterised), so callers must validate them first.
   * rationale: queries/README.md "`{{NAME}}` template tokens"
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
 * Run a SQL query file against a .pftrace via trace_processor_shell, returning
 * parsed rows. `-q <file>` emits CSV on stdout (strings quoted, numbers bare,
 * NULL as `[NULL]`); for multi-statement scripts only the final SELECT reaches
 * stdout, so the parser needn't demultiplex blocks.
 */
export async function runTpQuery<Row = Record<string, unknown>>(
  opts: RunTpQueryOptions
): Promise<Row[]> {
  const queryPath = path.join(traceProcessorQueriesDir(), opts.query);
  const template = await fs.readFile(queryPath, "utf8");
  const sql = renderSqlTemplate(template, opts.substitutions);
  return runTpInline<Row>({ tracePath: opts.tracePath, sql });
}

/**
 * Resolve `{{NAME}}` placeholders in a SQL template against a substitution map.
 * Validates both directions: a placeholder with no substitution throws (with the
 * token name, clearer than the downstream SQLite error), and a substitution the
 * template never references also throws (catching a stale/renamed token).
 *
 * Values are inserted via a function replacer, so `$`-sequences in a value are
 * NOT treated as `String.replace` special patterns.
 * rationale: queries/README.md "`{{NAME}}` template tokens"
 */
export function renderSqlTemplate(
  template: string,
  substitutions: Record<string, string>
): string {
  const used = new Set<string>();
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = substitutions[name];
    if (value === undefined) {
      throw new Error(
        `SQL template references {{${name}}} but no substitution was provided`
      );
    }
    used.add(name);
    return value;
  });
  const unused = Object.keys(substitutions).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(
      `Substitution(s) provided but not referenced by the template: ${unused.join(", ")}`
    );
  }
  return rendered;
}

/**
 * Run a fully-rendered SQL string against a .pftrace. Each invocation pays the
 * trace-load cost once, so batch many queries into one script rather than looping.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "4. The per-hang fold: batched, not looped"
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
  } catch (err) {
    // A wrong-arch binary (e.g. a Linux ELF shipped to a macOS host) fails to
    // exec with ENOEXEC / "exec format error". Surface it as the actionable
    // TraceProcessorUnavailableError so the analyze path renders the
    // download-dependencies banner instead of a cryptic per-query failure.
    if (isExecFormatError(err)) throw wrongArchError(err);
    throw err;
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
