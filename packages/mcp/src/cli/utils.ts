import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { PACKAGE_NAME, NPM_REGISTRY } from "./constants.js";

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

// ── JSON helpers ──────────────────────────────────────────────────────────────

export function readJson(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
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
  const result = execSync(
    `npm view ${PACKAGE_NAME} version --registry ${NPM_REGISTRY}`,
    { encoding: "utf8" },
  );
  return result.trim();
}

// ── Package manager detection ─────────────────────────────────────────────────

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export function detectPackageManager(): PackageManager {
  const agent = process.env.npm_config_user_agent ?? "";
  if (agent.startsWith("yarn")) return "yarn";
  if (agent.startsWith("pnpm")) return "pnpm";
  if (agent.startsWith("bun")) return "bun";
  return "npm";
}

export function globalInstallCommand(pm: PackageManager, pkg: string): string {
  switch (pm) {
    case "yarn":
      return `yarn global add ${pkg}`;
    case "pnpm":
      return `pnpm add -g ${pkg}`;
    case "bun":
      return `bun add -g ${pkg}`;
    default:
      return `npm install -g ${pkg}`;
  }
}

export function globalUninstallCommand(
  pm: PackageManager,
  pkg: string,
): string {
  switch (pm) {
    case "yarn":
      return `yarn global remove ${pkg}`;
    case "pnpm":
      return `pnpm remove -g ${pkg}`;
    case "bun":
      return `bun remove -g ${pkg}`;
    default:
      return `npm uninstall -g ${pkg}`;
  }
}
