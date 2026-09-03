import * as fs from "node:fs";
import * as path from "node:path";
import * as dns from "node:dns";
import * as os from "node:os";
import { execSync } from "node:child_process";
import semver from "semver";
import { PACKAGE_NAME, NPM_REGISTRY } from "./constants.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Document, parseDocument } from "yaml";
import {
  applyEdits as applyJsoncEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  type JSONPath,
} from "jsonc-parser";
import { resolvePackageRoot } from "./package-root.js";

// Re-exported so existing `./utils.js` import sites keep resolving after these
// helpers moved into focused modules.
export {
  formatShellCommand,
  detectPackageManager,
  detectProjectPackageManager,
  globalInstallCommand,
  globalUninstallCommand,
  localInstallCommand,
  localUninstallCommand,
  projectInstallCommand,
} from "./package-manager.js";
export type { PackageManager, ShellCommand } from "./package-manager.js";
export { hasProjectPackageJson, isYarnPnp } from "./preflight.js";
export {
  isGloballyInstalled,
  getGloballyInstalledVersion,
  getGloballyInstalledPackageRoot,
  isDeclaredLocally,
  isLocallyInstalled,
  getLocallyInstalledVersion,
  readLocalPackageVersionUncached,
  getLocalArgentBinRelPath,
  probeLocalInstall,
} from "./topology.js";
export {
  getInstallRecordPath,
  readInstallRecord,
  writeInstallRecord,
  removeInstallRecord,
  resolveInstallMode,
  resolveInstallModeFromFlags,
  InstallModeFlagError,
} from "./install-record.js";
export type { InstallMode } from "./install-record.js";
export { parseTargetFlags, decideInstallTargets, promptInstallTargets } from "./install-targets.js";

// resolvePackageRoot lives in the leaf package-root.ts module: topology.ts
// needs it too, and importing it from this barrel — which re-exports topology —
// was an ESM cycle.
export { resolvePackageRoot };

const PACKAGE_ROOT = resolvePackageRoot(import.meta.dirname);

function resolveBundledDir(dirName: "skills" | "rules" | "agents"): string {
  const packagedDir = path.join(PACKAGE_ROOT, dirName);
  if (fs.existsSync(packagedDir)) return packagedDir;

  // In the monorepo source tree, these assets live under packages/skills/.
  return path.resolve(PACKAGE_ROOT, "..", "skills", dirName);
}

export const SKILLS_DIR = resolveBundledDir("skills");
export const RULES_DIR = resolveBundledDir("rules");
export const AGENTS_DIR = resolveBundledDir("agents");

// GitHub source shorthand for the `skills` CLI. Pinning to the installed
// version's git tag keeps `skills-lock.json` portable across machines (issue
// #208): install paths stop being absolute and teammates resolve the same SHA.
export const ARGENT_SKILLS_REPO = "software-mansion/argent/packages/skills/skills";

// Source argument for `skills add`. Falls back to the bundled SKILLS_DIR when
// the version is unknown, since there is then no git tag to pin.
export function buildArgentSkillsSource(version: string | null | undefined): string {
  if (!version || version === "unknown") return SKILLS_DIR;
  return `${ARGENT_SKILLS_REPO}#v${version}`;
}

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

// Lock file locations owned by the skills CLI, not by argent — mirrored here so
// we can read them.
export function getProjectSkillLockPath(cwd: string = process.cwd()): string {
  return path.join(cwd, "skills-lock.json");
}

export function getGlobalSkillLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) return path.join(xdgStateHome, "skills", ".skill-lock.json");
  return path.join(os.homedir(), ".agents", ".skill-lock.json");
}

// Prefix on every skill argent ships. Argent reserves the namespace, so lock
// entries under it count as ours even once they leave the bundled set.
export const ARGENT_SKILL_PREFIX = "argent-";

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
  ".kiro",
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

// Uses the Document API so comments and formatting survive round-trips, which
// matters for hand-edited config files like ~/.hermes/config.yaml.
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
  // lineWidth: 0 disables hard-wrap, so long user strings stay on the lines
  // they were on; the default would re-wrap them at column 80.
  fs.writeFileSync(filePath, doc.toString({ lineWidth: 0 }));
}

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

// jsonc-parser's modify() needs a formatting hint for the keys it inserts.
const JSONC_FORMATTING = { tabSize: 2, insertSpaces: true } as const;

function setJsoncIn(text: string, jsonPath: JSONPath, value: unknown): string {
  const edits = modifyJsonc(text, jsonPath, value, { formattingOptions: JSONC_FORMATTING });
  return applyJsoncEdits(text, edits);
}

