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

function asKnownPm(name: unknown): PackageManager | null {
  return name === "npm" || name === "yarn" || name === "pnpm" || name === "bun" ? name : null;
}

// corepack's `packageManager` field ("pnpm@9.1.0") is the project's own
// declaration — the strongest signal there is. `devEngines.packageManager` is
// its modern equivalent and MUST be honored too: `pnpm init` (pnpm 10+) writes
// ONLY devEngines, and such a fresh project has no lockfile yet either — so
// without this, detection fell through to npm, whose own devEngines gate then
// instantly rejected the install (EBADDEVENGINES) as "Local install failed."
function pmFromPackageManagerField(dir: string): PackageManager | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      packageManager?: string;
      devEngines?: { packageManager?: { name?: string } | { name?: string }[] };
    };
    if (typeof pkg.packageManager === "string") {
      const name = asKnownPm(pkg.packageManager.split("@")[0]);
      if (name) return name;
    }
    const devEnginesPm = pkg.devEngines?.packageManager;
    for (const entry of Array.isArray(devEnginesPm) ? devEnginesPm : [devEnginesPm]) {
      const name = asKnownPm(entry?.name);
      if (name) return name;
    }
    return null;
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
  // pnpm-workspace.yaml is pnpm-exclusive (workspace layout AND, since pnpm
  // 10, plain settings), so it identifies pnpm even before the first install
  // creates a lockfile — but it is weaker than any REAL lockfile above: a
  // stray copy can survive a migration to yarn/bun, and the lockfile is what
  // actually records the project's dependency state.
  if (has("pnpm-workspace.yaml")) return "pnpm";
  return null;
}

// Detect the package manager the *project* uses: the `packageManager`
// (corepack) field first, then lockfiles, walking up ancestors (workspaces keep
// the single lockfile at the monorepo root) and stopping at the repo boundary
// (.git). Only then fall back to detectPackageManager(): npm_config_user_agent
// reflects whoever launched `argent` (often npx), not the host project, and the
// local-install commands must update the project's own lockfile.
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
// Local mode adds @swmansion/argent to the project's devDependencies and
// commits MCP configs that run the project-local copy. Every command that
// mutates the project's manifest MUST run with `cwd` set to the project root.

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

// Materialize the project's DECLARED dependencies without touching any pin —
// for when the manifest declares argent but node_modules is empty (a fresh
// clone), where the `add` form would rewrite the committed pin to @latest.
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
