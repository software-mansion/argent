import * as fs from "node:fs";
import * as path from "node:path";
import * as dns from "node:dns";
import { execSync } from "node:child_process";
import { PACKAGE_NAME, NPM_REGISTRY } from "./constants.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

// ── Package root resolution ───────────────────────────────────────────────────
// tsc compiles src/cli/utils.ts -> dist/cli/utils.js.
// The package root (containing skills/, rules/, agents/) is two levels up.
// This is deterministic — tsc preserves directory structure, and npm packages
// keep their internal layout regardless of hoisting or monorepo setup.

/**
 * Given the __dirname of a file inside dist/cli/, return the package root.
 * Exported so it can be tested against simulated directory structures.
 */
export function resolvePackageRoot(dirname: string): string {
  return path.resolve(dirname, "..", "..");
}

export const PACKAGE_ROOT = resolvePackageRoot(import.meta.dirname);
export const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
export const RULES_DIR = path.join(PACKAGE_ROOT, "rules");
export const AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");

// ── TOML helpers ─────────────────────────────────────────────────────────────

export function readToml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return parseToml(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeToml(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyToml(data) + "\n");
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

export function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ── Directory helpers ─────────────────────────────────────────────────────────

export function copyDir(src: string, dest: string): boolean {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── Version helpers ───────────────────────────────────────────────────────────

export function getInstalledVersion(): string | null {
  try {
    const pkgPath = path.join(PACKAGE_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function getLatestVersion(): string {
  const result = execSync(`npm view ${PACKAGE_NAME} version --registry ${NPM_REGISTRY}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.trim();
}

export function isSkillsCliAvailable(): boolean {
  try {
    execSync("npx --no-install skills --version", {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function isOnline(timeoutMs = 1500): Promise<boolean> {
  const host = new URL(NPM_REGISTRY).hostname;
  const lookup = new Promise<boolean>((resolve) => {
    dns.lookup(host, (err) => resolve(!err));
  });
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([lookup, timeout]);
}

// ── Package manager detection ─────────────────────────────────────────────────

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
