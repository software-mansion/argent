import * as fs from "node:fs";
import * as path from "node:path";
import * as dns from "node:dns";
import * as os from "node:os";
import { execSync } from "node:child_process";
import semver from "semver";
import { PACKAGE_NAME, NPM_REGISTRY, MCP_BINARY_NAME } from "./constants.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Document, parseDocument } from "yaml";
import {
  applyEdits as applyJsoncEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  type JSONPath,
} from "jsonc-parser";

// ── Package root resolution ───────────────────────────────────────────────────
// At runtime this module ships in two shapes:
//   - tsc-compiled in the monorepo: packages/argent-installer/dist/utils.js
//   - bundled into the published package: <pkg>/dist/installer.mjs
// Walking up to the nearest package.json works for both layouts and any
// future repacking, instead of hard-coding a "two levels up" assumption.

/**
 * Given a starting dirname, walk up until the first directory containing a
 * package.json. Falls back to the starting directory if none found. Exported
 * so it can be tested against simulated directory structures.
 */
export function resolvePackageRoot(dirname: string): string {
  let current = path.resolve(dirname);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dirname);
    current = parent;
  }
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
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
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

// ── JSONC helpers ────────────────────────────────────────────────────────────
// Comment-preserving edits for editor settings files that are JSONC (Zed).
// Unlike the JSON.parse → mutate → JSON.stringify path used elsewhere, these
// helpers operate on the source string via jsonc-parser's modify(), so user
// comments, trailing commas, blank lines, and key ordering all survive.

// jsonc-parser's modify() needs a formatting hint for newly-inserted keys.
// Zed's bundled defaults use 2-space indentation; matching that keeps writes
// visually consistent for the common case.
const JSONC_FORMATTING = { tabSize: 2, insertSpaces: true } as const;

function setJsoncIn(text: string, jsonPath: JSONPath, value: unknown): string {
  const edits = modifyJsonc(text, jsonPath, value, { formattingOptions: JSONC_FORMATTING });
  return applyJsoncEdits(text, edits);
}

function readJsoncFileRaw(filePath: string): { text: string; hadBom: boolean } {
  if (!fs.existsSync(filePath)) return { text: "{}", hadBom: false };
  let text = fs.readFileSync(filePath, "utf8");
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  if (text.trim() === "") text = "{}";
  return { text, hadBom };
}

function getAtJsoncPath(value: unknown, jsonPath: JSONPath): unknown {
  let cur: unknown = value;
  for (const key of jsonPath) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key as string | number];
  }
  return cur;
}

function isEmptyPlainObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0
  );
}

function rmEmptyDir(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) return;
    if (!fs.statSync(dirPath).isDirectory()) return;
    if (fs.readdirSync(dirPath).length > 0) return;
    fs.rmdirSync(dirPath);
  } catch {
    // non-fatal
  }
}

/**
 * Read a JSON-with-Comments file (line + block comments + trailing commas).
 * Used by callers that need to inspect Zed's settings.json without the
 * `JSON.parse` failure on user-authored comments. For mutations go through
 * {@link editJsoncFile} instead — it preserves comments on write.
 */
export function readJsonc(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let raw = fs.readFileSync(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (raw.trim() === "") return {};
  const parsed = parseJsonc(raw, [], { allowTrailingComma: true }) as
    | Record<string, unknown>
    | undefined;
  return parsed ?? {};
}

/**
 * Apply a single path-targeted edit to a JSONC config file in place.
 * Comments, trailing commas, blank lines, and key ordering outside the
 * edited path are preserved (jsonc-parser's modify() operates on the source
 * text rather than a parsed object).
 *
 * Pass `undefined` as `value` to delete the key. Empty ancestor objects are
 * pruned, and if the document collapses to `{}` the file (and an empty
 * parent directory) is removed — mirroring the JSON `writeJsonOrRemove`
 * semantics used elsewhere.
 *
 * Use this for editor settings files that are JSONC (Zed). For pure JSON
 * configs go through {@link writeJson} instead — JSONC.modify is overhead
 * when there are no comments to preserve.
 */
export function editJsoncFile(filePath: string, jsonPath: JSONPath, value: unknown): void {
  const { text: initial, hadBom } = readJsoncFileRaw(filePath);
  let text = setJsoncIn(initial, jsonPath, value);

  if (value === undefined) {
    for (let i = jsonPath.length - 1; i > 0; i--) {
      const parentPath = jsonPath.slice(0, i);
      const parsed = parseJsonc(text, [], { allowTrailingComma: true });
      if (!isEmptyPlainObject(getAtJsoncPath(parsed, parentPath))) break;
      text = setJsoncIn(text, parentPath, undefined);
    }
  }

  const parsed = parseJsonc(text, [], { allowTrailingComma: true });
  if (isEmptyPlainObject(parsed)) {
    fs.rmSync(filePath, { force: true });
    rmEmptyDir(path.dirname(filePath));
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, (hadBom ? "﻿" : "") + text);
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

/**
 * Read the version of the globally-installed argent package — distinct from
 * {@link getInstalledVersion}, which reads the package.json this code is
 * currently executing from. When invoked via `npx @swmansion/argent`, the
 * npx cache is always at the latest published version, so reading
 * PACKAGE_ROOT/package.json masks an outdated global install and lets the
 * update check report "already on the latest" incorrectly. This helper
 * resolves the global binary via `which -a` / `where`, follows symlinks to
 * the actual entrypoint, and walks up to the owning package.json instead.
 *
 * Returns null when argent is not permanently installed on PATH, or when
 * the global package layout cannot be resolved (e.g., Windows wrapper
 * scripts that aren't symlinks). Callers should treat null as "could not
 * determine" — preferable to silently using the running package's version,
 * which is the bug this guards against.
 */
export function getGloballyInstalledVersion(): string | null {
  const binaryPath = getGlobalBinaryPath();
  if (!binaryPath) return null;
  try {
    const realPath = fs.realpathSync(binaryPath);
    const pkgRoot = resolvePackageRoot(path.dirname(realPath));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
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

// Path segments used by temp package runners (npx, pnpm dlx, bunx, yarn dlx).
// When invoked via one of these, the runner prepends its cache .bin/ dir to PATH,
// so `which argent` succeeds even though argent is not permanently installed globally.
const TEMP_RUNNER_MARKERS = [
  "_npx",
  "/dlx-",
  "\\dlx-",
  "bun/install/cache",
  ".bun\\install\\cache",
];

export function isTempRunnerPath(binaryPath: string): boolean {
  return TEMP_RUNNER_MARKERS.some((marker) => binaryPath.includes(marker));
}

/**
 * Resolve the path of the globally-installed argent binary, ignoring
 * temp-runner caches (npx / pnpm dlx / bunx / yarn dlx). On Windows `where`
 * returns every match, on Unix `which -a` does — we inspect each line so a
 * concurrent npx invocation does not mask a real global install. Returns
 * null when argent is not permanently installed on PATH.
 */
function getGlobalBinaryPath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which -a";
    const output = execSync(`${cmd} ${MCP_BINARY_NAME}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .find((line) => !isTempRunnerPath(line)) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * True iff argent is permanently installed on the user's PATH (not just being
 * executed transiently from an npx / dlx / bunx cache).
 */
export function isGloballyInstalled(): boolean {
  return getGlobalBinaryPath() !== null;
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
