import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

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
