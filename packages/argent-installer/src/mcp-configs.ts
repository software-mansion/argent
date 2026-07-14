import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  MCP_SERVER_KEY,
  MCP_BINARY_NAME,
  PACKAGE_NAME,
  PERMISSION_RULE,
  CURSOR_ALLOWLIST_PATTERN,
} from "./constants.js";
import {
  readJson,
  writeJson,
  readJsonc,
  dirExists,
  readToml,
  writeToml,
  readYaml,
  writeYaml,
  editJsoncFile,
  isYarnPnp,
  getLocalArgentBinRelPath,
  RULES_DIR,
  AGENTS_DIR,
  ARGENT_SKILL_PREFIX,
} from "./utils.js";
import { isMap } from "yaml";
import { parse as parseJsoncText, type ParseError } from "jsonc-parser";
import { parse as parseTomlText } from "smol-toml";
import escapeStringRegexp from "escape-string-regexp";

const TOOL_SERVER_BUNDLE = path.join(import.meta.dirname, "tool-server.cjs");

function getAvailableToolIds(): string[] {
  const out = execFileSync("node", [TOOL_SERVER_BUNDLE, "-t"], { encoding: "utf8" });
  const tools = JSON.parse(out) as Array<{ id: string }>;
  return tools.map((t) => t.id);
}

// ── Types ─────────────────────────────────────────────────────────────────────
// MARK: Types

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// A same-named argent config in a hidden scope the client resolves ahead of
// the entry init just wrote (e.g. Claude Code's per-project section of
// ~/.claude.json), or client state that blocks it from loading
// (disabledMcpjsonServers). Adapters only report; init-stale-config.ts
// decides removal vs. warning.
export interface ShadowingConfigFinding {
  /** Human-readable location, e.g. `~/.claude.json (project-local scope)`. */
  location: string;
  /** One-line consequence for the user, e.g. `takes precedence over .mcp.json`. */
  reason: string;
  /** The conflicting entry when parseable; null for non-entry state (a block list). */
  entry: McpServerEntry | null;
  /**
   * True when removal needs no further policy checks (state keyed to this
   * project root, or removal only re-enables prompting). When false,
   * init-stale-config.ts removes the finding only if provably dead and warns
   * otherwise.
   */
  autoRemove: boolean;
  /** Remove the conflicting state. Returns true if something was removed. */
  remove(): boolean;
}

export interface McpConfigAdapter {
  name: string;
  detect(): boolean;
  projectPath(root: string): string | null;
  globalPath(): string | null;
  write(configPath: string, entry: McpServerEntry): void;
  remove(configPath: string): boolean;
  // Non-mutating predicate used by `update` to skip adapters/scopes the user
  // never opted into during `init`. Without this, `update` would re-create
  // configs for any editor whose dir happens to exist on the user's machine
  // (issue #195). Implementations must read the same key `remove()` checks.
  hasArgentEntry(configPath: string): boolean;
  // The argent entry in normalized command/args form, or null when absent. A
  // present-but-unrecognizable entry comes back as { command: "", args: [] }
  // so callers can tell "absent" from "unreadable" (hasArgentEntry must stay
  // true for it).
  getArgentEntry(configPath: string): McpServerEntry | null;
  // Report argent state in config locations OUTSIDE the projectPath/globalPath
  // pair that the client resolves ahead of (or gates) the entry written at
  // `writtenScope`. Only clients with hidden scopes implement this.
  findShadowingConfigs?(root: string, writtenScope: "local" | "global"): ShadowingConfigFinding[];
  addAllowlist?(root: string, scope: "local" | "global"): void;
  removeAllowlist?(root: string, scope: "local" | "global"): void;
}

type CodexConfig = {
  mcp_servers?: {
    argent?: {
      tools?: Record<
        string,
        {
          approval_mode: string;
        }
      >;
    };
  };
};

// ── Shared helpers ────────────────────────────────────────────────────────────

// How the committed MCP entry locates the argent executable.
//   global     → bare PATH `argent` (the default).
//   local-node → `node <project-relative bin path>` (normal node_modules layout).
//   local-pnp  → `yarn argent` (Yarn Plug'n'Play; no node_modules).
//   local-npx  → `npx --no-install argent` (bin path unverifiable; never bare
//                `npx`/`-y`, which can hang a TTY-less stdio server or
//                silently network-install).
export type McpCommandMode =
  | { kind: "global" }
  | { kind: "local-node"; binRelPath: string }
  | { kind: "local-pnp" }
  | { kind: "local-npx" };

function buildMcpEntry(mode: McpCommandMode = { kind: "global" }): McpServerEntry {
  // No env vars by default: the MCP server falls back to
  // `${homedir()}/.argent/mcp-calls.log` when ARGENT_MCP_LOG is unset, so we
  // keep this generated config portable — see issue #238.
  switch (mode.kind) {
    case "local-node":
      // `node` (not the .bin/argent .cmd/.ps1 shim) is Windows-safe. The
      // relative path resolves against the client's cwd — the project root
      // for a committed project-scope config.
      return { command: "node", args: [mode.binRelPath, "mcp"] };
    case "local-pnp":
      return { command: "yarn", args: ["argent", "mcp"] };
    case "local-npx":
      return { command: "npx", args: ["--no-install", "argent", "mcp"] };
    default:
      return { command: MCP_BINARY_NAME, args: ["mcp"] };
  }
}

export function getMcpEntry(mode: McpCommandMode = { kind: "global" }): McpServerEntry {
  return buildMcpEntry(mode);
}

// Resolve the MCP command shape for a committable (local) install rooted at
// `root`.
export function resolveLocalCommandMode(root: string): McpCommandMode {
  if (isYarnPnp(root)) return { kind: "local-pnp" };
  const binRelPath = getLocalArgentBinRelPath(root);
  if (binRelPath) return { kind: "local-node", binRelPath };
  return { kind: "local-npx" };
}

// Single owner of the mode-and-scope → MCP command decision, shared by `init`
// and `update`: only a local-mode PROJECT-scope entry runs the repo-local
// copy; everything else keeps the bare `argent` command.
export function getMcpEntryForScope(
  installMode: "global" | "local",
  configScope: "local" | "global",
  localCmdMode: McpCommandMode | null
): McpServerEntry {
  return installMode === "local" && configScope === "local" && localCmdMode
    ? getMcpEntry(localCmdMode)
    : getMcpEntry({ kind: "global" });
}

function hasEnv(entry: McpServerEntry): entry is McpServerEntry & { env: Record<string, string> } {
  return entry.env != null && Object.keys(entry.env).length > 0;
}

// Env keys argent itself wrote historically: entries from argent <= 0.9.x
// carry ARGENT_MCP_LOG (dropped in 0.10.0 by #238). An entry whose env holds
// nothing else is still argent-authored — classification must not read it as
// a user customization, or those legacy entries would never be repaired to
// the clean env-less shape (the refresh was the #238 rollout vehicle).
const LEGACY_ARGENT_ENV_KEYS = new Set(["ARGENT_MCP_LOG"]);

export function hasCustomizingEnv(entry: McpServerEntry): boolean {
  return Object.keys(entry.env ?? {}).some((key) => !LEGACY_ARGENT_ENV_KEYS.has(key));
}