function readJsoncFileRaw(filePath: string): { text: string; hadBom: boolean; wasEmpty: boolean } {
  if (!fs.existsSync(filePath)) return { text: "{}", hadBom: false, wasEmpty: true };
  let text = fs.readFileSync(filePath, "utf8");
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  // A whitespace-only file has no formatting worth preserving, so it is
  // synthesized fresh, like a non-existent one.
  const wasEmpty = text.trim() === "";
  if (wasEmpty) text = "{}";
  return { text, hadBom, wasEmpty };
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
 * Read a JSON-with-Comments file, so a user-authored comment or trailing comma
 * in an editor config does not fail the parse. For mutations use
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
 * Apply a single path-targeted edit to a JSONC config file in place. Comments,
 * trailing commas, blank lines and key ordering outside the edited path are
 * preserved: jsonc-parser's modify() operates on the source text rather than a
 * parsed object.
 *
 * Pass `undefined` as `value` to delete the key. Emptied ancestor objects are
 * pruned, and a document that collapses to `{}` takes the file (and an empty
 * parent directory) with it.
 *
 * JSONC is a superset of JSON, so the strict-JSON MCP-config adapters (Claude's
 * `.mcp.json`, Windsurf, Gemini) write through here too, keeping every argent
 * entry on one comment- and foreign-server-preserving path. {@link writeJson}
 * remains for whole-document rewrites that must never delete the file (e.g.
 * `~/.claude.json`, which holds unrelated user state).
 */
export function editJsoncFile(filePath: string, jsonPath: JSONPath, value: unknown): void {
  const { text: initial, hadBom, wasEmpty } = readJsoncFileRaw(filePath);
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
  // A synthesized document (a fresh or previously empty file) gets a trailing
  // newline, matching writeJson/writeToml. A file with real content is edited in
  // place, so its own EOL and trailing byte stay untouched.
  const out = wasEmpty && !text.endsWith("\n") ? text + "\n" : text;
  fs.writeFileSync(filePath, (hadBom ? "﻿" : "") + out);
}

// Matches the kernel's own ELOOP ceiling.
const MAX_SYMLINK_HOPS = 40;

export function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// The path a copy destination names: itself, or — when it is a symlink — the
// end of the chain it points along. Each hop resolves against the directory the
// link really lives in, which is not the lexical dirname when a parent is itself
// a link into another subtree.
//
// A dangling link is completed only when its target's parent directory already
// exists: finishing `.claude/agents -> ../.agents/agents` for someone who has
// made `.agents` is helpful, conjuring a whole tree is not. Anything else
// resolves back to `dest`, so the caller fails naming the link the user wrote.
function resolveLinkedDestination(dest: string): string {
  let current = dest;

  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(current);
    } catch {
      // Nothing here: either `dest` itself is simply missing, or we walked a
      // chain to a target that was never created.
      return current === dest || dirExists(path.dirname(current)) ? current : dest;
    }

    if (!entry.isSymbolicLink()) return current;

    try {
      current = path.resolve(realpathOrSelf(path.dirname(current)), fs.readlinkSync(current));
    } catch {
      return dest;
    }
  }

  return dest;
}

// Copy a directory tree onto `dest`, writing *through* every symlink it lands
// on — file or directory, at any depth — rather than replacing it. Returns the
// directory actually written (which differs from `dest` when that was a link),
// or null when there is nothing to copy.
//
// Writing through matters because people keep one canonical copy of their agent
// definitions and point each vendor path at it — the whole directory
// (`.claude/agents -> ../.agents/agents`) or a single file inside it (issue
// #701).
//
// `fs.cp` cannot do this: its handling of a symlinked destination depends on
// the runtime. Node 20 refuses one at any level (ERR_FS_CP_DIR_TO_NON_DIR) and
// quietly replaces a symlinked file, leaving the canonical copy stale; Node 22
// writes through both, but aborts the process — an uncatchable C++
// std::filesystem exception — whenever it has to create a directory and cannot.
// Argent supports both, and `fs.copyFileSync` reports each failure as a plain,
// catchable errno.
export function copyDir(src: string, dest: string): string | null {
  if (!fs.existsSync(src)) return null;

  const target = resolveLinkedDestination(dest);
  copyTree(src, target);
  return target;
}

function copyTree(src: string, dest: string): void {
  // Read the source before creating anything: a destination that resolves back
  // inside the source would otherwise grow the tree being walked.
  const entries = fs.readdirSync(src, { withFileTypes: true });

  fs.mkdirSync(dest, { recursive: true });

  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = resolveLinkedDestination(path.join(dest, entry.name));
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

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

// Unparseable versions never report as newer, so a local build carrying a
// non-semver tag never shows up as an available update.
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!semver.valid(candidate) || !semver.valid(current)) return false;
  return semver.gt(candidate, current);
}

// Every `npx` call is `npm exec`, which evaluates the host project's
// package.json `engines` / `devEngines` gate first: a project pinning a runtime
// the user's machine doesn't match aborts with EBADDEVENGINES before the skills
// CLI ever runs (issue #298). `--force` downgrades that gate to a non-fatal
// warning; scoped to argent's own skills commands so nothing else is affected.
export function withNpmForce(npxArgs: string[]): string[] {
  return ["--force", ...npxArgs];
}

export function isSkillsCliAvailable(): boolean {
  try {
    execSync("npx --force --no-install skills --version", {
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
