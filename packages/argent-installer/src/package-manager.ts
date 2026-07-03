import * as fs from "node:fs";
import * as path from "node:path";

// Package manager type, detection, and the install/uninstall command builders
// for both install topologies (global PATH binary vs project devDependency).

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export interface ShellCommand {
  bin: string;
  args: string[];
}

export function formatShellCommand(cmd: ShellCommand): string {
  const parts = [cmd.bin, ...cmd.args.map((a) => (a.includes(" ") ? `"${a}"` : a))];
  return parts.join(" ");
}

export function detectPackageManager(): PackageManager {
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("yarn")) return "yarn";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("bun")) return "bun";
  return "npm";
}

// corepack's `packageManager` field ("pnpm@9.1.0") is the project's own
// declaration — the strongest signal there is.
function pmFromPackageManagerField(dir: string): PackageManager | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    if (typeof pkg.packageManager !== "string") return null;
    const name = pkg.packageManager.split("@")[0];
    return name === "npm" || name === "yarn" || name === "pnpm" || name === "bun" ? name : null;
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

// Detect the package manager a *project* uses: the package.json `packageManager`
// (corepack) field first, then lockfiles, walking up ancestor directories —
// workspaces keep the single lockfile at the monorepo root, which may sit above
// the resolved project root. The walk stops at the repo boundary (.git). Only
// then fall back to the runner-based detectPackageManager(); that heuristic
// reads npm_config_user_agent, which reflects whoever launched `argent` (often
// npx / npm), not the host project — wrong for the local-install commands, which
// must match the project's own lockfile so the right one is updated.
export function detectProjectPackageManager(projectRoot: string): PackageManager {
  let dir = path.resolve(projectRoot);
  for (;;) {
    const pm = pmFromPackageManagerField(dir) ?? pmFromLockfile(dir);
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

// ── Local (repo-local / committable) install commands ─────────────────────────
// The committable install mode adds @swmansion/argent to the project's
// devDependencies instead of installing it globally, and commits MCP configs
// that run the project-local copy. These are the local-mode siblings of the
// global-* commands above; every command that mutates the project's package
// manifest MUST run with `cwd` set to the project root.

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