function removeDirIfEmpty(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) return;
    if (!fs.statSync(dirPath).isDirectory()) return;
    if (fs.readdirSync(dirPath).length > 0) return;
    fs.rmdirSync(dirPath);
  } catch {
    // non-fatal
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// After the Codex remover deletes the argent entry, collapse the now-empty
// `mcp_servers` table it lived in so a config that held only argent reduces to {}
// and writeTomlOrRemove can delete the file. Only this one key is touched —
// foreign sibling keys and empty values elsewhere in the tree are preserved
// byte-for-byte (the contract is "only touch argent"). The JSON adapters get the
// same ancestor collapse for free from editJsoncFile. The sole caller passes a
// TOML table (`mcp_servers`), so only the empty-object case can fire.
function deleteIfEmpty(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (isRecord(value) && Object.keys(value).length === 0) {
    delete parent[key];
  }
}

// Normalize a raw config-file server entry into McpServerEntry shape.
// Absent → null; present but unrecognizable → the { command: "" } sentinel
// (see McpConfigAdapter.getArgentEntry). Env vars ride along (opencode spells
// the key `environment`): they mark a hand-tuned entry and can make a command
// resolvable in the client when this shell's probe misses it (nvm PATH), so
// classification must see them.
function normalizeServerEntry(raw: unknown): McpServerEntry | null {
  if (raw === undefined || raw === null) return null;
  if (isRecord(raw)) {
    const rawEnv = isRecord(raw.env) ? raw.env : isRecord(raw.environment) ? raw.environment : null;
    const env =
      rawEnv && Object.keys(rawEnv).length > 0
        ? Object.fromEntries(Object.entries(rawEnv).map(([key, value]) => [key, String(value)]))
        : undefined;
    // opencode stores the command as a single array: { command: [cmd, ...args] }.
    if (Array.isArray(raw.command) && raw.command.every((c) => typeof c === "string")) {
      const [command = "", ...args] = raw.command as string[];
      return { command, args, ...(env ? { env } : {}) };
    }
    if (typeof raw.command === "string") {
      const args = Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === "string")
        : [];
      return { command: raw.command, args, ...(env ? { env } : {}) };
    }
  }
  return { command: "", args: [] };
}

// True when `entry` is a shape argent itself writes — one of the four
// buildMcpEntry command modes, exact args, no env. Anything else is a
// deliberate or unknown customization that refresh/cleanup flows must not
// rewrite or remove. The node form accepts any RELATIVE path into a
// node_modules copy of the package (everything getLocalArgentBinRelPath can
// emit); an absolute or out-of-tree path is a hand-tuned override.
export function isArgentManagedEntry(entry: McpServerEntry | null): boolean {
  if (entry === null || hasCustomizingEnv(entry)) return false;
  const { command, args } = entry;
  switch (command) {
    case MCP_BINARY_NAME:
      return args.length === 1 && args[0] === "mcp";
    case "node": {
      if (args.length !== 2 || args[1] !== "mcp" || !args[0]) return false;
      if (path.isAbsolute(args[0])) return false;
      const normalized = args[0].split("\\").join("/");
      return normalized.includes(`node_modules/${PACKAGE_NAME}/`);
    }
    case "yarn":
      return args.length === 2 && args[0] === "argent" && args[1] === "mcp";
    case "npx":
      return (
        args.length === 3 && args[0] === "--no-install" && args[1] === "argent" && args[2] === "mcp"
      );
    default:
      return false;
  }
}

// Writes `data` unchanged, except: when it has no own keys the file (and an
// empty parent directory) is removed instead. This deliberately does NOT
// recursively prune empty tables/arrays, so a foreign TOML server's `args = []`
// and any sibling empty value survive — the previous deep-prune silently
// stripped them, violating the "only touch argent" contract. Callers collapse
// their own emptied argent container via deleteIfEmpty before calling here, so
// "config held only argent" still results in file deletion.
//
// The JSON adapters achieve the same via editJsoncFile (which prunes only the
// edited path's empty ancestors and deletes the file when the document
// collapses to {}); TOML has no comment-preserving editor, so it keeps this
// parse → mutate → stringify writer.
function writeTomlOrRemove(filePath: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
    return;
  }

  writeToml(filePath, data);
}

// ── Installed-editor evidence ─────────────────────────────────────────────────
// A bare `.cursor` / `.codex` directory is NOT proof the editor is installed:
// argent itself creates those directories when it writes an MCP config, an
// allowlist, rules, agents, or skills there. Counting them as detection made
// every later `init` "detect" editors the user never installed
// (self-fulfilling detection). A directory is evidence only when it holds
// something argent doesn't write, or an argent-writable file carries
// non-argent content. Anything empty, unreadable, or unparseable counts as
// evidence — when unsure, keep the old dirExists behavior.

function dirHasEditorEvidence(dir: string, looksArgentOnly: (dir: string) => boolean): boolean {
  return dirExists(dir) && !looksArgentOnly(dir);
}

// Strict parses for the evidence check. The shared readJsonc/readToml swallow
// read/parse errors and return {} — here that would classify a corrupt USER
// config as argent-only and drop the editor from detection. null = can't read
// or parse; callers treat it as user evidence.
function parseJsoncStrict(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const errors: ParseError[] = [];
  const parsed = parseJsoncText(raw, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  return parsed as Record<string, unknown>;
}

function parseTomlStrict(filePath: string): Record<string, unknown> | null {
  try {
    return parseTomlText(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// rules/ and agents/ are byte copies of the bundled payloads — argent-written
// means every entry matches a bundled name exactly (a user's own
// "argent-notes.md" must NOT pass). skills/ entries come from the skills CLI;
// argent reserves the ARGENT_SKILL_PREFIX namespace there. An empty dir was
// not left by argent (its copies always carry content) — that's user evidence.
let bundledManagedNamesCache: Map<string, Set<string>> | null = null;
function bundledManagedNames(kind: "rules" | "agents"): Set<string> {
  if (!bundledManagedNamesCache) bundledManagedNamesCache = new Map();
  const cached = bundledManagedNamesCache.get(kind);
  if (cached) return cached;
  let names: Set<string>;
  try {
    names = new Set(fs.readdirSync(kind === "rules" ? RULES_DIR : AGENTS_DIR));
  } catch {
    names = new Set();
  }
  bundledManagedNamesCache.set(kind, names);
  return names;
}

function managedDirLooksArgentOnly(dir: string, kind: "rules" | "agents" | "skills"): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  if (kind === "skills") return entries.every((name) => name.startsWith(ARGENT_SKILL_PREFIX));
  const bundled = bundledManagedNames(kind);
  return entries.every((name) => bundled.has(name));
}

function cursorDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const full = path.join(dir, entry);
    if (entry === "mcp.json") {
      // Argent-written state is exactly { mcpServers: { argent: ... } } —
      // remove() prunes empty parents and deletes the emptied file, so any
      // other shape (extra keys, other servers, an empty document) is the
      // user's.
      const config = parseJsoncStrict(full);
      if (config === null) return false;
      const keys = Object.keys(config);
      if (keys.length !== 1 || keys[0] !== "mcpServers") return false;
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      const serverKeys = Object.keys(servers);
      return serverKeys.length === 1 && serverKeys[0] === MCP_SERVER_KEY;
    }
    if (entry === "permissions.json") {
      // Written by this adapter's addAllowlist: { mcpAllowlist: ["argent:*"] }.
      const config = parseJsoncStrict(full);
      if (config === null) return false;
      const keys = Object.keys(config);
      if (keys.length !== 1 || keys[0] !== "mcpAllowlist") return false;
      const list = config.mcpAllowlist;
      return (
        Array.isArray(list) &&
        list.length > 0 &&
        list.every((rule) => rule === CURSOR_ALLOWLIST_PATTERN)
      );
    }
    if (entry === "rules" || entry === "agents" || entry === "skills") {
      return managedDirLooksArgentOnly(full, entry);
    }
    return false;
  });
}

function codexDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const full = path.join(dir, entry);
    if (entry === "config.toml") {
      const config = parseTomlStrict(full);
      if (config === null) return false;
      const configEntries = Object.entries(config);
      // An empty document isn't argent's either — remove() deletes the file
      // once it holds nothing.
      if (configEntries.length === 0) return false;
      return configEntries.every(([key, value]) => {
        if (key === "mcp_servers") {
          const servers = (value ?? {}) as Record<string, unknown>;
          const serverKeys = Object.keys(servers);
          return serverKeys.length === 1 && serverKeys[0] === MCP_SERVER_KEY;
        }
        if (key === "developer_instructions") {
          // Argent-written instructions live entirely inside the managed
          // markers; any text outside them is the user's own.
          return typeof value === "string" && removeArgentSection(value) === "";
        }
        return false;
      });
    }
    if (entry === "rules" || entry === "agents" || entry === "skills") {
      return managedDirLooksArgentOnly(full, entry);
    }
    return false;
  });
}

// ── Cursor adapter ────────────────────────────────────────────────────────────
// MARK: Cursor
// Format: { mcpServers: { argent: { command, args, env } } }

const cursorAdapter: McpConfigAdapter = {
  name: "Cursor",

  detect(): boolean {
    return (
      dirHasEditorEvidence(path.join(homedir(), ".cursor"), cursorDirLooksArgentOnly) ||
      dirHasEditorEvidence(path.join(process.cwd(), ".cursor"), cursorDirLooksArgentOnly)
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".cursor", "mcp.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".cursor", "mcp.json");
  },

  // Cursor is a VS Code fork: .cursor/mcp.json is JSONC (line/block comments,
  // trailing commas). Routing write/remove/hasArgentEntry through readJsonc /
  // editJsoncFile applies path-targeted text edits that preserve comments and
  // foreign servers. The old readJson → writeJson path ran commented files
  // through readJson's `catch { return {} }`, then persisted only the argent
  // entry — destroying every pre-existing server and comment. Matches VS Code.
  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], {
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], undefined);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  // Cursor's allowlist lives in a separate ~/.cursor/permissions.json, which —
  // like every Cursor config — is JSONC (comments, trailing commas) and may
  // carry the user's own unrelated rules. Route through readJsonc / editJsoncFile
  // so a hand-commented or multi-rule permissions.json survives: the old readJson
  // path ran it through `catch { return {} }` and rewrote the whole file with
  // only { mcpAllowlist }, dropping every foreign rule and comment. Newly matters
  // because `hasArgentEntry` now reads mcp.json with readJsonc, so `update`
  // detects a commented config as configured and calls this.
  addAllowlist(): void {
    const permPath = path.join(homedir(), ".cursor", "permissions.json");
    const config = readJsonc(permPath);
    const list = Array.isArray(config.mcpAllowlist) ? (config.mcpAllowlist as string[]) : [];
    if (list.includes(CURSOR_ALLOWLIST_PATTERN)) return;
    editJsoncFile(permPath, ["mcpAllowlist"], [...list, CURSOR_ALLOWLIST_PATTERN]);
  },

  removeAllowlist(_root: string, scope: "local" | "global"): void {
    // Cursor's allowlist lives ONLY in the machine-global permissions file.
    // A scope-"local" cleanup (an uninstall retaining the global install)
    // must not strip a file that install still depends on.
    if (scope !== "global") return;
    const permPath = path.join(homedir(), ".cursor", "permissions.json");
    if (!fs.existsSync(permPath)) return;
    const config = readJsonc(permPath);
    const list = Array.isArray(config.mcpAllowlist) ? (config.mcpAllowlist as string[]) : undefined;
    if (!list || !list.includes(CURSOR_ALLOWLIST_PATTERN)) return;
    const next = list.filter((rule) => rule !== CURSOR_ALLOWLIST_PATTERN);
    // undefined deletes the emptied key; editJsoncFile prunes it and removes the
    // file if the document collapses to {} (matching the old writeJsonOrRemove).
    editJsoncFile(permPath, ["mcpAllowlist"], next.length > 0 ? next : undefined);
  },
};

// ── Claude Code adapter ───────────────────────────────────────────────────────
// MARK: Claude
// Format: { mcpServers: { argent: { type: "stdio", command, args, env } } }
// Project: .mcp.json   Global: ~/.claude.json
// Also manages permissions in .claude/settings.json

// ~/.claude.json keys its "local scope" entries by the EXACT absolute project
// path. Match keys against the root loosely — realpathSync.native canonicalizes
// symlinks and, on case-insensitive filesystems, on-disk case (a session
// started from /users/… writes a key .mcp.json-based lookups would miss).
function claudeProjectKeysForRoot(projects: Record<string, unknown>, root: string): string[] {
  const canonical = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const target = canonical(root);
  return Object.keys(projects).filter((key) => key === root || canonical(key) === target);
}

// A recorded "reject" for the argent .mcp.json server. Claude Code honors a
// disabledMcpjsonServers entry from ANY settings file, so a rejection recorded
// before this init would keep the fresh project-scope entry from ever loading.
function claudeDisabledListFinding(
  settingsPath: string,
  label: string,
  projectConfined: boolean
): ShadowingConfigFinding | null {
  if (!fs.existsSync(settingsPath)) return null;
  const disabled = readJson(settingsPath).disabledMcpjsonServers;
  if (!Array.isArray(disabled) || !disabled.includes(MCP_SERVER_KEY)) return null;
  return {
    location: label,
    reason: projectConfined
      ? `a recorded "reject" in disabledMcpjsonServers blocks the .mcp.json entry from loading`
      : `a machine-wide "reject" in disabledMcpjsonServers blocks .mcp.json argent entries in ` +
        `every project; if that is not deliberate, remove "argent" from the list`,
    entry: null,
    // Removing a PROJECT-confined rejection only lets Claude Code prompt for
    // approval again — running `argent init` is that consent. The user-global
    // list (~/.claude/settings.json) reaches every project on the machine, so
    // it is never auto-removed; the shared policy warns instead.
    autoRemove: projectConfined,
    remove: (): boolean => {
      const config = readJson(settingsPath);
      const list = config.disabledMcpjsonServers;
      if (!Array.isArray(list)) return false;
      const idx = list.indexOf(MCP_SERVER_KEY);
      if (idx === -1) return false;
      list.splice(idx, 1);
      if (list.length === 0) delete config.disabledMcpjsonServers;
      // Plain write — settings.json is the USER'S file. writeJsonOrRemove
      // would prune other empty structures and could delete the whole file;
      // dropping one list entry must never do that.
      writeJson(settingsPath, config);
      return true;
    },
  };
}

