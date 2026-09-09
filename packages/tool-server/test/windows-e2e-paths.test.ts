import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `paths:` filter of the Windows job, held to the rule its own comment
 * states: "editing one changes what this job runs without touching any file
 * listed above it".
 *
 * Named files rot. The filter was written file by file and left 18 of the 33
 * files imported by the three test files it listed at the time out of the
 * list — including `configuration-core/src/paths.ts`, which holds the
 * `USERPROFILE` branch one of those tests asserts the global config path
 * against, and `registry/src/file-inputs.ts`, where
 * `SCRIPT_FILE_NAME_PATTERN` gained `sh`. A pull request touching either ran
 * no Windows job at all.
 *
 * Imports are resolved the way the workspace resolves them: `@argent/<pkg>` to
 * that package's `src`, a relative `./x.js` to the `./x.ts` beside it.
 */
const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");

const WORKFLOW = ".github/workflows/windows-e2e.yml";

/** Importing this reaches every tool the registry holds, and most of the server. */
const WHOLE_SERVER = "packages/tool-server/src/tools/flows/flow-run.ts";

const PACKAGE_SOURCES: Record<string, string> = {
  "@argent/configuration-core": "packages/configuration-core/src",
  "@argent/registry": "packages/registry/src",
};

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

const PATHS_ENTRY_RE = /^\s+- "([^"]+)"$/gm;

function resolveImport(from: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(from), specifier);
  } else {
    const pkg = Object.keys(PACKAGE_SOURCES).find(
      (name) => specifier === name || specifier.startsWith(`${name}/`)
    );
    if (!pkg) return undefined;
    const rest = specifier.slice(pkg.length).replace(/^\//, "");
    base = path.posix.join(PACKAGE_SOURCES[pkg]!, rest === "" ? "index" : rest);
  }
  base = base.replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, `${base}.mjs`, `${base}.tsx`, `${base}/index.ts`]) {
    if (fs.existsSync(path.join(WORKSPACE_ROOT, candidate))) return candidate;
  }
  return undefined;
}

/** Every workspace file the seeds reach, the seeds themselves included. */
function importGraph(seeds: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = fs.readFileSync(path.join(WORKSPACE_ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(file, match[1]!);
      if (resolved) pending.push(resolved);
    }
  }
  return [...seen].sort();
}

/**
 * A GitHub `paths:` entry as a pattern: `*` matches inside one segment, `**`
 * across them, and everything else is a literal.
 *
 * Split rather than substituted. A sentinel character stood in for `**` here
 * once, and the one chosen was invisible: it read as a space and was a NUL, so
 * the file carried a control character into a regular expression that eslint
 * refuses.
 */
function entryMatcher(entry: string): (file: string) => boolean {
  if (!entry.includes("*")) return (file) => file === entry;
  const pattern = entry
    .split("**")
    .map((across) =>
      across
        .split("*")
        .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")
    )
    .join(".*");
  const re = new RegExp(`^${pattern}$`);
  return (file) => re.test(file);
}

describe("the Windows job's path filter", () => {
  const workflow = fs.readFileSync(path.join(WORKSPACE_ROOT, WORKFLOW), "utf8");
  const listed = [...workflow.matchAll(PATHS_ENTRY_RE)].map((match) => match[1]!);
  const matchers = listed.map(entryMatcher);
  const covers = (file: string): boolean => matchers.some((matches) => matches(file));

  it("names every file the .sh tests it runs import", () => {
    // The `.sh` cases the job's own `vitest run` line names, read from that
    // line so the two lists cannot drift apart. The seven other files that
    // line names reach most of the tool server between them, and covering
    // those is not this rule's job — the filter never claimed them.
    //
    // The count is what makes the rule below discriminating: the pattern is
    // indent-sensitive, and over no seeds `unmatched` is vacuously empty, so a
    // re-indented workflow would pass this having checked nothing. Adding a
    // `.sh` case to the job means raising this number in the same commit.
    const seeds = [...workflow.matchAll(/^ {10}(test\/flows\/script\/[^\s]+\.test\.ts)$/gm)].map(
      (match) => `packages/tool-server/${match[1]!}`
    );
    expect(seeds).toHaveLength(6);
    for (const seed of seeds) {
      expect(fs.existsSync(path.join(WORKSPACE_ROOT, seed))).toBe(true);
    }

    // A seed that reaches `flow-run.ts` reaches every tool behind the registry
    // with it: 164 files for `flow-script-env.test.ts` against 31 for each of
    // the others. That puts it with the seven above rather than here, for the
    // same reason - naming a graph that size file by file would run this job on
    // nearly every pull request, which is the opposite of what a path filter is
    // for. The entries such a seed does need are named in the filter by hand,
    // each beside the reason it decides a Windows outcome.
    const narrow = seeds.filter((seed) => !importGraph([seed]).includes(WHOLE_SERVER));
    expect(narrow.length).toBeGreaterThan(0);

    const unmatched = importGraph(narrow).filter((file) => !covers(file));

    expect(unmatched).toEqual([]);
  });

  it("names the three files that carry the Windows tree kill", () => {
    // `taskkill /t` is the whole of what reaches bash and its descendants where
    // there is no process group, and it lives in these three alone.
    for (const file of [
      "packages/tool-server/src/tools/flows/script/flow-script-runner.mjs",
      "packages/tool-server/src/tools/flows/script/flow-script-watchdog-deadline.mjs",
      "packages/tool-server/src/tools/flows/script/flow-script-watchdog-lifeline.mjs",
    ]) {
      expect(fs.readFileSync(path.join(WORKSPACE_ROOT, file), "utf8")).toContain("taskkill");
      expect(covers(file)).toBe(true);
    }
  });
});
