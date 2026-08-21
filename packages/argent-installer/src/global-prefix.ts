import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import pc from "picocolors";
import { PACKAGE_NAME } from "./constants.js";
import type { PackageManager } from "./package-manager.js";

// Where a package manager puts global installs, and whether this user can write
// there. Nix-managed toolchains are the motivating case: npm derives its global
// prefix from the node binary's own location, so under Nix it resolves inside
// the store — whose paths are mode 0555 and, on NixOS / nix-darwin, on a
// read-only mount. `npm install -g` there dies with EACCES for anyone but root,
// and what root writes Nix undoes, so init and update preflight it rather than
// run the install and hand the user npm's stack trace.

// Argument vector that makes each manager print a directory its global installs
// live under. Only npm's and pnpm's name the node_modules itself; yarn classic
// prints its parent and bun the bin directory it links shims into — near enough
// to answer "can this user write there", which is all the probe asks.
const GLOBAL_DIR_QUERY: Record<PackageManager, readonly string[]> = {
  npm: ["root", "-g"],
  pnpm: ["root", "-g"],
  // berry has no `global add` at all.
  yarn: ["global", "dir"],
  bun: ["pm", "bin", "-g"],
};

const QUERY_TIMEOUT_MS = 5_000;

function queryGlobalInstallDir(pm: PackageManager): string | null {
  let stdout: string;
  try {
    stdout = execFileSync(pm, [...GLOBAL_DIR_QUERY[pm]], {
      encoding: "utf8",
      timeout: QUERY_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  // Last non-empty line, so a manager that also chatters on stdout cannot
  // derail the path. execFileSync's contract is string | Buffer, and this
  // preflight must never be the thing that breaks an install that would work.
  const line = String(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return line !== undefined && path.isAbsolute(line) ? line : null;
}

/**
 * True when `target` is inside the Nix store. Honors NIX_STORE_DIR, which
 * rootless / relocated installs (nix-portable, `--store`) set to something
 * other than the /nix/store default.
 */
export function isNixStorePath(target: string): boolean {
  const storeDir = path.resolve(process.env.NIX_STORE_DIR || "/nix/store");
  const resolved = path.resolve(target);
  return resolved === storeDir || resolved.startsWith(storeDir + path.sep);
}

// Nearest ancestor of `dir` that exists — the directory an install would really
// have to create its entry in. `<prefix>/lib/node_modules` exists long before
// the `@swmansion` scope directory under it does.
function nearestExistingDir(dir: string): string | null {
  let current = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // Missing or unstattable — keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface GlobalInstallTarget {
  /** Existing directory the global install has to write into. */
  dir: string;
  /** Proven unwritable — see {@link probeGlobalInstallTarget} on why not "not writable". */
  blocked: boolean;
  /** `dir` is inside the immutable Nix store. */
  nixStore: boolean;
}

// The only errnos that PROVE the directory cannot be written: denied
// permissions, and a read-only filesystem (what NixOS and nix-darwin give for
// the store, root included). Anything else means the layout is not what we
// assumed — a reason to stay quiet, not to block.
const BLOCKING_ERRNOS = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Probe where a global install by `pm` would land and whether it can be written.
 * `installedPackageRoot` (the currently-installed package's own directory) is a
 * fallback for when the manager's own query is unavailable.
 *
 * Everything inconclusive returns null, and `blocked` is false unless a
 * permission error proved otherwise: a wrong "blocked" refuses an install that
 * works, which is worse than the failure being prevented.
 */
export function probeGlobalInstallTarget(
  pm: PackageManager,
  installedPackageRoot: string | null = null
): GlobalInstallTarget | null {
  // Windows `access(W_OK)` reflects only the read-only ATTRIBUTE, which carries
  // no ACL signal and is routinely set on directories the user can write to.
  // Never guess there.
  if (process.platform === "win32") return null;

  const queried = queryGlobalInstallDir(pm);
  // What the install writes into is the package's own PARENT: npm stages the
  // new copy beside the old one and renames, so a prefix whose `@swmansion`
  // came from an earlier `sudo npm install -g` fails with EACCES on the rename
  // while `node_modules` above it stays writable.
  const packagePath = queried ? path.join(queried, PACKAGE_NAME) : installedPackageRoot;
  if (packagePath === null) return null;
  const dir = nearestExistingDir(path.dirname(packagePath));
  if (dir === null) return null;

  const describe = (blocked: boolean): GlobalInstallTarget => ({
    dir,
    blocked,
    nixStore: isNixStorePath(dir),
  });
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== undefined && BLOCKING_ERRNOS.has(code) ? describe(true) : null;
  }
  return describe(false);
}

/** Writable prefix the remedies point npm at, and that init can set for the user. */
export function suggestedNpmPrefix(): string {
  return path.join(os.homedir(), ".npm-global");
}

/**
 * Drop the prefix npm exports into everything it spawns. `npx @swmansion/argent
 * init` inherits the OLD prefix that way, and an environment variable outranks
 * the `~/.npmrc` that `npm config set prefix` writes — so without this, the
 * install that follows a prefix move lands right back in the directory that
 * could not be written.
 */
export function forgetInheritedNpmPrefix(): void {
  delete process.env.npm_config_prefix;
  delete process.env.NPM_CONFIG_PREFIX;
}

/**
 * Why a global install or update cannot proceed — the cause and the directory,
 * with no advice. The interactive recovery offers the ways out as choices it
 * carries out itself, so it prints this instead of the full message.
 */
export function blockedGlobalTargetCause(
  target: GlobalInstallTarget,
  pm: PackageManager,
  verb: "install" | "update"
): string {
  const cause = target.nixStore
    ? "its global package directory is inside the read-only Nix store"
    : "its global package directory is not writable by this user";
  // Only the store's own note belongs here: this text also prefaces the prompt
  // that offers the ways out, before anything has been attempted.
  const note = target.nixStore
    ? `Nix owns that directory — a ${pc.cyan("sudo")} install into it is undone by the next rebuild or garbage-collect.`
    : null;

  return (
    `${pc.cyan(pm)} cannot ${verb} ${PACKAGE_NAME} globally: ${cause}.\n` +
    `  ${pc.dim(target.dir)}` +
    (note === null ? "" : `\n${note}`)
  );
}

/** The per-project install, as the command that gets there. */
export function localInstallRemedy(): string {
  return (
    `  Use ${PACKAGE_NAME} per project instead — no global directory needed:\n` +
    `    ${pc.cyan("argent init --local")}`
  );
}

// Written as $HOME rather than the expanded suggestedNpmPrefix() so it can be
// pasted into any shell — the two name the same directory.
function writablePrefixRemedy(pm: PackageManager): string {
  if (pm !== "npm")
    return `  Point ${pc.cyan(pm)} at a global directory you can write to, then retry.`;
  return (
    `  Point npm at a writable prefix, then retry:\n` +
    `    ${pc.cyan('npm config set prefix "$HOME/.npm-global"')}\n` +
    `    ${pc.cyan('export PATH="$HOME/.npm-global/bin:$PATH"')}  ${pc.dim("(add to your shell profile)")}`
  );
}

/** The cause plus the ways out, spelled as commands to run. */
export function unwritableGlobalTargetMessage(
  target: GlobalInstallTarget,
  pm: PackageManager,
  verb: "install" | "update"
): string {
  const remedies = [writablePrefixRemedy(pm), localInstallRemedy()];

  return `${blockedGlobalTargetCause(target, pm, verb)}\n\n${remedies.join("\n\n")}`;
}
