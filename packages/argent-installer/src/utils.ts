import * as fs from "node:fs";
import * as path from "node:path";
import * as dns from "node:dns";
import { createHash } from "node:crypto";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
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
  shellQuotePath,
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

// Skills earlier argent versions shipped under names no longer bundled.
// Init, update and uninstall remove them even when no lockfile tracks them.
export const LEGACY_ARGENT_SKILL_NAMES: readonly string[] = [
  "argent-create-flow",
  "argent-qa-flows",
  "argent-simulator-interact",
  "argent-simulator-setup",
  "argent-ios-profiler",
];

export interface RetiredBundledPath {
  /** Relative to the bundled agents/ or rules/ dir, "/"-separated. */
  path: string;
  /** sha256 of every version argent shipped, CRLF read as LF. */
  shipped: readonly string[];
  /** Text every shipped version contains: with it, a copy that matches no
   * hash is argent's, edited; without it, the file is the user's own. */
  marker: string;
}

// Files earlier argent versions copied into agents/ and rules/ targets. When a
// change deletes a file from packages/skills/agents or packages/skills/rules,
// add it here in the same change, with the hash of each version in its git
// history. Once the bundle no longer ships it, init, update and uninstall
// offer to remove it from every target argent manages.
export const RETIRED_BUNDLED_PATHS: Readonly<
  Record<"agents" | "rules", readonly RetiredBundledPath[]>
> = {
  agents: [
    {
      // v0.3.1 and v0.3.2, when the agent and package carried their first names.
      path: "environment-inspector.md",
      shipped: [
        "50f8d1442677a7def3117cc8652f26dd5c1e2271ae0c7c9814c5bb17dfdd7858",
        "10f998fef549503cf341e1775ff6aacafbf361c1d7ec32c554a9c42343a6998a",
      ],
      marker: "name: environment-inspector",
    },
    {
      path: "argent-environment-inspector.md",
      shipped: [
        "1f9b285ec30b7298b60b03cae10fb934ab07bc394104ab2d974d452a4c203178",
        "9d417798147fa11f4351109e6331865b79862fc631d7f32b70f64981362b90eb",
        "0f535893b239040ebe4a001ae7c3639366c4a6fe8d98e2568a59584798454644",
        "ec5872c9bd2085d281f5d4e1d06b5eb3f32a5be29c2bf8cb5c953ca6e9d73349",
        "96cb2e5025755448186cd9d29e85ce3db3cedb3dbfd2e6c89e734c76aa7fbdff",
        "9eff92cf887390fb3ffb68e7de5789e703049795a24d5f268332af488d155531",
      ],
      marker: "name: argent-environment-inspector",
    },
    {
      path: "references/quality-control-checklist.md",
      shipped: [
        "40f43028524e9544e2c77d2d1ad7eaf9385efadfb079bfec2973b999817203c1",
        "12a8deb0276a3d9fcd8b6c8fc6080b58be2e3e45fd0409dc2e7594e619e2eceb",
        "f1c76c1d51aa5a88371061a2bd5f46264ea2082aa4e1c2bca517d901b836c753",
        "84ecf5920fbca4460484a241a8ad1411fe8d6c3d0c9c25f80096a5a28f219f8a",
      ],
      marker: "## Quality control checklist",
    },
  ],
  rules: [],
};