const claudeAdapter: McpConfigAdapter = {
  name: "Claude Code",

  detect(): boolean {
    return (
      fs.existsSync(path.join(process.cwd(), ".mcp.json")) ||
      fs.existsSync(path.join(homedir(), ".claude.json")) ||
      dirExists(path.join(process.cwd(), ".claude")) ||
      dirExists(path.join(homedir(), ".claude"))
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".mcp.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".claude.json");
  },

  // JSONC is a superset of JSON, so routing through readJsonc / editJsoncFile is
  // safe for this strict-JSON config and keeps every MCP-entry write on the one
  // comment- and foreign-server-preserving path (see the Cursor adapter).
  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], {
      type: "stdio",
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    if (configPath === this.globalPath()) {
      // ~/.claude.json is the user's primary Claude config (OAuth state,
      // per-project trust/history). Never delete or deep-prune it: drop only
      // our key (collapsing an emptied mcpServers) and write the rest back
      // verbatim, so editJsoncFile's collapse-to-{} deletion can't reach it.
      // readJsonc above keeps a stray comment from nuking the whole file to {}.
      delete servers[MCP_SERVER_KEY];
      if (Object.keys(servers).length === 0) delete config.mcpServers;
      writeJson(configPath, config);
    } else {
      // .mcp.json is JSONC-safe: preserve comments and foreign servers, and
      // delete the file only if argent was all it held.
      editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], undefined);
    }
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  // Claude Code's scope precedence is local > project (.mcp.json) > user
  // (~/.claude.json top-level). "Local scope" lives outside the
  // projectPath/globalPath pair: projects["<abs path>"].mcpServers in
  // ~/.claude.json (the default target of `claude mcp add`). A stale entry
  // there outranks BOTH scopes init can write — no tools, no error. Also
  // reports recorded .mcp.json rejections (see claudeDisabledListFinding).
  findShadowingConfigs(root: string, writtenScope: "local" | "global"): ShadowingConfigFinding[] {
    const findings: ShadowingConfigFinding[] = [];
    const claudeJsonPath = path.join(homedir(), ".claude.json");
    const projects = readJson(claudeJsonPath).projects;
    if (isRecord(projects)) {
      for (const key of claudeProjectKeysForRoot(projects, root)) {
        const project = projects[key];
        if (!isRecord(project)) continue;
        const servers = project.mcpServers;
        if (!isRecord(servers) || !(MCP_SERVER_KEY in servers)) continue;
        const raw = servers[MCP_SERVER_KEY];
        const entry = normalizeServerEntry(raw);
        // Auto-remove ONLY the stock shape a previous install left behind:
        // bare `argent mcp`, no env. Anything else may be a deliberate
        // override that outranks the committed entry BY DESIGN — report it so
        // the shared policy warns or asks; never delete silently (`argent
        // update --yes` runs this sweep too).
        const hasCustomEnv = isRecord(raw) && isRecord(raw.env) && Object.keys(raw.env).length > 0;
        const isStockShape =
          entry !== null &&
          entry.command === MCP_BINARY_NAME &&
          entry.args.length === 1 &&
          entry.args[0] === "mcp" &&
          !hasCustomEnv;
        findings.push({
          location: `~/.claude.json (local-scope entry for ${key})`,
          reason: isStockShape
            ? "local scope outranks every entry argent can write — the new install would be silently ignored"
            : "a customized local-scope entry outranks the entry just written; if it is a " +
              "deliberate override keep it, otherwise remove it (claude mcp remove argent)",
          entry,
          // Keyed to this project root, so removal cannot affect other
          // projects — but only the stock shape is provably a leftover.
          autoRemove: isStockShape,
          remove: (): boolean => {
            // Re-read at removal time and bail unless the entry is still
            // there: readJson yields {} on a parse failure, and writing that
            // back would destroy unrelated state (OAuth sessions, trust
            // decisions).
            const config = readJson(claudeJsonPath);
            const liveProjects = config.projects;
            if (!isRecord(liveProjects) || !isRecord(liveProjects[key])) return false;
            const liveServers = (liveProjects[key] as Record<string, unknown>).mcpServers;
            if (!isRecord(liveServers) || !(MCP_SERVER_KEY in liveServers)) return false;
            delete liveServers[MCP_SERVER_KEY];
            if (Object.keys(liveServers).length === 0) {
              delete (liveProjects[key] as Record<string, unknown>).mcpServers;
            }
            writeJson(claudeJsonPath, config);
            return true;
          },
        });
      }
    }
    if (writtenScope === "local") {
      const candidates: Array<[string, string, boolean]> = [
        [path.join(root, ".claude", "settings.json"), ".claude/settings.json", true],
        [path.join(root, ".claude", "settings.local.json"), ".claude/settings.local.json", true],
        [path.join(homedir(), ".claude", "settings.json"), "~/.claude/settings.json", false],
      ];
      for (const [settingsPath, label, projectConfined] of candidates) {
        const finding = claudeDisabledListFinding(settingsPath, label, projectConfined);
        if (finding) findings.push(finding);
      }
    }
    return findings;
  },

  addAllowlist(root: string, scope: "local" | "global"): void {
    addClaudePermission(root, scope);
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    removeClaudePermission(root, scope);
  },
};

// ── VS Code adapter ──────────────────────────────────────────────────────────
// MARK: VSCode
// Format: { servers: { argent: { type: "stdio", command, args, env } } }
// Project only: .vscode/mcp.json

