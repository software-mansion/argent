import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `paths:` filter of the Windows job, held to the rule its own comment
 * states: "editing one changes what this job runs without touching any file
 * listed above it".
 *
 * Named files rot. The filter was written file by file and left 18 of the 33
 * files in the three listed test files' import graph out of the list — including
 * `configuration-core/src/paths.ts`, which holds the `USERPROFILE` branch one
 * of those tests asserts the global config path against, and
 * `registry/src/file-inputs.ts`, where `SCRIPT_FILE_NAME_PATTERN` gained `sh`.
 * A pull request touching either ran no Windows job at all.
 *
 * Imports are resolved to the source a change is made in: `@argent/<pkg>` to
 * that package's `src` (the workspace loads its `dist`, which the job builds
 * from `src` before testing), a relative `./x.js` to the `./x.ts` beside it.
 */
const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");

const WORKFLOW = ".github/workflows/windows-e2e.yml";

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
 * across them, and everything else but `?` is a literal.
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
    // line names reach far more of the tool server than this filter lists, and
    // covering those is not this rule's job — the filter never claimed them.
    const seeds = [...workflow.matchAll(/^ {10}(test\/flows\/script\/[^\s]+\.test\.ts)$/gm)].map(
      (match) => `packages/tool-server/${match[1]!}`
    );
    expect(seeds).toHaveLength(3);
    for (const seed of seeds) {
      expect(fs.existsSync(path.join(WORKSPACE_ROOT, seed))).toBe(true);
    }

    const unmatched = importGraph(seeds).filter((file) => !covers(file));

    expect(unmatched).toEqual([]);
  });

  it("names the three files that carry the Windows tree kill", () => {
    // `taskkill /t` is the whole of what reaches bash and its descendants where
    // there is no process group. Besides the executor, which aims it at the
    // runner from outside, these three carry it: the deadline watchdog holds it,
    // and the other two import it from there.
    const dir = "packages/tool-server/src/tools/flows/script";
    const read = (name: string) => fs.readFileSync(path.join(WORKSPACE_ROOT, dir, name), "utf8");
    expect(read("flow-script-watchdog-deadline.mjs")).toContain("taskkill");
    for (const name of ["flow-script-runner.mjs", "flow-script-watchdog-lifeline.mjs"]) {
      expect(read(name)).toContain('from "./flow-script-watchdog-deadline.mjs"');
    }
    for (const name of [
      "flow-script-runner.mjs",
      "flow-script-watchdog-deadline.mjs",
      "flow-script-watchdog-lifeline.mjs",
    ]) {
      expect(covers(`${dir}/${name}`)).toBe(true);
    }
  });
});
