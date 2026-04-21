import * as fs from "node:fs";
import * as path from "node:path";
import * as dns from "node:dns";
import * as os from "node:os";
import { execSync } from "node:child_process";
import semver from "semver";
import { PACKAGE_NAME, NPM_REGISTRY } from "./constants.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Document, parseDocument } from "yaml";

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

function resolveBundledDir(dirName: "skills" | "rules" | "agents"): string {
  const packagedDir = path.join(PACKAGE_ROOT, dirName);
  if (fs.existsSync(packagedDir)) return packagedDir;

  // In the monorepo source tree, these assets live under packages/skills/.
  return path.resolve(PACKAGE_ROOT, "..", "skills", dirName);
}

export const SKILLS_DIR = resolveBundledDir("skills");
export const RULES_DIR = resolveBundledDir("rules");
export const AGENTS_DIR = resolveBundledDir("agents");

// Returns the names of the skills that ship with this argent install — each
// subdirectory of SKILLS_DIR that contains a SKILL.md. Used to detect which
// skills on the user's machine are argent-owned so we don't touch anything
// else during update.
export function listBundledSkills(skillsDir: string = SKILLS_DIR): string[] {
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(path.join(skillsDir, name, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

// Locations of the skills-CLI lock files. These paths mirror the skills CLI
// (v1.5.x) so we can detect which scopes already track argent skills and only
// re-sync those. Project lock lives next to the user's working tree, global
// lock under XDG_STATE_HOME or ~/.agents/.
export function getProjectSkillLockPath(cwd: string = process.cwd()): string {
  return path.join(cwd, "skills-lock.json");
}

export function getGlobalSkillLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) return path.join(xdgStateHome, "skills", ".skill-lock.json");
  return path.join(os.homedir(), ".agents", ".skill-lock.json");
}

// Prefix that identifies every skill argent ships. Used to locate argent-
// owned entries in the skills CLI lock files (including ones that were
// removed from the bundled set and need to be pruned).
export const ARGENT_SKILL_PREFIX = "argent-";

// Returns names in the lock that argent owns (i.e. start with the argent
// prefix). Argent reserves this namespace, so everything under it is
// considered ours and is kept in sync with the bundled SKILLS_DIR.
export function listArgentSkillsInLock(lockPath: string): string[] {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const lock = JSON.parse(raw) as { skills?: Record<string, unknown> };
    const tracked = lock.skills ?? {};
    return Object.keys(tracked)
      .filter((name) => name.startsWith(ARGENT_SKILL_PREFIX))
      .sort();
  } catch {
    return [];
  }
}

const PROJECT_ROOT_MARKERS = [
  ".mcp.json",
  ".claude",
  ".cursor",
  ".vscode",
  ".gemini",
  ".codex",
  ".agents",
  ".zed",
  "skills-lock.json",
];

export function resolveProjectRoot(startDir: string): string {
  const initialDir = path.resolve(startDir);
  let currentDir = initialDir;

  while (true) {
    if (PROJECT_ROOT_MARKERS.some((marker) => fs.existsSync(path.join(currentDir, marker)))) {
      return currentDir;
    }

    if (fs.existsSync(path.join(currentDir, ".git"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return initialDir;
    }
    currentDir = parentDir;
  }
}

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

// ── YAML helpers ────────────────────────────────────────────────────────────
// Uses the Document API so comments and formatting survive round-trips,
// which matters for hand-edited config files like ~/.hermes/config.yaml.

export function readYaml(filePath: string): Document {
  if (!fs.existsSync(filePath)) return new Document({});
  const text = fs.readFileSync(filePath, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const messages = doc.errors.map((e) => e.message).join("; ");
    throw new Error(`Failed to parse YAML at ${filePath}: ${messages}`);
  }
  return doc;
}

export function writeYaml(filePath: string, doc: Document): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // lineWidth: 0 disables hard-wrap so long user strings (e.g. multi-line
  // quoted personalities in ~/.hermes/config.yaml) stay on the lines they
  // were on. Default would re-wrap at column 80.
  fs.writeFileSync(filePath, doc.toString({ lineWidth: 0 }));
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

const PROBE_TIMEOUT_MS = 3_000;

export function getLatestVersion(): string {
  const result = execSync(`npm view ${PACKAGE_NAME} version --registry ${NPM_REGISTRY}`, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  });
  return result.trim();
}

// Returns true only when `candidate` is a strictly newer semver than
// `current`. Unparseable versions never report as newer, so a local
// prerelease build with a non-semver tag does not trigger a downgrade prompt.
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!semver.valid(candidate) || !semver.valid(current)) return false;
  return semver.gt(candidate, current);
}

export function isSkillsCliAvailable(): boolean {
  try {
    execSync("npx --no-install skills --version", {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function isOnline(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  let host: string;
  try {
    host = new URL(NPM_REGISTRY).hostname;
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    dns.lookup(host, (err) => {
      clearTimeout(timer);
      resolve(!err);
    });
  });
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