const vscodeAdapter: McpConfigAdapter = {
  name: "VS Code",

  detect(): boolean {
    return (
      dirExists(path.join(process.cwd(), ".vscode")) || dirExists(path.join(homedir(), ".vscode"))
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".vscode", "mcp.json");
  },

  globalPath(): string | null {
    return null;
  },

  // .vscode/mcp.json is JSONC — VS Code allows line/block comments and trailing
  // commas. The previous JSON.parse → mutate → JSON.stringify path ran through
  // readJson, whose `catch { return {} }` turned any commented file into {} and
  // then persisted only { servers: { argent } }, destroying every pre-existing
  // user server (and their comments). All four entry points now go through
  // readJsonc / editJsoncFile — path-targeted text edits that preserve comments
  // and foreign servers — matching the Zed and opencode adapters.
  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["servers", MCP_SERVER_KEY], {
      type: "stdio",
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.servers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    editJsoncFile(configPath, ["servers", MCP_SERVER_KEY], undefined);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.servers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  // The user-profile mcp.json is a scope the projectPath/globalPath pair
  // doesn't cover. User-vs-workspace precedence is undocumented (observed:
  // silent single-winner), so a stale entry there can shadow a fresh
  // .vscode/mcp.json entry. Report it; the shared policy removes it only when
  // provably dead.
  findShadowingConfigs(_root: string, _writtenScope: "local" | "global"): ShadowingConfigFinding[] {
    const findings: ShadowingConfigFinding[] = [];
    for (const userDir of vscodeUserDirs()) {
      const configPath = path.join(userDir, "mcp.json");
      const entry = this.getArgentEntry(configPath);
      if (!entry) continue;
      findings.push({
        location: configPath,
        reason:
          "a user-profile MCP entry with the same name can take precedence over the workspace entry (VS Code does not document which wins)",
        entry,
        autoRemove: false,
        remove: () => this.remove(configPath),
      });
    }
    return findings;
  },
};

// Default-profile user config dirs for VS Code stable and Insiders. Only dirs
// that exist are returned, so non-installed variants cost nothing.
function vscodeUserDirs(): string[] {
  const bases: string[] = [];
  if (process.platform === "darwin") {
    bases.push(path.join(homedir(), "Library", "Application Support"));
  } else if (process.platform === "win32") {
    if (process.env.APPDATA) bases.push(process.env.APPDATA);
  } else {
    bases.push(path.join(homedir(), ".config"));
  }
  const dirs: string[] = [];
  for (const base of bases) {
    for (const product of ["Code", "Code - Insiders"]) {
      const dir = path.join(base, product, "User");
      if (dirExists(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

// ── Windsurf adapter ─────────────────────────────────────────────────────────
// MARK: Windsurf
// Format: { mcpServers: { argent: { command, args, env } } }
// Global only: ~/.codeium/windsurf/mcp_config.json

const windsurfAdapter: McpConfigAdapter = {
  name: "Windsurf",

  detect(): boolean {
    return dirExists(path.join(homedir(), ".codeium", "windsurf"));
  },

  projectPath(): string | null {
    return null;
  },

  globalPath(): string | null {
    return path.join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  },

  // JSONC-safe MCP-entry writes (see the Cursor adapter): editJsoncFile
  // preserves comments and pre-existing foreign servers on this JSON config.
  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], {
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], undefined);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  // JSONC-safe allowlist edits (see the Cursor adapter): the argent entry lives
  // in this same mcp_config.json, and `init` runs write() (comment-preserving)
  // before addAllowlist(). The old readJson path choked on any user comment and
  // silently skipped the toggle; editJsoncFile targets just the argent entry's
  // alwaysAllow key so comments and foreign servers survive.
  addAllowlist(): void {
    const configPath = path.join(homedir(), ".codeium", "windsurf", "mcp_config.json");
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY, "alwaysAllow"], ["*"]);
  },

  removeAllowlist(_root: string, scope: "local" | "global"): void {
    // Windsurf is a global-only client — same rule as Cursor's allowlist: a
    // scope-"local" cleanup must not touch the machine-global config a
    // retained global install depends on.
    if (scope !== "global") return;
    const configPath = path.join(homedir(), ".codeium", "windsurf", "mcp_config.json");
    if (!fs.existsSync(configPath)) return;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
    const entry = servers?.[MCP_SERVER_KEY];
    if (!entry?.alwaysAllow) return;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY, "alwaysAllow"], undefined);
  },
};

// ── Zed adapter ──────────────────────────────────────────────────────────────
// MARK: Zed
// Format: merges { context_servers: { argent: { source: "custom", command, args, env } } }
// Into existing settings.json

const zedAdapter: McpConfigAdapter = {
  name: "Zed",

  detect(): boolean {
    return dirExists(path.join(homedir(), ".config", "zed"));
  },

  projectPath(root: string): string | null {
    return path.join(root, ".zed", "settings.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".config", "zed", "settings.json");
  },

  // Zed's settings.json is JSONC (line + block comments, trailing commas).
  // The previous JSON.parse → mutate → JSON.stringify path silently stripped
  // every comment in the user's hand-edited file. All four entry points now
  // go through editJsoncFile, which applies path-targeted text edits via
  // jsonc-parser so comments and formatting outside the touched key survive.
  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["context_servers", MCP_SERVER_KEY], {
      source: "custom",
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    // JSONC-tolerant read: a user-authored settings.json may contain comments
    // that JSON.parse would reject (silently swallowed by readJson, leaving
    // this branch thinking nothing needed removing).
    const config = readJsonc(configPath);
    const servers = config.context_servers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    editJsoncFile(configPath, ["context_servers", MCP_SERVER_KEY], undefined);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.context_servers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  // Zed doesn't support server-level wildcards for MCP tools — each tool
  // would need its own entry.  Setting the global default to "allow" is the
  // documented opt-in; built-in security rules still protect against
  // destructive operations.
  addAllowlist(root: string, scope: "local" | "global"): void {
    const settingsPath =
      scope === "global"
        ? path.join(homedir(), ".config", "zed", "settings.json")
        : path.join(root, ".zed", "settings.json");
    editJsoncFile(settingsPath, ["agent", "tool_permissions", "default"], "allow");
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const settingsPath =
      scope === "global"
        ? path.join(homedir(), ".config", "zed", "settings.json")
        : path.join(root, ".zed", "settings.json");
    if (!fs.existsSync(settingsPath)) return;
    const config = readJsonc(settingsPath);
    const perms = (config.agent as Record<string, unknown>)?.tool_permissions as
      | Record<string, unknown>
      | undefined;
    if (!perms || perms.default !== "allow") return;
    editJsoncFile(settingsPath, ["agent", "tool_permissions", "default"], "confirm");
  },
};

// ── Gemini CLI adapter ────────────────────────────────────────────────────────
// MARK: Gemini
// Format: { mcpServers: { argent: { command, args, env } } }
// Project: <root>/.gemini/settings.json   Global: ~/.gemini/settings.json

const geminiAdapter: McpConfigAdapter = {
  name: "Gemini",

  detect(): boolean {
    return (
      dirExists(path.join(homedir(), ".gemini")) || dirExists(path.join(process.cwd(), ".gemini"))
    );
  },

  projectPath(root: string): string {
    return path.join(root, ".gemini", "settings.json");
  },

  globalPath(): string {
    return path.join(homedir(), ".gemini", "settings.json");
  },

  // JSONC-safe MCP-entry writes (see the Cursor adapter): editJsoncFile
  // preserves comments and pre-existing foreign servers on this JSON config.
  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], {
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], undefined);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  // JSONC-safe allowlist edits (see the Cursor adapter): the argent entry lives
  // in this same settings.json, and `init` runs write() (comment-preserving)
  // before addAllowlist(). The old readJson path choked on any user comment and
  // silently skipped the toggle; editJsoncFile targets just the argent entry's
  // trust key so comments and foreign servers survive.
  addAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);

    if (!configPath) {
      return;
    }

    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY, "trust"], true);
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);

    if (!configPath || !fs.existsSync(configPath)) {
      return;
    }

    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
    const entry = servers?.[MCP_SERVER_KEY];
    if (!entry?.trust) return;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY, "trust"], undefined);
  },
};

// ── Codex CLI adapter ────────────────────────────────────────────────────────
// MARK: Codex
// Format (TOML): [mcp_servers.argent] command = "argent" args = ["mcp"] env = { ... }
// Project: <root>/.codex/config.toml   Global: ~/.codex/config.toml

const CODEX_FILENAME = ".codex";

