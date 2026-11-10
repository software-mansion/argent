import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalPath } from "@argent/configuration-core";
import { PACKAGE_NAME } from "./constants.js";
import { getRemainingGlobalBinaryPath, packageRootOf, readShimScript } from "./topology.js";

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export interface ShellCommand {
  bin: string;
  args: string[];
}

export function formatShellCommand(cmd: ShellCommand): string {
  const parts = [cmd.bin, ...cmd.args.map((a) => (a.includes(" ") ? `"${a}"` : a))];
  return parts.join(" ");
}

// `dir` as one POSIX shell word, for a command the reader pastes. Single
// quotes, because a discovered path can hold `$`, a backtick or `\`, which
// double quotes leave live - retargeting the line.
export function shellQuotePath(dir: string): string {
  return "'" + dir.split("'").join("'\\''") + "'";
}

export function detectPackageManager(): PackageManager {
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("yarn")) return "yarn";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("bun")) return "bun";
  return "npm";
}

// pnpm keeps globals under <pnpm home>/global/<5 | v11/<hash>>/node_modules.
const PNPM_GLOBAL_TARGET = new RegExp(
  String.raw`[\\/]global[\\/]v?\d+[\\/][^"'\s]*node_modules[\\/]` +
    PACKAGE_NAME.split("/").join(String.raw`[\\/]`) +
    String.raw`[\\/]`
);

// bun keeps globals under <BUN_INSTALL>/install/global/node_modules.
const BUN_GLOBAL_ROOT = new RegExp(
  String.raw`[\\/]install[\\/]global[\\/]node_modules[\\/]` +
    PACKAGE_NAME.split("/").join(String.raw`[\\/]`) +
    "$"
);

// The manager that owns the global argent on PATH, read from its layout: any
// other would add a second argent beside it. With no global the launcher's
// manager installs, but Yarn 2+ has no `yarn global` and gets npm (over a Yarn
// classic global it gets `yarn`, which fails there without installing anything).
// npm's layout puts <prefix>/bin/argent beside <prefix>/lib/node_modules/@swmansion/argent,
// or on Windows <prefix>\argent.cmd beside <prefix>\node_modules\@swmansion\argent.
// A global in bun's folder gets bun; on Windows its bin is an .exe beside a
// .bunx. A bin that resolves to no package is a shim script: pnpm's names its
// global folder, so pnpm owns it. A shim that names no node_modules path
// (nodenv's, asdf's) or is a binary (Volta's) runs a version manager's npm
// global, so it keeps npm. Any other names a package outside npm's layout
// (Yarn classic's) and gets `yarn`.
export function detectGlobalPackageManager(): PackageManager {
  const binaryPath = getRemainingGlobalBinaryPath();
  if (!binaryPath) return isYarnBerryLauncher() ? "npm" : detectPackageManager();
  const root = packageRootOf(binaryPath);
  if (root) {
    if (isInNpmLayout(binaryPath, root)) return "npm";
    return BUN_GLOBAL_ROOT.test(root) ? "bun" : "yarn";
  }
  if (process.platform === "win32") {
    if (fs.existsSync(path.join(npmCopyBeside(path.dirname(binaryPath)), "package.json"))) {
      return "npm";
    }
    if (fs.existsSync(binaryPath.replace(/\.exe$/i, "") + ".bunx")) return "bun";
  }
  const shim = readShimScript(binaryPath);
  if (shim === null || !/node_modules[\\/]/.test(shim)) return "npm";
  return PNPM_GLOBAL_TARGET.test(shim) ? "pnpm" : "yarn";
}

function npmCopyBeside(binDir: string): string {
  return process.platform === "win32"
    ? path.join(binDir, "node_modules", PACKAGE_NAME)
    : path.join(path.dirname(binDir), "lib", "node_modules", PACKAGE_NAME);
}

// The PATH entry can be a link to npm's bin, or sit in a linked directory, so
// each hop of the bin's link chain is checked from its real directory.
function isInNpmLayout(binaryPath: string, root: string): boolean {
  const realRoot = canonicalPath(root);
  let link = binaryPath;
  for (let hop = 0; hop < 40; hop++) {
    const binDir = canonicalPath(path.dirname(link));
    if (canonicalPath(npmCopyBeside(binDir)) === realRoot) return true;
    try {
      link = path.resolve(binDir, fs.readlinkSync(link));
    } catch {
      return false;
    }
  }
  return false;
}

function isYarnBerryLauncher(): boolean {
  const agent = process.env.npm_config_user_agent ?? "";
  return agent.startsWith("yarn") && !agent.startsWith("yarn/1.");
}

// Appended to a pasted `yarn global` command when the launcher is Yarn 2+, whose
// own `yarn` rejects it.
export function yarnClassicNote(cmd: ShellCommand): string {
  return cmd.bin === "yarn" && isYarnBerryLauncher()
    ? " (with Yarn classic, outside this Yarn 2+ project)"
    : "";
}

