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

// Detect the package manager a *project* uses by sniffing its lockfile, falling
// back to the runner-based detectPackageManager(). The runner heuristic reads
// npm_config_user_agent, which reflects whoever launched `argent` (often npx /
// npm), not the host project — wrong for the local-install commands, which must
// match the project's own lockfile so the right one is updated.
export function detectProjectPackageManager(projectRoot: string): PackageManager {
  const has = (file: string): boolean => fs.existsSync(path.join(projectRoot, file));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) return "npm";
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
