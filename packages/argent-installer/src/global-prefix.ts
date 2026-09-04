import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import pc from "picocolors";
import { PACKAGE_NAME, MCP_BINARY_NAME } from "./constants.js";
import { formatShellCommand, type PackageManager } from "./package-manager.js";

// Where a package manager puts global installs, and whether this user can write
// there. Nix-managed toolchains are the motivating case: npm derives its global
// prefix from the node binary's own location, so under Nix it resolves inside
// the store — whose paths are mode 0555 and, on NixOS / nix-darwin, on a
// read-only mount. `npm install -g` there dies with EACCES for anyone but root,
// and what root writes Nix undoes, so init and update preflight it rather than
// run the install and hand the user npm's stack trace.

// Argument vector that makes each manager print a directory its global installs
// live under. Only npm's is reliably the module directory itself: yarn names its
// parent, bun the bin directory it links shims into, and pnpm a versioned root
// whose shape moved between 10 and 11. So the probe answers "can this user write
// in here", not "is the exact module directory writable" — one made root-owned
// by an earlier `sudo yarn global add`, `sudo pnpm add -g` or `sudo bun add -g`
// is missed. pnpm and bun also refuse to name a directory until one has been set
// up, leaving the probe null and the preflight inapplicable.
const GLOBAL_DIR_QUERY: Record<PackageManager, readonly string[]> = {
  npm: ["root", "-g"],
  pnpm: ["root", "-g"],
  // berry has no `global add` at all.
  yarn: ["global", "dir"],
  bun: ["pm", "bin", "-g"],
};

const QUERY_TIMEOUT_MS = 5_000;

/** What npm substitutes for a path segment it takes for a secret. */
const REDACTED_SEGMENT = "***";

/** Why sudo is no way out of a store path. */
function nixStoreNote(): string {
  return `Nix owns that directory — a ${pc.cyan("sudo")} install into it is undone by the next rebuild or garbage-collect.`;
}

