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
// live under. Only npm's names the node_modules itself: yarn classic prints its
// parent, bun the bin directory it links shims into, and pnpm 10 answers
// `<PNPM_HOME>/global/5/node_modules` before its first global install and
// `<PNPM_HOME>/global/v11` after, with the package a level deeper still. Near
// enough to answer "can this user write there", which is all the probe asks —
// at the cost that walking up from <queried>/@swmansion/argent probes an
// ancestor of the real module directory, so one made root-owned by an earlier
// `sudo yarn global add`, `sudo pnpm add -g` or `sudo bun add -g` is missed.
//
// Two of the four also refuse to answer before a global directory has been set
// up: `pnpm root -g` exits 1 until its bin directory is on PATH, and `bun pm
// bin -g` exits 1 on a global directory with no package.json — after creating
// it. Both leave the probe with null and the preflight inapplicable. npm and
// yarn name their directory whether or not it exists yet, which is what
// nearestExistingDir walks up from.
const GLOBAL_DIR_QUERY: Record<PackageManager, readonly string[]> = {
  npm: ["root", "-g"],
  pnpm: ["root", "-g"],
  // berry has no `global add` at all.
  yarn: ["global", "dir"],
  bun: ["pm", "bin", "-g"],
};

const QUERY_TIMEOUT_MS = 5_000;

function queryAbsolutePath(bin: string, args: readonly string[]): string | null {
  let stdout: string;
  try {
    stdout = execFileSync(bin, [...args], {
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

function queryGlobalInstallDir(pm: PackageManager): string | null {
  return queryAbsolutePath(pm, GLOBAL_DIR_QUERY[pm]);
}

/**
 * The file `npm config set` writes to. That is `~/.npmrc` only while
 * `npm_config_userconfig` points nowhere else. Falls back to the default name
 * when npm cannot be asked, so the hint is never blank.
 */
export function npmUserConfigPath(): string {
  return (
    queryAbsolutePath("npm", ["config", "get", "userconfig"]) ?? path.join(os.homedir(), ".npmrc")
  );
}

/**
 * True when `target` is inside the Nix store. Honors NIX_STORE_DIR, which only
 * a relocated Nix (a custom build or an admin-exported override) sets to
 * something other than the /nix/store default — nix-portable virtualizes
 * /nix/store but keeps those paths, and nix's own --store is a per-invocation
 * flag that exports nothing.
 *
 * Symlinks are resolved, because the writability probe follows them too: a
 * home-manager `~/.npm-global` pointing into the store is just as immutable,
 * and comparing the literal path would report it as merely unwritable and drop
 * the note that rules out sudo.
 */
export function isNixStorePath(target: string): boolean {
  const storeDir = realPath(process.env.NIX_STORE_DIR || "/nix/store");
  const resolved = realPath(target);
  return resolved === storeDir || resolved.startsWith(storeDir + path.sep);
}

// realpath, or the lexically resolved path when there is nothing on disk to
// resolve — a store path that does not exist is still a store path by name.
function realPath(target: string): string {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
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
 * Drop the inherited prefix npm reads from the environment. `npx
 * @swmansion/argent init` inherits the old one through `npm_config_prefix` (npm
 * exports it into everything it spawns), and a shell may export
 * `NPM_CONFIG_PREFIX`; either outranks the config file `npm config set prefix`
 * writes, so one left set sends the install that follows a prefix move right
 * back to the directory that could not be written.
 *
 * Plain `PREFIX` is deliberately left alone: measured on npm 11, it is only the
 * default for an npmrc that has no `prefix` key, so once the move has written
 * that key npm ignores it — and it is a general-purpose variable the install and
 * every step after it inherit.
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

/** What a printed remedy may assume about the machine it is printed on. */
/**
 * The existing directory `dir` would be created under, when it is proven
 * unwritable on the same evidence {@link probeGlobalInstallTarget} uses; null
 * where nothing was proven. `npm install -g` links its shims into
 * `<prefix>/bin`, which is nowhere under the package directory that probe walks.
 */
export function provenUnwritableDir(dir: string): string | null {
  if (process.platform === "win32") return null;
  const existing = nearestExistingDir(dir);
  if (existing === null) return null;
  try {
    fs.accessSync(existing, fs.constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== undefined && BLOCKING_ERRNOS.has(code) ? existing : null;
  }
  return null;
}

/** Directory npm links global commands into, or null when npm cannot be asked. */
export function npmGlobalBinDir(): string | null {
  const prefix = queryAbsolutePath("npm", ["prefix", "-g"]);
  return prefix === null ? null : path.join(prefix, "bin");
}

export interface RemedyContext {
  /** There is a package.json to hold the devDependency a local install adds. */
  localViable: boolean;
  /** A bare `argent` resolves on PATH, so a remedy can name it directly. */
  argentOnPath: boolean;
}

/**
 * Whether a blocked global install leaves argent anything to carry out: moving
 * npm's prefix (the only manager whose knob argent knows — the equivalent
 * differs for every other one, and yarn berry has no global install at all), or
 * installing into the project, which needs a package.json to hold the
 * devDependency. With neither, there is nothing to ask about.
 */
export function canRecoverBlockedGlobal(pm: PackageManager, localViable: boolean): boolean {
  return pm === "npm" || localViable;
}

/**
 * The per-project install, as a command the reader can actually run — or null
 * where it is not a way out at all. It needs a package.json to add the
 * devDependency to, and on the fresh-install path there is no `argent` on PATH
 * yet: that run was started by `npx @swmansion/argent init`.
 */
export function localInstallRemedy(ctx: RemedyContext): string | null {
  if (!ctx.localViable) return null;
  const command = ctx.argentOnPath ? "argent init --local" : `npx ${PACKAGE_NAME} init --local`;
  return (
    `  Use ${PACKAGE_NAME} per project instead — no global directory needed:\n` +
    `    ${pc.cyan(command)}`
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

// Only for a directory outside the store: `sudo chown` on a store path is
// undone by the next rebuild, which is the whole reason the Nix cause exists.
// The prefix remedy is a no-op where the blocked directory sits under a prefix
// the user already chose and an earlier `sudo npm i -g` left root-owned, and
// this is the way out for exactly that case.
function ownershipRemedy(target: GlobalInstallTarget): string | null {
  if (target.nixStore) return null;
  return (
    `  Or take ownership of the directory that is blocking it:\n` +
    `    ${pc.cyan(`sudo chown -R "$(whoami)" ${target.dir}`)}`
  );
}

/** The cause plus the ways out, spelled as commands to run. */
export function unwritableGlobalTargetMessage(
  target: GlobalInstallTarget,
  pm: PackageManager,
  verb: "install" | "update",
  ctx: RemedyContext
): string {
  const remedies = [
    writablePrefixRemedy(pm),
    ownershipRemedy(target),
    localInstallRemedy(ctx),
  ].filter((remedy): remedy is string => remedy !== null);

  return `${blockedGlobalTargetCause(target, pm, verb)}\n\n${remedies.join("\n\n")}`;
}
