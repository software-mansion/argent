import { promises as fs } from "fs";
import * as path from "path";
import { traceProcessorQueriesDir, queryWarm } from "@argent/native-devtools-android";

export interface RunTpQueryOptions {
  /** Path to the on-host .pftrace. */
  tracePath: string;
  /** Filename in queries/ (e.g. "cpu-hotspots.sql"). */
  query: string;
  /**
   * `{{NAME}}` → replacement map for `renderSqlTemplate`. Values are interpolated
   * into SQL, not parameterised, so callers must validate them first.
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
 * Run a SQL query file from queries/ against a .pftrace. For multi-statement
 * scripts the engine returns only the final statement's result set.
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
 * Resolve `{{NAME}}` placeholders in a SQL template. Throws both ways: an
 * unsubstituted placeholder (clearer than the downstream SQLite error) and an
 * unreferenced substitution (catches a stale/renamed token). The function
 * replacer keeps `$`-sequences in values out of `String.replace` expansion.
 * rationale: queries/README.md "`{{NAME}}` template tokens"
 */
export function renderSqlTemplate(template: string, substitutions: Record<string, string>): string {
  const used = new Set<string>();
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = substitutions[name];
    if (value === undefined) {
      throw new Error(`SQL template references {{${name}}} but no substitution was provided`);
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
 * Run a fully-rendered SQL string against a .pftrace. The WASM engine is kept
 * warm per trace path (reused across pipeline queries and drill-downs), so
 * batching statements into one script is not needed for performance.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "4. The per-hang fold: batched, not looped"
 */
export async function runTpInline<Row = Record<string, unknown>>(
  opts: RunTpInlineOptions
): Promise<Row[]> {
  return queryWarm<Row>(opts.tracePath, opts.sql);
}
