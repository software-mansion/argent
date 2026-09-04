import * as fs from "node:fs";
import * as path from "node:path";
import semver from "semver";
import { argentHomeDir } from "@argent/configuration-core";
import {
  argentBinSubpath,
  getGloballyInstalledPackageRoot,
  getLocalArgentBinRelPath,
} from "./topology.js";
import type { InstallMode } from "./install-record.js";

/**
 * `~/.argent/cli.json` — where argent's CLI can be found, written by
 * `init`/`update`.
 *
 * This exists for external device providers, which publish their devices by
 * spawning `argent providers publish`. The obvious transport, `argent` from
 * `PATH`, is unreliable. Extension hosts inherit a `PATH` that often lacks the
 * user's node version manager and argent's local install mode never puts
 * `argent` on `PATH` at all. Recording absolute `node` and `cli.js` paths lets
 * a provider spawn `[node, cli, ...args]` with no shell, which also sidesteps
 * Windows `.cmd` shims.
 *
 * An nvm prune or a moved install makes it stale. `init`/`update` rewrite it
 * unconditionally, and `argent mcp` heals it at startup (see
 * {@linkcode healCliRecord}) — that covers installs `init` never touched, like
 * a committed devDependency set up with plain `npm install`. A provider that
 * still cannot resolve a CLI falls back to PATH and then goes quietly dark, the
 * descriptor file remains the contract of record.
 *
 * Last writer wins, except the heal. It defers to a live, not-older record, so
 * the record converges on the newest install that actually runs.
 */
interface CliRecord {
  /** Absolute path to the CLI entrypoint (`<install>/dist/cli.js`). */
  cli: string;
  /**
   * `uninstall` decides ownership by comparing paths, not this.
   * `scripts/dev.cjs` writes `"dev"` for a record naming a repo checkout.
   */
  mode: InstallMode | "dev";
  /** Absolute path to the node binary that install was run with. */
  node: string;
  updatedAt: string;
  version: string;
}

export function cliRecordPath(): string {
  return path.join(argentHomeDir(), "cli.json");
}

export function readCliRecord(): CliRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cliRecordPath(), "utf8")) as CliRecord;
    if (typeof parsed?.cli === "string" && typeof parsed?.node === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Absolute path to the CLI entrypoint of the install `mode` describes or null
 * when it cannot be resolved (not installed, Yarn PnP with no `node_modules`,
 * or a layout the probes don't understand).
 */
function resolveCliEntry(mode: InstallMode, projectRoot: string): string | null {
  if (mode === "local") {
    const relative = getLocalArgentBinRelPath(projectRoot);
    return relative ? path.resolve(projectRoot, relative) : null;
  }

  const packageRoot = getGloballyInstalledPackageRoot();
  if (!packageRoot) return null;
  const binSub = argentBinSubpath(packageRoot);
  if (!binSub) return null;
  const entry = path.join(packageRoot, binSub);
  return fs.existsSync(entry) ? entry : null;
}

/**
 * Record where this install's CLI lives. Returns the path written, or `null`
 * when there was nothing to record or the write failed.
 *
 * Never throws. A machine that cannot write `~/.argent` was never going to run
 * this integration anyway, and failing an otherwise-good `init` over it would
 * be absurd.
 */
export function writeCliRecord(input: {
  mode: InstallMode;
  projectRoot: string;
  version: string;
}): string | null {
  const cli = resolveCliEntry(input.mode, input.projectRoot);

  if (!cli) return null;

  return persistCliRecord({
    cli,
    mode: input.mode,
    node: process.execPath,
    updatedAt: new Date().toISOString(),
    version: input.version,
  });
}

function persistCliRecord(record: CliRecord): string | null {
  const file = cliRecordPath();

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    /**
     * tmp + rename: a provider may be reading this to decide how to spawn and
     * half a document would send it down the PATH fallback for no reason.
     */
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n");
    fs.renameSync(temporary, file);
    return file;
  } catch {
    return null;
  }
}

/**
 * Refresh the record from a running install; called on `argent mcp` startup.
 * On some machines `init`/`update` never run (a committed devDependency set up
 * with plain `npm install`) and an nvm prune can strand the record. Every MCP
 * start proves a working CLI at a known path, so heal here.
 *
 * Unlike `writeCliRecord`, this defers to a record whose paths are alive and
 * whose version is not older, so the record converges on the newest running
 * install instead of flapping between installs on every editor session. An
 * unparseable version counts as older.
 *
 * Never throws, like {@linkcode writeCliRecord}.
 */
export function healCliRecord(input: {
  /** Absolute path to this install's `dist/cli.js`. */
  cli: string;
  mode: InstallMode | "dev";
  version: string | null;
}): string | null {
  try {
    if (!fs.existsSync(input.cli)) return null;

    const existing = readCliRecord();

    if (existing) {
      const alive = fs.existsSync(existing.node) && fs.existsSync(existing.cli);
      const ourVersion = semver.valid(input.version);
      const theirVersion = semver.valid(existing.version);
      const newerThanExisting =
        ourVersion !== null && (theirVersion === null || semver.gt(ourVersion, theirVersion));

      if (alive && !newerThanExisting) return null;
    }

    return persistCliRecord({
      cli: input.cli,
      mode: input.mode,
      node: process.execPath,
      updatedAt: new Date().toISOString(),
      version: input.version ?? "unknown",
    });
  } catch {
    return null;
  }
}

/**
 * Remove the record, but only when it points inside `installDir`. Returns
 * `true` when it did.
 *
 * The guard is the whole point: a global and a local install can coexist, and
 * removing the record unconditionally would leave providers unable to find a
 * CLI that is still perfectly well installed.
 */
export function removeCliRecordFor(installDir: string | null): boolean {
  if (!installDir) return false;

  const record = readCliRecord();
  if (!record) return false;

  const root = path.resolve(installDir);
  const relative = path.relative(root, path.resolve(record.cli));

  /**
   * Climbing out with `..` (or an absolute path, which happens across Windows
   * drives) means the recorded CLI belongs to some other install.
   */
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;

  try {
    fs.rmSync(cliRecordPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}
