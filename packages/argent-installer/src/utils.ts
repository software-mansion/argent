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
  detectGlobalPackageManager,
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
}

// Files earlier argent versions copied into agents/ and rules/ targets. When a
// change deletes a file from packages/skills/agents or packages/skills/rules,
// add it here in the same change, with the hash of each version in its git
// history. Once the bundle no longer ships it, init, update and uninstall
// offer to remove it from every target argent manages. Only a copy that
// matches one of these hashes goes: any other file at that path may hold the
// user's work, so it stays.
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
    },
    {
      path: "references/quality-control-checklist.md",
      shipped: [
        "40f43028524e9544e2c77d2d1ad7eaf9385efadfb079bfec2973b999817203c1",
        "12a8deb0276a3d9fcd8b6c8fc6080b58be2e3e45fd0409dc2e7594e619e2eceb",
        "f1c76c1d51aa5a88371061a2bd5f46264ea2082aa4e1c2bca517d901b836c753",
        "84ecf5920fbca4460484a241a8ad1411fe8d6c3d0c9c25f80096a5a28f219f8a",
      ],
    },
  ],
  rules: [],
};

// rules/argent.md as argent copied it into global rule dirs (~/.claude/rules,
// ~/.cursor/rules, ~/.gemini/rules) before the rule became project-only. The
// bundle still ships argent.md for project scope, so these are retired in
// global scope alone, and only a copy matching one of these hashes goes: the
// current project rule is not listed, so a project at the home dir keeps it.
export const RETIRED_GLOBAL_RULES: readonly RetiredBundledPath[] = [
  {
    path: "argent.md",
    shipped: [
      "bfb07b5ad949f63ab9b41919f2c24c937b163c7644d6760fa8afda4f68c809f7",
      "90f6b24882ae077c8d5129652e7630c1b2a5651f5e800474d3b6e223222049f1",
      "cbf6cb5d898c14cd3460c85a15fd9ceeb7b3fed669df7e0932e61cad93a5a6fe",
      "ac8d19e2ece55ff6b7c554fd6a4a3eebc5a09af1eb95f6625f96781bb45505e2",
      "30bbef749f18d4fde7a5501941d58decf1e8abb2ca8c4e51f63e72bab3d863e2",
      "81663dc2f70aa2111388092e6027d27eddd89e9b5bdfb16043bdc96088d6850d",
      "5e3143dea13d15a9c80c7e24a1a3e4e1fb3ed34c8a077eccb74cb6e2a8a1c4a3",
      "51f8360f997c6bfcfb51c4c99d5f8b3a3b632ca4ca43a7f4ba5e7d8e8881798d",
      "5e27f0ed6dbdb4def30163387485b3c783c702bbc6594bc210d236454b6c5780",
      "06391305389e958b127a832de9977dc75a2164355a924bddb312b824656a8f72",
      "09ac21fd92efa4fc877e951475a0488a78ba4dbdfba63d6f1efd761c9f625866",
      "45fc6a4bf294af60e73ec9ab3c02219627767b5622467f7a57bb5b6976fd4126",
      "2f4eb998af8b5106b5fb49f19efd282d38366316c4a78f7123bc3d005c5848a4",
      "e425ebaafba2eeeb02f714d3e0b1ce19e0844fc4d661dbbd25bf6086ffc714b0",
      "d6cc846c1d3444bf8eaee6aa313a207e8c7a94391041df9d2a2908088c0191a7",
      "ad0f23a946e9bbc721a16b17a9516bf2570e7529094da0677f33ed63d43e0caa",
      "b1ce95af4c0e57cb478a148b6b8744ad4f8f15522441e566c0c6f7210c78fc79",
      "e3dc376ba736cef94de401bd5457c3df0192128164cbb44ac3e2ece57ad1af66",
      "aa43aeb338a5d0f50c425d8163dc697b9ffd7042539be05a67ed3ed85e8ba60f",
      "983f29ab70a565367bda4fbed705eb41fbe7b6767c70eb0569d2501f298e72c4",
      "251487afb2fda1707a27701be7fcc33b481e0176d43a4c946287a35595d26585",
      "933e657ec8789e57db8164fc2f58a692e9dc889bebd131eaa0f2017ef055add8",
      "35ea33df169b390d331733ab325dbf23b3804bc25927908e6050977563d7b10c",
      "7a89d0406784242b03ca187a2740898d4f69ccb7b76508ec373ad2aba5fb0a2c",
      "fa69c9e943572ab603b1318bc9a5c07f9d0e7c8f2cc208f6e29a6795991dab73",
      "192013fdee1954ba013985c022d91f37bbc34bf36ae4bcd76ab2cdf2f2b3f341",
      "4476fd58e33ede9cc938da7e954781fa8d5805f18cd71701cdaa4ec3bcabb085",
      "db80ca8efbe5dd775153ab39c63d4c387d1b5d864a1e7eae21fbd158f05d9e54",
      "32f3d3915f04fb43c4e835e076ec26ed7d88232f66963538308233c19055c951",
      "7aee698f1b8e5ed0399f45a72435961847b96097322e5f3391fd31adf03b8180",
      "1829b14538d913852bacb82a50d79cade45ea56c78fb2bc85e6e46f0f9ac6439",
      "c012bec1b6a225a0f03b7fc9133746d2130ce8f45cd1c2c86559bc31cafd81f7",
      "11f62b29badb21f0489e835975e5fa62b996188ed7194d01590b5eb6f020615b",
      "b83879ae5540a9e46140c5a1d0f93599e9aa48fbe752aba12db7a93cd8940834",
      "ec38c5e586782f376daec565302b3548fd22ea3236c384f9bb37b1d16bde3f39",
      "c40437e8afb99cc4cd6005ae3710d861b6f0af0da0f1de35499f4cb9ac790999",
      "4d62da692bc8735f3979f54e6c7e2c3b2e9d530e5898958aa41a869b5e9e6f11",
      "bec052b7cf7668da7f1cdddb5bae4c50b6db87ece0ec6930f1229e6e0bb8f96e",
      "0fffc00cc3d6fe32c93d857c8b4f8ad9754f7daf76c51cda6acc86aa5487e1e6",
      "1cb7d1f65d5014954a6d25bde4c9a271910ffed240899178b8dbf9e138ce83f3",
      "e3bc44c749ba6cecd50d1e4dc45c1dd3d896414982b339f07d62351c396e975d",
      "db0435ad74da7ba0e3ec362aab60c011ac24caa8aa9630dc77393058710c0deb",
      "aec395f5fdccc42c13ff39263ab101c5bebe68ed4181ee126a819c3a0a45aa94",
      "4867ae2b7f8bb207bad663759487b729be8bf58f9523d4589b885e5857966cc1",
      "5f9efed48536447a7ffc8d68b8a43eb20bceeb2adab884352f20cbbe5be37ac5",
      "51d5d412d5ff4edbc2dc837c33978d85678b5ff6461c987944469f535dbcc295",
      "d28de55c47c64bd9f7a7493825e1913f9fbf317976d6981f71ae24fb21631dea",
      "cb9a8c33b1dc6c1188674a1a846e97d1b3a58b2c386021b63139cfd33c1abe6c",
      "33bae8d5c6e38a730e15ceab19335145ed06988d475696690302daa1bf1221f3",
      "5f9b146efdac28c3d67a8b1fcdca3ab5950b69e7c74defa7dca5cbf4e44cc98a",
      "af428399983712d11e4cfc9999bd600ba5121f17acb1ce97f70e695ef68772b2",
    ],
  },
];

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