// The hash RETIRED_BUNDLED_PATHS lists: a checkout with CRLF line endings
// still matches.
export function hashBundledContent(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

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

// The walk never climbs into the home directory: `~/.claude`, `~/.cursor`,
// `~/.codex`, … are the editors' global config dirs, not project markers, so
// matching them would resolve every markerless project under home to home.
export function resolveProjectRoot(startDir: string, homeDir: string = os.homedir()): string {
  const initialDir = path.resolve(startDir);
  const home = path.resolve(homeDir);
  let currentDir = initialDir;

  while (true) {
    if (currentDir === home && currentDir !== initialDir) {
      return initialDir;
    }

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

function rmEmptyDir(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath)) return false;
    if (!fs.statSync(dirPath).isDirectory()) return false;
    if (fs.readdirSync(dirPath).length > 0) return false;
    fs.rmdirSync(dirPath);
    return true;
  } catch {
    // non-fatal
    return false;
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
    Record<string, unknown> | undefined;
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
export function resolveLinkedDestination(dest: string): string {
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
  // A source with no files is nothing to copy either: a bundle that stopped
  // shipping a kind of content must not leave an empty dir at every target.
  if (!fs.existsSync(src) || !treeHasFiles(src)) return null;

  const target = resolveLinkedDestination(dest);
  copyTree(src, target);
  return target;
}

function treeHasFiles(dir: string): boolean {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .some((entry) => !entry.isDirectory() || treeHasFiles(path.join(dir, entry.name)));
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

export interface RetiredFile {
  /** Relative to the target dir, "/"-separated. */
  relativePath: string;
  /** Differs from every version argent shipped, so it may hold user changes. */
  edited: boolean;
  /** Hash when found: removal skips the file if it has changed since. */
  sha256: string;
}

function readRetiredFile(targetDir: string, relativePath: string): string | null {
  const entryPath = path.join(resolveLinkedDestination(targetDir), ...relativePath.split("/"));
  const file = resolveLinkedDestination(entryPath);
  try {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// The retired files in `targetDir` that the bundle in `bundleDir` no longer
// ships: copies of a version argent shipped, and copies of one edited since.
// A file at a retired path without the marker is the user's own, so it is not
// listed. Reads through links the way copyDir writes through them.
export function findRetiredFiles(
  retired: readonly RetiredBundledPath[],
  bundleDir: string,
  targetDir: string
): RetiredFile[] {
  const found: RetiredFile[] = [];
  for (const { path: relativePath, shipped, marker } of retired) {
    if (fs.existsSync(path.join(bundleDir, ...relativePath.split("/")))) continue;
    const content = readRetiredFile(targetDir, relativePath);
    if (content === null) continue;
    const sha256 = hashBundledContent(content);
    if (shipped.includes(sha256)) found.push({ relativePath, edited: false, sha256 });
    else if (content.includes(marker)) found.push({ relativePath, edited: true, sha256 });
  }
  return found;
}

// Removes `files` (from findRetiredFiles) from `targetDir`, then each directory
// that left empty. A file whose content changed since it was found stays.
// `targetDir` itself goes only when it is not a link: the canonical dir a link
// leads to is the user's.
export function removeRetiredFiles(
  targetDir: string,
  files: readonly RetiredFile[]
): { removedPaths: string[]; removedRoot: boolean } {
  const dir = resolveLinkedDestination(targetDir);
  const removedPaths: string[] = [];

  for (const { relativePath, sha256 } of files) {
    const content = readRetiredFile(targetDir, relativePath);
    if (content === null || hashBundledContent(content) !== sha256) continue;

    const segments = relativePath.split("/");
    const entryPath = path.join(dir, ...segments);
    const file = resolveLinkedDestination(entryPath);
    try {
      fs.rmSync(file);
      // A link to the removed copy would now dangle.
      if (file !== entryPath) fs.rmSync(entryPath, { force: true });
      removedPaths.push(relativePath);
    } catch {
      continue;
    }

    for (let depth = segments.length - 1; depth > 0; depth--) {
      if (!rmEmptyDir(path.join(dir, ...segments.slice(0, depth)))) break;
    }
  }

  const removedRoot = removedPaths.length > 0 && dir === targetDir && rmEmptyDir(dir);
  return { removedPaths, removedRoot };
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
  const args = ["view", PACKAGE_NAME, "version", "--registry", NPM_REGISTRY];
  const opts = { encoding: "utf8", timeout: PROBE_TIMEOUT_MS } as const;
  // npm is a .cmd shim on Windows, which only cmd.exe can run. A finished command
  // string (not shell: true + args) avoids Node 24's DEP0190 warning.
  const result =
    process.platform === "win32"
      ? execSync(["npm", ...args].join(" "), opts)
      : execFileSync("npm", args, opts);
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

// `npx --package <spec> -- argent ...` (and `npx -p <spec> argent ...`) runs
// argent with `npm_config_package=<spec>` in its environment. A nested `npx`
// inherits it and npm then installs <spec> in place of the requested package,
// so `npx skills add ...` re-runs argent instead of the skills CLI (#1335).
// The skills commands argent spawns get an environment without it.
export function npxChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "npm_config_package") {
      delete childEnv[key];
    }
  }
  return childEnv;
}

export function isSkillsCliAvailable(): boolean {
  try {
    execSync("npx --force --no-install skills --version", {
      env: npxChildEnv(),
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
