import * as fs from "node:fs";
import * as path from "node:path";

// One place to learn about package managers: the type, how to detect which
// one a project uses, and how to build install/uninstall commands for
// both topologies (global on PATH, local devDependency under
// node_modules/@swmansion/argent).

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export interface ShellCommand {
  bin: string;
  args: string[];
}

export function formatShellCommand(cmd: ShellCommand): string {
  const parts = [cmd.bin, ...cmd.args.map((a) => (a.includes(" ") ? `"${a}"` : a))];
  return parts.join(" ");
}

// Ordered by specificity — pnpm/bun lockfiles are unique to their PM;
// yarn is unambiguous; package-lock.json / shrinkwrap fall through last.
const LOCKFILE_TO_PM: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

function detectFromLockfile(projectRoot: string): PackageManager | null {
  for (const [lockfile, pm] of LOCKFILE_TO_PM) {
    if (fs.existsSync(path.join(projectRoot, lockfile))) return pm;
  }
  return null;
}

function detectFromUserAgent(): PackageManager {
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("yarn")) return "yarn";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("bun")) return "bun";
  return "npm";
}

// Resolution: 1) projectRoot's lockfile (load-bearing for `--devdep` —
// `npx` sets npm_config_user_agent=npm/... even inside a yarn workspace,
// which would issue `npm install` and fail on yarn-only `link:` deps);
// 2) npm_config_user_agent; 3) npm.
export function detectPackageManager(projectRoot?: string): PackageManager {
  if (projectRoot) {
    const fromLockfile = detectFromLockfile(projectRoot);
    if (fromLockfile) return fromLockfile;
  }
  return detectFromUserAgent();
}

// ── Command builders ──────────────────────────────────────────────────────
// Each PM's flag for "install/remove a package globally / as devDep".
// All four PMs accept a registry name or a tarball/file path as the
// positional, so the same recipes handle the --from flag.

interface CommandRecipe {
  install: ShellCommand["args"]; // before the package name
  uninstall: ShellCommand["args"];
}

const GLOBAL_RECIPES: Record<PackageManager, CommandRecipe> = {
  npm: { install: ["install", "-g"], uninstall: ["uninstall", "-g"] },
  yarn: { install: ["global", "add"], uninstall: ["global", "remove"] },
  pnpm: { install: ["add", "-g"], uninstall: ["remove", "-g"] },
  bun: { install: ["add", "-g"], uninstall: ["remove", "-g"] },
};

const LOCAL_DEV_RECIPES: Record<PackageManager, CommandRecipe> = {
  npm: { install: ["install", "--save-dev"], uninstall: ["uninstall"] },
  yarn: { install: ["add", "--dev"], uninstall: ["remove"] },
  pnpm: { install: ["add", "-D"], uninstall: ["remove"] },
  bun: { install: ["add", "-d"], uninstall: ["remove"] },
};

function build(pm: PackageManager, args: string[], pkg: string): ShellCommand {
  return { bin: pm, args: [...args, pkg] };
}

export function globalInstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  return build(pm, GLOBAL_RECIPES[pm].install, pkg);
}

export function globalUninstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  return build(pm, GLOBAL_RECIPES[pm].uninstall, pkg);
}

export function localDevInstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  return build(pm, LOCAL_DEV_RECIPES[pm].install, pkg);
}

export function localDevUninstallCommand(pm: PackageManager, pkg: string): ShellCommand {
  return build(pm, LOCAL_DEV_RECIPES[pm].uninstall, pkg);
}