// Removes whatever `targetPath` names and returns whether anything was there. A
// link goes without what it leads to; a directory goes with its contents.
//
// A link is unlinked rather than handed to fs.rmSync: on Node 23.0 to 24.13.0
// and 25.0 to 25.3, rmSync looks through the link, so it throws ERR_FS_EISDIR
// for a link to a directory unless `recursive` is set, and returns without
// removing a dangling link (nodejs/node#61020).
export function removePath(targetPath: string): boolean {
  const entry = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!entry) return false;
  if (entry.isSymbolicLink()) fs.unlinkSync(targetPath);
  else fs.rmSync(targetPath, { recursive: entry.isDirectory(), force: true });
  return true;
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
// `fs.cp` cannot: depending on the Node version it refuses a symlinked
// destination (ERR_FS_CP_DIR_TO_NON_DIR), replaces a symlinked file (leaving the
// canonical copy stale), or aborts the process with an uncatchable C++
// exception when it cannot create a directory. `fs.copyFileSync` reports each
// failure as a catchable errno.
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
// ships, each a copy of a version argent shipped. A file at a retired path that
// matches none is not listed: it may be an edited copy or the user's own, and
// nothing tells the two apart. Reads through links the way copyDir writes
// through them. A null `bundleDir` ships nothing to this target.
export function findRetiredFiles(
  retired: readonly RetiredBundledPath[],
  bundleDir: string | null,
  targetDir: string
): RetiredFile[] {
  const found: RetiredFile[] = [];
  for (const { path: relativePath, shipped } of retired) {
    if (bundleDir !== null && fs.existsSync(path.join(bundleDir, ...relativePath.split("/"))))
      continue;
    const content = readRetiredFile(targetDir, relativePath);
    if (content === null) continue;
    const sha256 = hashBundledContent(content);
    if (shipped.includes(sha256)) found.push({ relativePath, sha256 });
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
      if (file !== entryPath) removePath(entryPath);
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
//
// The pinned source is this whole repository at a release tag, and the skills CLI
// (1.8.0+) runs `git submodule update --init --recursive` after cloning it. The
// one submodule is private and has an SSH URL, and no skill lives in it. Without
// github.com in known_hosts, ssh asks to trust the host on /dev/tty, behind the
// install spinner, and the install hangs: the CLI's clone timeout signals git,
// never ssh. Every release tag carries the submodule, so skip it through git's
// environment config, after any entries the caller already set.
const SKIPPED_SKILLS_SOURCE_SUBMODULES = ["packages/argent-private"] as const;

export function npxChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "npm_config_package") {
      delete childEnv[key];
    }
  }
  // A count git would reject breaks every git command anyway, so start over.
  const existing = Number(childEnv.GIT_CONFIG_COUNT ?? 0);
  let count = Number.isInteger(existing) && existing >= 0 ? existing : 0;
  for (const name of SKIPPED_SKILLS_SOURCE_SUBMODULES) {
    childEnv[`GIT_CONFIG_KEY_${count}`] = `submodule.${name}.update`;
    childEnv[`GIT_CONFIG_VALUE_${count}`] = "none";
    count += 1;
  }
  childEnv.GIT_CONFIG_COUNT = String(count);
  return childEnv;
}

// `cwd`: where the `skills` command will run - `npx --no-install` resolves a
// project-local bin from it.
export function isSkillsCliAvailable(cwd?: string): boolean {
  try {
    execSync("npx --force --no-install skills --version", {
      env: npxChildEnv(),
      stdio: ["ignore", "ignore", "ignore"],
      timeout: PROBE_TIMEOUT_MS,
      ...(cwd ? { cwd } : {}),
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
