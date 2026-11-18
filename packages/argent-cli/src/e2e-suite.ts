import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { FLOW_NAME_PATTERN } from "@argent/registry";

/** A directory that holds this file is a suite. */
export const SUITE_CONFIG_FILE = "suite.config.yaml";

export interface SuiteConfig {
  /** Test names (no `.yaml`) in run order; absent means file name order. */
  tests?: string[];
  continueOnFailure: boolean;
}

export class SuiteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuiteConfigError";
  }
}

const SUITE_CONFIG_KEYS = ["tests", "continueOnFailure"];

/** Validates the text of a suite manifest; throws SuiteConfigError when it is invalid. */
export function parseSuiteConfig(text: string): SuiteConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text, { logLevel: "error" });
  } catch (err) {
    throw new SuiteConfigError(
      `not valid YAML: ${(err instanceof Error ? err.message : String(err)).trimEnd()}`
    );
  }
  if (doc === null || doc === undefined) return { continueOnFailure: false };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new SuiteConfigError(
      `must be a YAML map with the keys ${SUITE_CONFIG_KEYS.join(" and ")}`
    );
  }
  const map = doc as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (!SUITE_CONFIG_KEYS.includes(key)) {
      throw new SuiteConfigError(
        `unknown key ${JSON.stringify(key)}; the allowed keys are ${SUITE_CONFIG_KEYS.join(" and ")}`
      );
    }
  }
  const config: SuiteConfig = { continueOnFailure: false };
  if ("continueOnFailure" in map) {
    if (typeof map.continueOnFailure !== "boolean") {
      throw new SuiteConfigError("continueOnFailure must be true or false");
    }
    config.continueOnFailure = map.continueOnFailure;
  }
  if ("tests" in map) {
    const entries = map.tests;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new SuiteConfigError("tests must be a non-empty list of test names");
    }
    const names: string[] = [];
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string") {
        throw new SuiteConfigError(
          `tests entry ${index + 1} is not a string; put the test name in quotes`
        );
      }
      const name = entry.endsWith(".yaml") ? entry.slice(0, -".yaml".length) : entry;
      if (!FLOW_NAME_PATTERN.test(name)) {
        throw new SuiteConfigError(`tests entry ${JSON.stringify(entry)} is not a valid test name`);
      }
      if (names.includes(name)) {
        throw new SuiteConfigError(`tests lists ${JSON.stringify(name)} more than once`);
      }
      names.push(name);
    }
    config.tests = names;
  }
  return config;
}

async function readSuiteConfig(dir: string): Promise<SuiteConfig> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, SUITE_CONFIG_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new SuiteConfigError(
      `could not read the file: ${code ?? (err instanceof Error ? err.message : String(err))}`
    );
  }
  return parseSuiteConfig(text);
}

export interface Suite {
  /** Relative to the run directory; "." is the run directory itself. */
  dir: string;
  /** The manifest path relative to the run directory. */
  manifest: string;
  continueOnFailure: boolean;
}

export type RunPlanEntry =
  | {
      kind: "test";
      /** Relative to the run directory, as collected. */
      path: string;
      /** The same object for every test of one suite; absent for an independent test. */
      suite?: Suite;
    }
  | {
      kind: "invalid-suite";
      dir: string;
      manifest: string;
      /** The reason, prefixed with the manifest path. */
      message: string;
      /** The reason alone. */
      error: string;
      /** The collected tests of the directory, which do not run. */
      tests: string[];
    };

export interface RunPlan {
  entries: RunPlanEntry[];
  /** The collected files a suite's `tests` does not name; such a file is in no entry. */
  unlisted: { path: string; suite: Suite }[];
}

export function unlistedWarning(file: string, manifest: string): string {
  return `${file} is not listed in the tests of ${manifest} and does not run`;
}

/**
 * The run order of a directory run. `collected` are the sorted test paths
 * relative to `runDir`, and `manifests` the suite manifest paths that the same
 * walk found. A suite takes the position of the first collected file of its
 * directory, or of its manifest when the directory has none; everything else
 * keeps the collected order.
 */
export async function planDirectoryRun(
  runDir: string,
  collected: readonly string[],
  manifests: readonly string[]
): Promise<RunPlan> {
  const byDir = new Map<string, string[]>();
  for (const rel of collected) {
    const dir = path.dirname(rel);
    const files = byDir.get(dir);
    if (files) files.push(rel);
    else byDir.set(dir, [rel]);
  }
  const testless = manifests.filter((manifest) => !byDir.has(path.dirname(manifest)));

  const suiteEntries = new Map<string, RunPlanEntry[]>();
  const unlisted: RunPlan["unlisted"] = [];
  for (const dir of new Set(manifests.map((manifest) => path.dirname(manifest)))) {
    const files = byDir.get(dir) ?? [];
    const manifest = path.join(dir, SUITE_CONFIG_FILE);
    let config: SuiteConfig;
    let ordered = files;
    try {
      config = await readSuiteConfig(path.join(runDir, dir));
      if (config.tests) {
        ordered = config.tests.map((name) => {
          const file = files.find((f) => path.basename(f, ".yaml") === name);
          if (file === undefined) {
            throw new SuiteConfigError(
              `tests entry ${JSON.stringify(name)} names no e2e test in this directory`
            );
          }
          return file;
        });
      }
    } catch (err) {
      if (!(err instanceof SuiteConfigError)) throw err;
      suiteEntries.set(dir, [
        {
          kind: "invalid-suite",
          dir,
          manifest,
          message: `${manifest}: ${err.message}`,
          error: err.message,
          tests: files,
        },
      ]);
      continue;
    }
    const suite: Suite = { dir, manifest, continueOnFailure: config.continueOnFailure };
    suiteEntries.set(
      dir,
      ordered.map((file) => ({ kind: "test", path: file, suite }))
    );
    for (const file of files) {
      if (!ordered.includes(file)) unlisted.push({ path: file, suite });
    }
  }

  const entries: RunPlanEntry[] = [];
  for (const rel of [...collected, ...testless].sort()) {
    const dir = path.dirname(rel);
    const inSuite = suiteEntries.get(dir);
    if (inSuite === undefined) entries.push({ kind: "test", path: rel });
    else if ((byDir.get(dir)?.[0] ?? rel) === rel) entries.push(...inSuite);
  }
  return { entries, unlisted };
}
