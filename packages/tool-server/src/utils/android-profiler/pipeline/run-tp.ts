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
 * Run a SQL query file against a .pftrace via the in-process Perfetto WASM
 * engine, returning decoded rows. For multi-statement scripts the engine returns
 * the final statement's result set, so callers needn't demultiplex blocks.
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
 * Run a fully-rendered SQL string against a .pftrace using the in-process WASM
 * engine. The engine is kept warm per trace path (loaded once, reused across the
 * whole pipeline + drill-downs), so batching many statements into one script is
 * no longer required for performance — but still works.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "4. The per-hang fold: batched, not looped"
 */
export async function runTpInline<Row = Record<string, unknown>>(
  opts: RunTpInlineOptions
): Promise<Row[]> {
  return queryWarm<Row>(opts.tracePath, opts.sql);
}