const codexAdapter: McpConfigAdapter = {
  name: "Codex",

  detect(): boolean {
    return (
      dirHasEditorEvidence(path.join(homedir(), CODEX_FILENAME), codexDirLooksArgentOnly) ||
      dirHasEditorEvidence(path.join(process.cwd(), CODEX_FILENAME), codexDirLooksArgentOnly)
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, CODEX_FILENAME, "config.toml");
  },

  globalPath(): string | null {
    return path.join(homedir(), CODEX_FILENAME, "config.toml");
  },

  write(configPath: string, entry: McpServerEntry): void {
    const config = readToml(configPath);
    const servers = (config.mcp_servers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    };
    config.mcp_servers = servers;
    writeToml(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readToml(configPath);
    const servers = config.mcp_servers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    deleteIfEmpty(config, "mcp_servers");
    writeTomlOrRemove(configPath, config);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readToml(configPath);
    const servers = config.mcp_servers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  addAllowlist(root, scope): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);

    if (!configPath) {
      return;
    }

    const tools = getAvailableToolIds();
    const config = readToml(configPath) as CodexConfig;

    config.mcp_servers ??= {};
    config.mcp_servers.argent ??= {};
    config.mcp_servers.argent.tools ??= {};
    const toolsConfig = config.mcp_servers.argent.tools;

    for (const tool of tools) {
      toolsConfig[tool] = {
        approval_mode: "approve",
      };
    }

    writeToml(configPath, config);
  },

  removeAllowlist(root, scope): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);

    if (!configPath) {
      return;
    }

    const tools = getAvailableToolIds();
    const config = readToml(configPath) as CodexConfig;
    const toolsConfig = config?.mcp_servers?.argent?.tools;

    if (toolsConfig === undefined) {
      return;
    }

    for (const tool of tools) {
      if (tool in toolsConfig) {
        delete toolsConfig[tool];
      }
    }

    writeToml(configPath, config);
  },
};

// ── Hermes adapter ──────────────────────────────────────────────────────────
// Format (YAML): mcp_servers: { argent: { command, args, env } }
// Global only: ~/.hermes/config.yaml
//
// Uses the yaml Document API instead of POJO round-trip so user comments
// and formatting in ~/.hermes/config.yaml survive every write. Refuses to
// touch the file if mcp_servers exists but is not a YAML mapping (sequence
// or scalar would otherwise be silently clobbered).

const hermesAdapter: McpConfigAdapter = {
  name: "Hermes",

  detect(): boolean {
    return dirExists(path.join(homedir(), ".hermes"));
  },

  projectPath(): string | null {
    return null;
  },

  globalPath(): string | null {
    return path.join(homedir(), ".hermes", "config.yaml");
  },

  write(configPath: string, entry: McpServerEntry): void {
    const doc = readYaml(configPath);
    const existing = doc.get("mcp_servers");
    if (existing != null && !isMap(existing)) {
      throw new Error(`mcp_servers in ${configPath} is not a YAML mapping`);
    }
    if (existing == null) {
      // Either absent or explicit null. Drop it so setIn creates a fresh map.
      doc.delete("mcp_servers");
    }
    doc.setIn(["mcp_servers", MCP_SERVER_KEY], {
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
    writeYaml(configPath, doc);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const doc = readYaml(configPath);
    const servers = doc.get("mcp_servers");
    if (!isMap(servers)) return false;
    if (!servers.has(MCP_SERVER_KEY)) return false;
    servers.delete(MCP_SERVER_KEY);
    if (servers.items.length === 0) {
      doc.delete("mcp_servers");
    }
    writeYaml(configPath, doc);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const doc = readYaml(configPath);
    const servers = doc.get("mcp_servers");
    if (!isMap(servers)) return null;
    if (!servers.has(MCP_SERVER_KEY)) return null;
    const raw = (doc.toJS() as Record<string, unknown>).mcp_servers;
    return normalizeServerEntry(isRecord(raw) ? raw[MCP_SERVER_KEY] : {});
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },
};

// ── opencode adapter ────────────────────────────────────────────────────────
// MARK: opencode
// Format: { mcp: { argent: { type: "local", command: [cmd, ...args], enabled,
//   environment } }, tools: { "argent*": true } }
// Project: <root>/opencode.json   Global: ~/.config/opencode/opencode.json
//
// Unlike every other adapter, opencode's config file is optional — a fresh
// install typically has no opencode.json at all and the CLI runs with
// defaults. So we cannot rely on the config directory existing to detect
// opencode; instead we probe for the `opencode` binary on PATH.

const OPENCODE_BINARY = "opencode";
const OPENCODE_ALLOWLIST_PATTERN = "argent*";

// Same filename prioritization order that's used by opencode CLI
const OPENCODE_PROJECT_FILES = ["opencode.jsonc", "opencode.json"] as const;
const OPENCODE_GLOBAL_FILES = ["opencode.jsonc", "opencode.json", "config.json"] as const;

function hasOpenCodeBinary(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFileSync(cmd, [OPENCODE_BINARY], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function pickOpencodeConfig(dir: string, candidates: readonly string[]): string {
  for (const name of candidates) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, "opencode.json");
}

const openCodeAdapter: McpConfigAdapter = {
  name: "opencode",

  detect(): boolean {
    return hasOpenCodeBinary();
  },

  projectPath(root: string): string | null {
    return pickOpencodeConfig(root, OPENCODE_PROJECT_FILES);
  },

  globalPath(): string | null {
    return pickOpencodeConfig(path.join(homedir(), ".config", "opencode"), OPENCODE_GLOBAL_FILES);
  },

  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["mcp", MCP_SERVER_KEY], {
      type: "local",
      command: [entry.command, ...entry.args],
      enabled: true,
      ...(hasEnv(entry) ? { environment: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcp as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    editJsoncFile(configPath, ["mcp", MCP_SERVER_KEY], undefined);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.mcp as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  addAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);
    if (!configPath) return;
    editJsoncFile(configPath, ["tools", OPENCODE_ALLOWLIST_PATTERN], true);
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);
    if (!configPath || !fs.existsSync(configPath)) return;
    const config = readJsonc(configPath);
    const tools = config.tools as Record<string, unknown> | undefined;
    if (!tools || !(OPENCODE_ALLOWLIST_PATTERN in tools)) return;
    editJsoncFile(configPath, ["tools", OPENCODE_ALLOWLIST_PATTERN], undefined);
  },
};

// ── Kiro adapter ─────────────────────────────────────────────────────────────
// MARK: Kiro
// Format: { mcpServers: { argent: { command, args, env } } }
// Project: <root>/.kiro/settings/mcp.json   Global: ~/.kiro/settings/mcp.json
//
// The same .kiro/settings/mcp.json is read by both the Kiro IDE and the Kiro
// CLI (the rebranded Amazon Q Developer CLI), so one entry serves both.
//
// Allowlist: autoApprove: ["*"] on the argent entry — the Kiro IDE's documented
// "approve every tool" syntax. The Kiro CLI's server-config struct has no
// autoApprove field and is NOT deny_unknown_fields, so the CLI silently ignores
// the key (verified against kiro-cli 2.9.0 / upstream CustomToolConfig). Net:
// honored by the IDE, harmless to the CLI, which carries its own trust model.
// IDE: https://kiro.dev/docs/mcp/configuration/  CLI: https://kiro.dev/docs/cli/mcp/

const KIRO_AUTO_APPROVE_ALL = ["*"];

const kiroAdapter: McpConfigAdapter = {
  name: "Kiro",

  detect(): boolean {
    return dirExists(path.join(homedir(), ".kiro")) || dirExists(path.join(process.cwd(), ".kiro"));
  },

  projectPath(root: string): string | null {
    return path.join(root, ".kiro", "settings", "mcp.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".kiro", "settings", "mcp.json");
  },

  // Kiro is a VS Code fork: .kiro/settings/mcp.json is JSONC. As with Cursor,
  // route write/remove/hasArgentEntry through readJsonc / editJsoncFile so
  // comments and foreign servers survive instead of being flattened away by the
  // old readJson → writeJson path.
  write(configPath: string, entry: McpServerEntry): void {
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], {
      command: entry.command,
      args: entry.args,
      ...(hasEnv(entry) ? { env: entry.env } : {}),
    });
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], undefined);
    return true;
  },

  getArgentEntry(configPath: string): McpServerEntry | null {
    if (!fs.existsSync(configPath)) return null;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return normalizeServerEntry(servers?.[MCP_SERVER_KEY]);
  },

  hasArgentEntry(configPath: string): boolean {
    return this.getArgentEntry(configPath) !== null;
  },

  // JSONC-safe allowlist edits (see the Cursor adapter): .kiro/settings/mcp.json
  // is JSONC, the argent entry lives in it, and `init` runs write() (comment-
  // preserving) before addAllowlist(). The old readJson path choked on any user
  // comment and silently skipped the toggle; editJsoncFile targets just the
  // argent entry's autoApprove key so comments and foreign servers survive.
  addAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);
    if (!configPath) return;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return;
    editJsoncFile(
      configPath,
      ["mcpServers", MCP_SERVER_KEY, "autoApprove"],
      [...KIRO_AUTO_APPROVE_ALL]
    );
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);
    if (!configPath || !fs.existsSync(configPath)) return;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
    const entry = servers?.[MCP_SERVER_KEY];
    if (!entry?.autoApprove) return;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY, "autoApprove"], undefined);
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────
// MARK: Registry