function asKnownPm(name: unknown): PackageManager | null {
  return name === "npm" || name === "yarn" || name === "pnpm" || name === "bun" ? name : null;
}

// corepack's `packageManager` field ("pnpm@9.1.0") is the project's own
// declaration — the strongest signal.
function pmFromPackageManagerField(dir: string): PackageManager | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    if (typeof pkg.packageManager === "string") {
      return asKnownPm(pkg.packageManager.split("@")[0]);
    }
    return null;
  } catch {
    return null;
  }
}

// Needed for a fresh `pnpm init`: pnpm 10+ writes ONLY devEngines, and falling
// through to npm made npm's own devEngines gate reject the install
// (EBADDEVENGINES). Still weaker than corepack's field or a lockfile: an array
// is an OR-set of ACCEPTABLE managers, not a preference order, so only a single
// distinct name identifies anything; and yarn and bun never update devEngines,
// so a declaration outlives a migration while the lockfile tracks reality.
function pmFromDevEngines(dir: string): PackageManager | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      devEngines?: { packageManager?: { name?: string } | { name?: string }[] };
    };
    const devEnginesPm = pkg.devEngines?.packageManager;
    const names = new Set<PackageManager>();
    for (const entry of Array.isArray(devEnginesPm) ? devEnginesPm : [devEnginesPm]) {
      const name = asKnownPm(entry?.name);
      if (name) names.add(name);
    }
    return names.size === 1 ? [...names][0]! : null;
  } catch {
    return null;
  }
}

function pmFromLockfile(dir: string): PackageManager | null {
  const has = (file: string): boolean => fs.existsSync(path.join(dir, file));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) return "npm";
  return null;
}

// pnpm-workspace.yaml is pnpm-exclusive (workspace layout and, since pnpm 10,
// plain settings), so it identifies pnpm before any lockfile exists — but it is
// the weakest signal: a stray copy survives a migration to yarn/bun, and it is
// not a declaration about the package manager at all.
function pmFromWorkspaceMarker(dir: string): PackageManager | null {
  return fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ? "pnpm" : null;
}

// Ranked project signals, walking up ancestors (workspaces keep the single
// lockfile at the monorepo root) and stopping at the repo boundary (.git).
// detectPackageManager() is the last resort: npm_config_user_agent reflects
// whoever launched `argent` (often npx), not the host project, whose own
// lockfile the local-install commands must update.
export function detectProjectPackageManager(projectRoot: string): PackageManager {
  let dir = path.resolve(projectRoot);
  for (;;) {
    const pm =
      pmFromPackageManagerField(dir) ??
      pmFromLockfile(dir) ??
      pmFromDevEngines(dir) ??
      pmFromWorkspaceMarker(dir);
    if (pm) return pm;
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return detectPackageManager();
}

export function globalInstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  switch (pm) {
    case "yarn":
      return { bin: "yarn", args: ["global", "add", pkg] };
    case "pnpm":
      return { bin: "pnpm", args: ["add", "-g", pkg] };
    case "bun":
      return { bin: "bun", args: ["add", "-g", pkg] };
    default:
      return { bin: "npm", args: ["install", "-g", pkg] };
  }
}

export function globalUninstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  switch (pm) {
    case "yarn":
      return { bin: "yarn", args: ["global", "remove", pkg] };
    case "pnpm":
      return { bin: "pnpm", args: ["remove", "-g", pkg] };
    case "bun":
      return { bin: "bun", args: ["remove", "-g", pkg] };
    default:
      return { bin: "npm", args: ["uninstall", "-g", pkg] };
  }
}

// Every command below mutates the project's manifest, so it MUST run with `cwd`
// set to the project root.

export function localInstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  switch (pm) {
    case "yarn":
      return { bin: "yarn", args: ["add", "--dev", pkg] };
    case "pnpm":
      return { bin: "pnpm", args: ["add", "-D", pkg] };
    case "bun":
      return { bin: "bun", args: ["add", "-d", pkg] };
    default:
      return { bin: "npm", args: ["install", "--save-dev", pkg] };
  }
}

// For a manifest that already declares argent but has no node_modules (fresh
// clone): honors the committed pin, which the `add` form would rewrite to
// @latest.
export function projectInstallCommand(pm: PackageManager): ShellCommand {
  switch (pm) {
    case "yarn":
      return { bin: "yarn", args: ["install"] };
    case "pnpm":
      return { bin: "pnpm", args: ["install"] };
    case "bun":
      return { bin: "bun", args: ["install"] };
    default:
      return { bin: "npm", args: ["install"] };
  }
}

export function localUninstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  switch (pm) {
    case "yarn":
      return { bin: "yarn", args: ["remove", pkg] };
    case "pnpm":
      return { bin: "pnpm", args: ["remove", pkg] };
    case "bun":
      return { bin: "bun", args: ["remove", pkg] };
    default:
      return { bin: "npm", args: ["uninstall", pkg] };
  }
}
