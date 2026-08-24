import * as fs from "node:fs";
import * as path from "node:path";

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