export const ALL_ADAPTERS: McpConfigAdapter[] = [
  cursorAdapter,
  claudeAdapter,
  vscodeAdapter,
  windsurfAdapter,
  zedAdapter,
  geminiAdapter,
  codexAdapter,
  hermesAdapter,
  openCodeAdapter,
  kiroAdapter,
];

export function detectAdapters(): McpConfigAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.detect());
}

export function getAdapterByName(name: string): McpConfigAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.name.toLowerCase() === name.toLowerCase());
}

export type AdapterConfigScope = "project" | "global";

export interface ConfiguredAdapterScope {
  adapter: McpConfigAdapter;
  scope: AdapterConfigScope;
  configPath: string;
}

// Returns the (adapter, scope, configPath) tuples where argent is already
// configured. `update` uses this to skip editors the user opted out of during
// `init` even when their config dir happens to exist on disk (issue #195).
//
// Detection is best-effort per scope: `hasArgentEntry` parses the on-disk
// config and some backings throw on malformed input (e.g. Hermes' readYaml on
// a broken ~/.hermes/config.yaml). One unparseable file must not abort the
// whole update flow, so a throwing probe is treated as "not configured" and
// skipped rather than propagated.
export function findConfiguredAdapterScopes(
  adapters: readonly McpConfigAdapter[],
  projectRoot: string
): ConfiguredAdapterScope[] {
  const results: ConfiguredAdapterScope[] = [];
  const hasEntry = (adapter: McpConfigAdapter, configPath: string): boolean => {
    try {
      return adapter.hasArgentEntry(configPath);
    } catch {
      return false;
    }
  };
  for (const adapter of adapters) {
    const projectPath = adapter.projectPath(projectRoot);
    if (projectPath && hasEntry(adapter, projectPath)) {
      results.push({ adapter, scope: "project", configPath: projectPath });
    }
    const globalPath = adapter.globalPath();
    if (globalPath && hasEntry(adapter, globalPath)) {
      results.push({ adapter, scope: "global", configPath: globalPath });
    }
  }
  return results;
}

// ── Claude permissions helpers ────────────────────────────────────────────────

export function addClaudePermission(root: string, scope: "local" | "global"): void {
  const settingsPath =
    scope === "global"
      ? path.join(homedir(), ".claude", "settings.json")
      : path.join(root, ".claude", "settings.json");

  // .claude/settings.json is normally strict JSON but is comment-tolerant in
  // practice; route through readJsonc / editJsoncFile so a hand-added comment
  // doesn't make readJson's `catch { return {} }` drop the user's other
  // permissions on write — the same unconditional read-write clobber the mcp.json
  // adapters were migrated off. editJsoncFile creates the permissions.allow path
  // if absent and preserves comments and foreign keys.
  const config = readJsonc(settingsPath);
  const permissions = (config.permissions ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];
  if (allow.includes(PERMISSION_RULE)) return;
  editJsoncFile(settingsPath, ["permissions", "allow"], [...allow, PERMISSION_RULE]);
}

export function removeClaudePermission(root: string, scope: "local" | "global"): void {
  const settingsPath =
    scope === "global"
      ? path.join(homedir(), ".claude", "settings.json")
      : path.join(root, ".claude", "settings.json");

  if (!fs.existsSync(settingsPath)) return;
  const config = readJsonc(settingsPath);
  const permissions = config?.permissions as Record<string, unknown> | undefined;
  const allow = permissions?.allow;
  if (!permissions || !Array.isArray(allow)) return;
  if (!allow.includes(PERMISSION_RULE)) return;
  const next = (allow as string[]).filter((rule) => rule !== PERMISSION_RULE);
  // undefined deletes the emptied `allow`; editJsoncFile then prunes an emptied
  // `permissions` and removes the file if the document collapses to {} (matching
  // the old deleteIfEmpty + writeJsonOrRemove chain), while a comment or foreign
  // permission keeps the file and survives byte-intact.
  editJsoncFile(settingsPath, ["permissions", "allow"], next.length > 0 ? next : undefined);
}

// ── Rules / Agents copy helpers ───────────────────────────────────────────────

export type ManagedContentScope = "local" | "global";

export interface ManagedContentTarget {
  editorName: string;
  targetPath: string;
  label: string;
}

export interface ManagedContentTargets {
  skillTargets: ManagedContentTarget[];
  ruleTargets: ManagedContentTarget[];
  agentTargets: ManagedContentTarget[];
  codexConfigTargets: ManagedContentTarget[];
  skillsLockTargets: ManagedContentTarget[];
}

function formatManagedPathLabel(targetPath: string, root: string): string {
  const home = homedir();
  if (targetPath === home || targetPath.startsWith(`${home}${path.sep}`)) {
    return `~${targetPath.slice(home.length)}`;
  }

  const relative = path.relative(root, targetPath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }

  return targetPath;
}

