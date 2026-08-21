import * as fs from "node:fs";
import * as path from "node:path";

const WORKSPACE_ROOT = path.resolve(__dirname, "../../../..");

/**
 * Fixture scripts live under the workspace's own `node_modules`.
 *
 * A script under `os.tmpdir()` cannot resolve a bare specifier — Node walks up
 * from the script file looking for `node_modules`, and a temp directory has no
 * ancestor that holds one. Every ancestor of this directory ends at
 * `<workspace>/node_modules`, so `import YAML from "yaml"` resolves exactly the
 * way it would from a real project script. `node_modules` is git-ignored, so a
 * fixture left behind by a crashed run never dirties the tree.
 */
const FIXTURE_ROOT = path.join(WORKSPACE_ROOT, "node_modules", ".cache", "argent-flow-scripts");

export interface ScriptWorkspace {
  /** An empty directory that can act as a `project_root`. */
  readonly dir: string;
  /** Write a fixture script and return its absolute path. */
  write(name: string, source: string): string;
  /** Absolute path inside the workspace, whether or not it exists. */
  resolve(name: string): string;
  cleanup(): void;
}

let counter = 0;

/** Fixtures older than this belong to a run that crashed before its cleanup. */
const STALE_FIXTURE_MS = 60 * 60 * 1000;

export function createScriptWorkspace(label = "ws"): ScriptWorkspace {
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  pruneStaleFixtures();
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, `${label}-`));
  return {
    dir,
    write(name, source) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      return file;
    },
    resolve(name) {
      return path.join(dir, name);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Drop what a crashed run left behind.
 *
 * Every workspace cleans up after itself, but a killed suite does not — and the
 * root is under `node_modules`, so nothing else ever sweeps it. The age bound is
 * what makes this safe beside a concurrent run: an hour is far longer than the
 * whole suite takes, so a fixture another vitest worker is using now is never
 * old enough to be taken.
 */
function pruneStaleFixtures(): void {
  const cutoff = Date.now() - STALE_FIXTURE_MS;
  let entries: string[];
  try {
    entries = fs.readdirSync(FIXTURE_ROOT);
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(FIXTURE_ROOT, entry);
    try {
      if (fs.statSync(candidate).mtimeMs > cutoff) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Raced with another worker's own cleanup, which is the outcome wanted.
    }
  }
}

/** A name no two concurrent fixtures share. */
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}

/** The workspace-source layout: the `.mjs` files sit beside the executor source. */
export const SOURCE_RUNNER_DIR = path.resolve(__dirname, "../../src/tools/flows/script");