function queryAbsolutePath(bin: string, args: readonly string[]): string | null {
  let stdout: string;
  try {
    stdout = execFileSync(bin, [...args], {
      encoding: "utf8",
      timeout: QUERY_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      // Node refuses to spawn the .cmd shim a Windows package manager installs
      // as unless it goes through a shell — the same reason shell.ts does this.
      shell: process.platform === "win32",
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
  if (line === undefined || !path.isAbsolute(line)) return null;
  // npm masks UUID-shaped segments in everything it prints, so a prefix under
  // /tmp/<uuid>/… comes back with *** where the segment was. Naming a directory
  // that does not exist is worse than having no answer: it reads as "npm holds
  // nothing here".
  return line.includes(REDACTED_SEGMENT) ? null : line;
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
    // The filesystem root is nobody's global package directory: reaching it
    // means every ancestor of the queried path is missing, which says nothing
    // about where an install would land. Checked before the stat so `/`, which
    // always exists and is unwritable, is never the answer.
    const parent = path.dirname(current);
    if (parent === current) return null;
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // Missing or unstattable — keep walking up.
    }
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
  const note = target.nixStore ? nixStoreNote() : null;

  return (
    `${pc.cyan(pm)} cannot ${verb} ${PACKAGE_NAME} globally: ${cause}.\n` +
    `  ${pc.dim(target.dir)}` +
    (note === null ? "" : `\n${note}`)
  );
}

/**
 * `dir`, or the nearest existing directory above it, when that one is proven
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

/**
 * Directory npm links global commands into, or null when npm cannot be asked.
 * Windows gets the prefix itself, which is where npm puts the shims there.
 */
export function npmGlobalBinDir(): string | null {
  const prefix = queryAbsolutePath("npm", ["prefix", "-g"]);
  if (prefix === null) return null;
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

/**
 * Path npm holds {@link PACKAGE_NAME} at inside its own global directory, or
 * null when npm cannot be asked. Whether something is there is npm's answer to
 * "is this installed globally" — PATH is not, because `which argent` reports
 * whichever copy comes first, and a project's node_modules/.bin, a pnpm shim or
 * a Nix profile wrapper is not one npm installed or can remove.
 */
export function npmGlobalPackagePath(): string | null {
  const root = queryAbsolutePath("npm", GLOBAL_DIR_QUERY.npm);
  return root === null ? null : path.join(root, PACKAGE_NAME);
}

/** What a printed remedy may assume about the machine it is printed on. */
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
function writablePrefixRemedy(pm: PackageManager, blocked: string): string | null {
  if (pm !== "npm")
    return `  Point ${pc.cyan(pm)} at a global directory you can write to, then retry.`;
  // Already pointed there: moving it again changes nothing, and printing it
  // first buries the remedy that does work. On a separator, as isNixStorePath
  // and ownershipRemedy are: ~/.npm-global-old is a different prefix.
  const suggested = suggestedNpmPrefix();
  if (blocked === suggested || blocked.startsWith(suggested + path.sep)) return null;
  return (
    `  Point npm at a writable prefix, then retry:\n` +
    `    ${pc.cyan('npm config set prefix "$HOME/.npm-global"')}\n` +
    `    ${pc.cyan('export PATH="$HOME/.npm-global/bin:$PATH"')}  ${pc.dim("(add to your shell profile)")}`
  );
}

/**
 * Taking ownership of `dir` — the way out where the blocked directory sits under
 * a prefix the user already chose and an earlier `sudo npm i -g` left it
 * root-owned, which the prefix remedy cannot help with. Null for a directory too
 * broad to hand to `chown -R`: a probe reports the nearest EXISTING ancestor of
 * the global package directory, which for a prefix never created is somewhere
 * far above it — /usr/local, or the home directory itself. Inside a node_modules
 * tree covers npm and pnpm; below the home directory covers yarn and bun.
 */
export function ownershipRemedy(dir: string): string | null {
  const home = os.homedir();
  const ownable =
    dir.split(path.sep).includes("node_modules") ||
    (dir !== home && dir.startsWith(home + path.sep));
  if (!ownable) return null;
  const chown = formatShellCommand({ bin: "sudo", args: ["chown", "-R", "$(whoami)", dir] });
  return `  Take ownership of the directory that is blocking it:\n    ${pc.cyan(chown)}`;
}

/**
 * The directory npm links its global commands into, when that one is proven
 * unwritable; null where nothing was proven. `npm install -g` writes there as
 * well as under the package directory {@link probeGlobalInstallTarget} walks,
 * and an earlier `sudo npm i -g` can have left either root-owned. npm is the
 * only manager whose bin directory argent knows how to name.
 */
export function blockedGlobalBinDir(pm: PackageManager): string | null {
  // Ahead of the query, as probeGlobalInstallTarget does: provenUnwritableDir
  // has nothing to say on Windows, so the subprocess would be spent for nothing.
  if (pm !== "npm" || process.platform === "win32") return null;
  const binDir = npmGlobalBinDir();
  return binDir === null ? null : provenUnwritableDir(binDir);
}

/**
 * The cause plus the ways out, for a bin directory that cannot be written.
 * `prefixJustMoved` drops the remedy that prescribes moving the prefix: on that
 * path it is the step that just ran.
 */
export function unwritableGlobalBinMessage(
  dir: string,
  verb: "install" | "update",
  ctx: RemedyContext,
  prefixJustMoved: boolean
): string {
  const remedies = [
    prefixJustMoved ? null : writablePrefixRemedy("npm", dir),
    isNixStorePath(dir) ? null : ownershipRemedy(dir),
    localInstallRemedy(ctx),
  ].filter((remedy): remedy is string => remedy !== null);
  const cause =
    `npm cannot ${verb} ${PACKAGE_NAME} globally: it cannot write to ${dir}, where it ` +
    `links the ${MCP_BINARY_NAME} command.` +
    // Same note blockedGlobalTargetCause carries for the package directory: the
    // chown remedy is missing above, and without this nothing says why.
    (isNixStorePath(dir) ? `\n${nixStoreNote()}` : "");
  return remedies.length === 0 ? cause : `${cause}\n\n${remedies.join("\n\n")}`;
}

/** The cause plus the ways out, spelled as commands to run. */
export function unwritableGlobalTargetMessage(
  target: GlobalInstallTarget,
  pm: PackageManager,
  verb: "install" | "update",
  ctx: RemedyContext
): string {
  const remedies = [
    writablePrefixRemedy(pm, target.dir),
    // Never for a store path: Nix undoes the chown at the next rebuild, which
    // is the whole reason the Nix cause exists.
    target.nixStore ? null : ownershipRemedy(target.dir),
    localInstallRemedy(ctx),
  ].filter((remedy): remedy is string => remedy !== null);

  const cause = blockedGlobalTargetCause(target, pm, verb);
  return remedies.length === 0 ? cause : `${cause}\n\n${remedies.join("\n\n")}`;
}

/**
 * Why a global install cannot proceed — the package directory npm writes under,
 * or the bin directory it links commands into — or null where nothing was
 * proven. `npm install -g` needs both, and they are separate permissions.
 */
export function blockedGlobalInstallMessage(
  pm: PackageManager,
  installedRoot: string | null,
  verb: "install" | "update",
  ctx: RemedyContext
): string | null {
  const target = probeGlobalInstallTarget(pm, installedRoot);
  if (target?.blocked) return unwritableGlobalTargetMessage(target, pm, verb, ctx);
  const binDir = blockedGlobalBinDir(pm);
  return binDir === null ? null : unwritableGlobalBinMessage(binDir, verb, ctx, false);
}