function addManagedTarget(
  targets: ManagedContentTarget[],
  editorName: string,
  targetPath: string,
  root: string
): void {
  targets.push({
    editorName,
    targetPath,
    label: formatManagedPathLabel(targetPath, root),
  });
}

function getAdapterBasePath(
  adapter: McpConfigAdapter,
  root: string,
  scope: ManagedContentScope
): string | null {
  const configPath = scope === "global" ? adapter.globalPath() : adapter.projectPath(root);
  return configPath ? path.dirname(configPath) : null;
}

export function getManagedContentTargets(
  adapters: McpConfigAdapter[],
  root: string,
  scope: ManagedContentScope
): ManagedContentTargets {
  const targets: ManagedContentTargets = {
    skillTargets: [],
    ruleTargets: [],
    agentTargets: [],
    codexConfigTargets: [],
    skillsLockTargets: [],
  };

  const workspaceBase = scope === "global" ? homedir() : root;
  addManagedTarget(
    targets.skillTargets,
    "skills",
    path.join(workspaceBase, ".agents", "skills"),
    root
  );
  addManagedTarget(
    targets.skillsLockTargets,
    "skills",
    path.join(workspaceBase, "skills-lock.json"),
    root
  );

  for (const adapter of adapters) {
    switch (adapter.name) {
      case "Cursor": {
        const base = getAdapterBasePath(adapter, root, scope);
        if (!base) break;
        addManagedTarget(targets.skillTargets, adapter.name, path.join(base, "skills"), root);
        addManagedTarget(targets.ruleTargets, adapter.name, path.join(base, "rules"), root);
        break;
      }
      case "Claude Code": {
        const claudeBase =
          scope === "global" ? path.join(homedir(), ".claude") : path.join(root, ".claude");
        addManagedTarget(targets.skillTargets, adapter.name, path.join(claudeBase, "skills"), root);
        addManagedTarget(targets.ruleTargets, adapter.name, path.join(claudeBase, "rules"), root);
        addManagedTarget(targets.agentTargets, adapter.name, path.join(claudeBase, "agents"), root);
        break;
      }
      case "Gemini": {
        const geminiBase =
          scope === "global" ? path.join(homedir(), ".gemini") : path.join(root, ".gemini");
        addManagedTarget(targets.ruleTargets, adapter.name, path.join(geminiBase, "rules"), root);
        addManagedTarget(targets.agentTargets, adapter.name, path.join(geminiBase, "agents"), root);
        break;
      }
      case "Codex": {
        const configPath = scope === "global" ? adapter.globalPath() : adapter.projectPath(root);
        if (!configPath) break;
        addManagedTarget(targets.codexConfigTargets, adapter.name, configPath, root);
        break;
      }
      case "opencode": {
        // opencode's config lives at the project root (opencode.json), but
        // its skills/agents live under .opencode/. Globally both live under
        // ~/.config/opencode/.
        const base =
          scope === "global"
            ? path.join(homedir(), ".config", "opencode")
            : path.join(root, ".opencode");
        addManagedTarget(targets.skillTargets, adapter.name, path.join(base, "skills"), root);
        addManagedTarget(targets.agentTargets, adapter.name, path.join(base, "agents"), root);
        break;
      }
    }
  }

  return targets;
}

// ── Codex developer_instructions helpers ─────────────────────────────────────
// Codex has no rules/ directory for model instructions. Instead we inject
// rule content into the `developer_instructions` field of config.toml,
// delimited by markers so we can update/remove without touching user content.

const ARGENT_RULES_START = "# --- argent rules (managed by argent init — do not edit) ---";
const ARGENT_RULES_END = "# --- end argent rules ---";

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

function readAndConcatRules(rulesDir: string): string | null {
  if (!fs.existsSync(rulesDir)) return null;
  const files = fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) return null;
  const parts: string[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(rulesDir, file), "utf8");
    const stripped = stripFrontmatter(raw);
    if (stripped) parts.push(stripped);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function injectArgentSection(existing: string | undefined, rules: string): string {
  const section = `${ARGENT_RULES_START}\n${rules}\n${ARGENT_RULES_END}`;
  if (!existing) return section;
  // Replace existing argent section if present
  const re = new RegExp(
    `${escapeStringRegexp(ARGENT_RULES_START)}[\\s\\S]*?${escapeStringRegexp(ARGENT_RULES_END)}`
  );
  if (re.test(existing)) return existing.replace(re, section);
  // Append after user content
  return `${existing}\n\n${section}`;
}

function removeArgentSection(existing: string): string {
  const re = new RegExp(
    `\\n*${escapeStringRegexp(ARGENT_RULES_START)}[\\s\\S]*?${escapeStringRegexp(ARGENT_RULES_END)}\\n*`
  );
  return existing.replace(re, "").trim();
}

export function injectCodexRules(configPath: string, rulesDir: string): string | null {
  const rules = readAndConcatRules(rulesDir);
  if (!rules) return null;
  const config = readToml(configPath);
  const existing = config.developer_instructions as string | undefined;
  config.developer_instructions = injectArgentSection(existing, rules);
  writeToml(configPath, config);
  return configPath;
}

export function removeCodexRules(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  const config = readToml(configPath);
  const existing = config.developer_instructions as string | undefined;
  if (!existing || !existing.includes(ARGENT_RULES_START)) return false;
  const cleaned = removeArgentSection(existing);
  if (cleaned) {
    config.developer_instructions = cleaned;
  } else {
    delete config.developer_instructions;
  }
  writeTomlOrRemove(configPath, config);
  return true;
}

// ── Copy orchestrator ────────────────────────────────────────────────────────
// MARK: Copy orchestrator

export function copyRulesAndAgents(
  adapters: McpConfigAdapter[],
  root: string,
  scope: ManagedContentScope,
  rulesDir: string,
  agentsDir: string
): string[] {
  const results: string[] = [];
  const managedTargets = getManagedContentTargets(adapters, root, scope);

  for (const target of managedTargets.ruleTargets) {
    try {
      if (fs.existsSync(rulesDir)) {
        fs.mkdirSync(target.targetPath, { recursive: true });
        fs.cpSync(rulesDir, target.targetPath, { recursive: true });
        results.push(`  Copied rules to ${target.targetPath}`);
      }
    } catch (err) {
      results.push(`  Could not copy rules to ${target.targetPath}: ${err}`);
    }
  }

  for (const target of managedTargets.agentTargets) {
    try {
      if (fs.existsSync(agentsDir)) {
        fs.mkdirSync(target.targetPath, { recursive: true });
        fs.cpSync(agentsDir, target.targetPath, { recursive: true });
        results.push(`  Copied agents to ${target.targetPath}`);
      }
    } catch (err) {
      results.push(`  Could not copy agents to ${target.targetPath}: ${err}`);
    }
  }

  // Codex: inject rules into developer_instructions in config.toml
  for (const target of managedTargets.codexConfigTargets) {
    try {
      const injected = injectCodexRules(target.targetPath, rulesDir);
      if (injected) {
        results.push(`  Injected rules into ${target.targetPath} (developer_instructions)`);
      }
    } catch (err) {
      results.push(`  Could not inject rules into ${target.targetPath}: ${err}`);
    }
  }

  return results;
}
