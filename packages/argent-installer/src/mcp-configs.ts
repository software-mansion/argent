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
  copyDir,
  realpathOrSelf,
  editJsoncFile,
  isYarnPnp,
  getLocalArgentBinRelPath,
  RULES_DIR,
  AGENTS_DIR,
  ARGENT_SKILL_PREFIX,
} from "./utils.js";
import { isMap, parse as parseYamlText } from "yaml";
import { parse as parseJsoncText, type ParseError } from "jsonc-parser";
import { parse as parseTomlText } from "smol-toml";
import escapeStringRegexp from "escape-string-regexp";

const TOOL_SERVER_BUNDLE = path.join(import.meta.dirname, "tool-server.cjs");

function getAvailableToolIds(): string[] {
  const out = execFileSync("node", [TOOL_SERVER_BUNDLE, "-t"], { encoding: "utf8" });
  const tools = JSON.parse(out) as Array<{ id: string }>;
  return tools.map((t) => t.id);
}

// MARK: Types

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// Argent config or client state outside the scope init just wrote that can keep
// that entry from taking effect. Adapters only report; init-stale-config.ts
// decides removal vs. warning.
export interface ShadowingConfigFinding {
  /** Human-readable location, e.g. `~/.claude.json (project-local scope)`. */
  location: string;
  /** One-line consequence for the user, e.g. `takes precedence over .mcp.json`. */
  reason: string;
  /** The conflicting entry when parseable; null for non-entry state (a block list). */
  entry: McpServerEntry | null;
  /**
   * True when removal needs no further policy checks. When false,
   * init-stale-config.ts removes the finding only if provably dead, else warns.
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
  // Lets `update` skip adapters/scopes the user never opted into during `init`,
  // instead of re-creating configs for any editor whose dir happens to exist
  // (issue #195). Implementations must read the same key `remove()` checks.
  hasArgentEntry(configPath: string): boolean;
  // Normalized argent entry, or null when absent. A present-but-unrecognizable
  // entry comes back as { command: "", args: [] } so callers can tell "absent"
  // from "unreadable" (hasArgentEntry must stay true for it).
  getArgentEntry(configPath: string): McpServerEntry | null;
  // Report argent state outside the projectPath/globalPath pair that can keep
  // the entry written at `writtenScope` from taking effect.
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

// How the MCP entry locates the argent executable. local-npx is the fallback for
// when the bin path is unverifiable; `--no-install` keeps it from silently
// network-installing, and never a bare `npx -y`, which can hang a TTY-less
// stdio server.
export type McpCommandMode =
  | { kind: "global" }
  | { kind: "local-node"; binRelPath: string }
  | { kind: "local-pnp" }
  | { kind: "local-npx" };

function buildMcpEntry(mode: McpCommandMode = { kind: "global" }): McpServerEntry {
  // No env vars: the server falls back to `${homedir()}/.argent/mcp-calls.log`
  // when ARGENT_MCP_LOG is unset, so a committed config stays portable (#238).
  switch (mode.kind) {
    case "local-node":
      // `node` rather than the .bin/argent shim, which on Windows is a .cmd
      // that needs a shell.
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

export function resolveLocalCommandMode(root: string): McpCommandMode {
  if (isYarnPnp(root)) return { kind: "local-pnp" };
  const binRelPath = getLocalArgentBinRelPath(root);
  if (binRelPath) return { kind: "local-node", binRelPath };
  return { kind: "local-npx" };
}

// Shared by `init` and `update`: only a local-mode PROJECT-scope entry runs the
// repo-local copy; everything else keeps the bare `argent` command.
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

// Env keys argent itself used to write (dropped by #238). An entry whose env
// holds nothing else is still argent-authored — classification must not read it
// as a user customization, or those legacy entries would never be repaired to
// the clean env-less shape.
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

// Collapses the `mcp_servers` table the Codex remover just emptied, so a config
// that held only argent reduces to {} and writeTomlOrRemove can delete the file.
// Only this key is touched: empty values elsewhere are the user's ("only touch
// argent"). The JSON adapters get the same ancestor collapse from editJsoncFile.
function deleteIfEmpty(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (isRecord(value) && Object.keys(value).length === 0) {
    delete parent[key];
  }
}

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

// A shape argent itself writes; anything else is a customization that
// refresh/cleanup flows must not rewrite or remove. The node form accepts any
// RELATIVE path into a node_modules copy of the package (everything
// getLocalArgentBinRelPath can emit); absolute or out-of-tree is hand-tuned.
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

// Deliberately does NOT recursively prune empty tables/arrays, so a foreign TOML
// server's `args = []` survives ("only touch argent"); callers collapse their own
// emptied argent container via deleteIfEmpty first, so "held only argent" still
// deletes the file. TOML has no comment-preserving editor, hence this
// parse → mutate → stringify writer instead of editJsoncFile.
function writeTomlOrRemove(filePath: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
    return;
  }

  writeToml(filePath, data);
}

// A bare editor config directory (`.cursor`, `.claude`, `.vscode`, …) is NOT
// proof the editor is installed: argent creates those itself when it writes an
// MCP config, an allowlist, rules, agents or skills, so counting them made every
// later `init` "detect" editors the user never installed. A directory is
// evidence only when it holds something argent doesn't write, or an
// argent-writable file carries non-argent content; anything empty, unreadable or
// unparseable counts as evidence too (when unsure, detect).
//
// Every detect() that probes a path argent itself creates must route through
// this check — an asymmetric subset just moves the self-fulfilling detection to
// the unchecked editors.

function dirHasEditorEvidence(dir: string, looksArgentOnly: (dir: string) => boolean): boolean {
  return dirExists(dir) && !looksArgentOnly(dir);
}

function fileHasEditorEvidence(
  filePath: string,
  looksArgentOnly: (filePath: string) => boolean
): boolean {
  return fs.existsSync(filePath) && !looksArgentOnly(filePath);
}

// Strict parses for the evidence check: the shared readJsonc/readToml return {}
// on a read/parse error, which here would classify a corrupt USER config as
// argent-only. null = unreadable; callers treat that as user evidence.
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

function parseYamlStrict(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = parseYamlText(fs.readFileSync(filePath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The document argent's write() leaves in a config file it created itself.
// remove() prunes empty parents and deletes the emptied file, so any other
// shape — extra top-level keys, foreign servers, an empty document — is the
// user's.
function jsonLooksArgentServerOnly(filePath: string, containerKey: string): boolean {
  const config = parseJsoncStrict(filePath);
  if (config === null) return false;
  const keys = Object.keys(config);
  if (keys.length !== 1 || keys[0] !== containerKey) return false;
  const servers = (config[containerKey] ?? {}) as Record<string, unknown>;
  const serverKeys = Object.keys(servers);
  return serverKeys.length === 1 && serverKeys[0] === MCP_SERVER_KEY;
}

// rules/ and agents/ are byte copies of the bundled payloads, so argent-written
// means every entry matches a bundled name exactly (a user's own
// "argent-notes.md" must NOT pass); skills/ come from the skills CLI, where
// argent owns the ARGENT_SKILL_PREFIX namespace. An empty dir is user evidence:
// argent's copies always carry content.
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
      return jsonLooksArgentServerOnly(full, "mcpServers");
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

// .claude/settings.json as argent's addClaudePermission leaves it in a file
// it created: only permissions.allow, holding only argent's own rule.
function claudeSettingsLooksArgentOnly(filePath: string): boolean {
  const config = parseJsoncStrict(filePath);
  if (config === null) return false;
  const keys = Object.keys(config);
  if (keys.length !== 1 || keys[0] !== "permissions") return false;
  const permissions = config.permissions;
  if (!isRecord(permissions)) return false;
  const permKeys = Object.keys(permissions);
  if (permKeys.length !== 1 || permKeys[0] !== "allow") return false;
  const allow = permissions.allow;
  return (
    Array.isArray(allow) && allow.length > 0 && allow.every((rule) => rule === PERMISSION_RULE)
  );
}

function claudeDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const full = path.join(dir, entry);
    if (entry === "settings.json") return claudeSettingsLooksArgentOnly(full);
    if (entry === "rules" || entry === "agents" || entry === "skills") {
      return managedDirLooksArgentOnly(full, entry);
    }
    return false;
  });
}

// .vscode holds a single argent artifact: mcp.json. Anything else in the dir is
// the user's workspace.
function vscodeDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every(
    (entry) => entry === "mcp.json" && jsonLooksArgentServerOnly(path.join(dir, entry), "servers")
  );
}

// ~/.codeium/windsurf holds a single argent artifact: mcp_config.json (the
// alwaysAllow toggle lives inside the argent entry).
function windsurfDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every(
    (entry) =>
      entry === "mcp_config.json" && jsonLooksArgentServerOnly(path.join(dir, entry), "mcpServers")
  );
}

// ~/.config/zed/settings.json as argent leaves it in a file it created:
// context_servers.argent plus the allowlist toggle, which is the one argent
// write that lands OUTSIDE the server entry (agent.tool_permissions.default —
// "allow" from addAllowlist, or "confirm" after removeAllowlist resets it).
function zedSettingsLooksArgentOnly(filePath: string): boolean {
  const config = parseJsoncStrict(filePath);
  if (config === null) return false;
  const keys = Object.keys(config);
  if (keys.length === 0) return false;
  return keys.every((key) => {
    if (key === "context_servers") {
      const servers = config.context_servers;
      if (!isRecord(servers)) return false;
      const serverKeys = Object.keys(servers);
      return serverKeys.length === 1 && serverKeys[0] === MCP_SERVER_KEY;
    }
    if (key === "agent") {
      const agent = config.agent;
      if (!isRecord(agent)) return false;
      const agentKeys = Object.keys(agent);
      if (agentKeys.length !== 1 || agentKeys[0] !== "tool_permissions") return false;
      const perms = agent.tool_permissions;
      if (!isRecord(perms)) return false;
      const permKeys = Object.keys(perms);
      return (
        permKeys.length === 1 &&
        permKeys[0] === "default" &&
        (perms.default === "allow" || perms.default === "confirm")
      );
    }
    return false;
  });
}

function zedDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every(
    (entry) => entry === "settings.json" && zedSettingsLooksArgentOnly(path.join(dir, entry))
  );
}

function geminiDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const full = path.join(dir, entry);
    // The trust:true toggle lives inside the argent entry.
    if (entry === "settings.json") return jsonLooksArgentServerOnly(full, "mcpServers");
    if (entry === "rules" || entry === "agents") return managedDirLooksArgentOnly(full, entry);
    return false;
  });
}

// ~/.hermes holds a single argent artifact: config.yaml with only
// mcp_servers.argent.
function hermesConfigLooksArgentOnly(filePath: string): boolean {
  const config = parseYamlStrict(filePath);
  if (config === null) return false;
  const keys = Object.keys(config);
  if (keys.length !== 1 || keys[0] !== "mcp_servers") return false;
  const servers = config.mcp_servers;
  if (!isRecord(servers)) return false;
  const serverKeys = Object.keys(servers);
  return serverKeys.length === 1 && serverKeys[0] === MCP_SERVER_KEY;
}

function hermesDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every(
    (entry) => entry === "config.yaml" && hermesConfigLooksArgentOnly(path.join(dir, entry))
  );
}

// .kiro holds a single argent artifact: settings/mcp.json (autoApprove lives
// inside the argent entry).
function kiroDirLooksArgentOnly(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    if (entry !== "settings") return false;
    const settingsDir = path.join(dir, entry);
    let settingsEntries: string[];
    try {
      settingsEntries = fs.readdirSync(settingsDir);
    } catch {
      return false;
    }
    if (settingsEntries.length === 0) return false;
    return settingsEntries.every(
      (name) =>
        name === "mcp.json" && jsonLooksArgentServerOnly(path.join(settingsDir, name), "mcpServers")
    );
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

// MARK: Cursor

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

  // Read and written as JSONC through readJsonc / editJsoncFile: path-targeted
  // text edits that preserve user comments and foreign servers.
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

  // The allowlist lives in a separate ~/.cursor/permissions.json that may carry
  // the user's own rules, so edit that one key instead of rewriting the file.
  addAllowlist(): void {
    const permPath = path.join(homedir(), ".cursor", "permissions.json");
    const config = readJsonc(permPath);
    const list = Array.isArray(config.mcpAllowlist) ? (config.mcpAllowlist as string[]) : [];
    if (list.includes(CURSOR_ALLOWLIST_PATTERN)) return;
    editJsoncFile(permPath, ["mcpAllowlist"], [...list, CURSOR_ALLOWLIST_PATTERN]);
  },

  removeAllowlist(_root: string, scope: "local" | "global"): void {
    // The allowlist lives ONLY in the machine-global permissions file, which a
    // retained global install still depends on.
    if (scope !== "global") return;
    const permPath = path.join(homedir(), ".cursor", "permissions.json");
    if (!fs.existsSync(permPath)) return;
    const config = readJsonc(permPath);
    const list = Array.isArray(config.mcpAllowlist) ? (config.mcpAllowlist as string[]) : undefined;
    if (!list || !list.includes(CURSOR_ALLOWLIST_PATTERN)) return;
    const next = list.filter((rule) => rule !== CURSOR_ALLOWLIST_PATTERN);
    // undefined deletes the emptied key; editJsoncFile prunes it and removes the
    // file if the document collapses to {}.
    editJsoncFile(permPath, ["mcpAllowlist"], next.length > 0 ? next : undefined);
  },
};

// MARK: Claude

// ~/.claude.json keys its per-project entries by absolute path, so match
// loosely: realpathSync.native canonicalizes symlinks and, on case-insensitive
// filesystems, on-disk case.
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

// A recorded "reject" for the argent .mcp.json server: a rejection made before
// this init can keep the fresh project-scope entry from loading.
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
    // Removing a PROJECT-confined rejection only re-enables the approval prompt
    // — running `argent init` is that consent. The user-global list reaches
    // every project on the machine, so it is never auto-removed.
    autoRemove: projectConfined,
    remove: (): boolean => {
      const config = readJson(settingsPath);
      const list = config.disabledMcpjsonServers;
      if (!Array.isArray(list)) return false;
      const idx = list.indexOf(MCP_SERVER_KEY);
      if (idx === -1) return false;
      list.splice(idx, 1);
      if (list.length === 0) delete config.disabledMcpjsonServers;
      // settings.json is the USER'S file: dropping one list entry must never
      // prune other empty structures or delete the file.
      writeJson(settingsPath, config);
      return true;
    },
  };
}

const claudeAdapter: McpConfigAdapter = {
  name: "Claude Code",

  detect(): boolean {
    // .mcp.json and the .claude dirs are argent-created (MCP entry;
    // permissions/rules/agents/skills), so all of these go through the evidence
    // check.
    const mcpJsonArgentOnly = (p: string): boolean => jsonLooksArgentServerOnly(p, "mcpServers");
    return (
      fileHasEditorEvidence(path.join(process.cwd(), ".mcp.json"), mcpJsonArgentOnly) ||
      fileHasEditorEvidence(path.join(homedir(), ".claude.json"), mcpJsonArgentOnly) ||
      dirHasEditorEvidence(path.join(process.cwd(), ".claude"), claudeDirLooksArgentOnly) ||
      dirHasEditorEvidence(path.join(homedir(), ".claude"), claudeDirLooksArgentOnly)
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".mcp.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".claude.json");
  },

  // JSONC is a superset of JSON, so this config shares the one comment- and
  // foreign-server-preserving write path (see the Cursor adapter).
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
      // ~/.claude.json holds unrelated user state, so never delete or deep-prune
      // it: drop only our key and write the rest back verbatim, out of reach of
      // editJsoncFile's collapse-to-{} deletion. readJsonc above keeps a stray
      // comment from flattening the whole file to {}.
      delete servers[MCP_SERVER_KEY];
      if (Object.keys(servers).length === 0) delete config.mcpServers;
      writeJson(configPath, config);
    } else {
      // Preserve comments and foreign servers; delete the file only if argent
      // was all it held.
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

  // Scans the scope outside the projectPath/globalPath pair —
  // projects["<abs path>"].mcpServers in ~/.claude.json — plus recorded
  // .mcp.json rejections (see claudeDisabledListFinding).
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
        // bare `argent mcp`, no env. Anything else may be a deliberate override
        // — report it, never delete silently (`argent update --yes` runs this
        // sweep too).
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
            // Re-read and bail unless the entry is still there: readJson yields
            // {} on a parse failure, and writing that back would destroy
            // unrelated user state.
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

// MARK: VSCode

const vscodeAdapter: McpConfigAdapter = {
  name: "VS Code",

  detect(): boolean {
    // The project .vscode dir is argent-created (mcp.json) → evidence check.
    // ~/.vscode is never written by argent, so its bare existence stays valid
    // evidence.
    return (
      dirHasEditorEvidence(path.join(process.cwd(), ".vscode"), vscodeDirLooksArgentOnly) ||
      dirExists(path.join(homedir(), ".vscode"))
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".vscode", "mcp.json");
  },

  globalPath(): string | null {
    return null;
  },

  // Read and written as JSONC through readJsonc / editJsoncFile so user comments
  // and foreign servers survive (see the Cursor adapter).
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

  // The user-profile mcp.json is a scope the projectPath/globalPath pair doesn't
  // cover. Report it; the shared policy removes it only when provably dead.
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

// MARK: Windsurf

const windsurfAdapter: McpConfigAdapter = {
  name: "Windsurf",

  detect(): boolean {
    return dirHasEditorEvidence(
      path.join(homedir(), ".codeium", "windsurf"),
      windsurfDirLooksArgentOnly
    );
  },

  projectPath(): string | null {
    return null;
  },

  globalPath(): string | null {
    return path.join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  },

  // JSONC-safe writes (see the Cursor adapter).
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

  // Targets just the argent entry's alwaysAllow key, so comments and foreign
  // servers survive.
  addAllowlist(): void {
    const configPath = path.join(homedir(), ".codeium", "windsurf", "mcp_config.json");
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return;
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY, "alwaysAllow"], ["*"]);
  },

  removeAllowlist(_root: string, scope: "local" | "global"): void {
    // Global-only client: a scope-"local" cleanup must not touch the
    // machine-global config a retained global install depends on.
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

// MARK: Zed

const zedAdapter: McpConfigAdapter = {
  name: "Zed",

  detect(): boolean {
    return dirHasEditorEvidence(path.join(homedir(), ".config", "zed"), zedDirLooksArgentOnly);
  },

  projectPath(root: string): string | null {
    return path.join(root, ".zed", "settings.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".config", "zed", "settings.json");
  },

  // Read and written as JSONC through readJsonc / editJsoncFile so comments and
  // formatting outside the touched key survive (see the Cursor adapter).
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
    // JSONC-tolerant read: a comment JSON.parse rejects is swallowed by
    // readJson, which would leave this branch thinking nothing needed removing.
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

  // Zed has no server-level wildcard for MCP tools — each tool would need its
  // own entry — so the global default is set to "allow" instead.
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

// MARK: Gemini

const geminiAdapter: McpConfigAdapter = {
  name: "Gemini",

  detect(): boolean {
    return (
      dirHasEditorEvidence(path.join(homedir(), ".gemini"), geminiDirLooksArgentOnly) ||
      dirHasEditorEvidence(path.join(process.cwd(), ".gemini"), geminiDirLooksArgentOnly)
    );
  },

  projectPath(root: string): string {
    return path.join(root, ".gemini", "settings.json");
  },

  globalPath(): string {
    return path.join(homedir(), ".gemini", "settings.json");
  },

  // JSONC-safe writes (see the Cursor adapter).
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

  // Targets just the argent entry's trust key, so comments and foreign servers
  // survive.
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

// MARK: Codex

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

// Uses the yaml Document API instead of a POJO round-trip so user comments and
// formatting survive every write. Refuses to touch the file if mcp_servers
// exists but is not a YAML mapping, which would otherwise be clobbered.

const hermesAdapter: McpConfigAdapter = {
  name: "Hermes",

  detect(): boolean {
    return dirHasEditorEvidence(path.join(homedir(), ".hermes"), hermesDirLooksArgentOnly);
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

// MARK: opencode

// Unlike every other adapter, opencode's config file is optional, so detection
// probes for the `opencode` binary on PATH rather than a config directory.

const OPENCODE_BINARY = "opencode";
const OPENCODE_ALLOWLIST_PATTERN = "argent*";

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

// MARK: Kiro
//
// One .kiro/settings/mcp.json serves both the Kiro IDE and the Kiro CLI.
// `autoApprove` is IDE syntax; the CLI's server config has no such field and
// does not reject unknown ones, so the key is honored by the IDE and ignored by
// the CLI, which carries its own trust model (checked against kiro-cli 2.9.0).

const KIRO_AUTO_APPROVE_ALL = ["*"];

const kiroAdapter: McpConfigAdapter = {
  name: "Kiro",

  detect(): boolean {
    return (
      dirHasEditorEvidence(path.join(homedir(), ".kiro"), kiroDirLooksArgentOnly) ||
      dirHasEditorEvidence(path.join(process.cwd(), ".kiro"), kiroDirLooksArgentOnly)
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".kiro", "settings", "mcp.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".kiro", "settings", "mcp.json");
  },

  // Read and written as JSONC through readJsonc / editJsoncFile so comments and
  // foreign servers survive (see the Cursor adapter).
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

  // Targets just the argent entry's autoApprove key, so comments and foreign
  // servers survive.
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

// Where argent is already configured. `update` uses this to skip editors the
// user opted out of during `init` even when their config dir happens to exist
// (issue #195). A probe that throws on a malformed file (e.g. Hermes' readYaml)
// counts as "not configured" rather than aborting the whole update.
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

export function addClaudePermission(root: string, scope: "local" | "global"): void {
  const settingsPath =
    scope === "global"
      ? path.join(homedir(), ".claude", "settings.json")
      : path.join(root, ".claude", "settings.json");

  // Route through readJsonc / editJsoncFile so a hand-added comment can't make
  // readJson's `catch { return {} }` drop the user's other permissions on write.
  // editJsoncFile creates the permissions.allow path if absent.
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
  // `permissions` and removes the file if the document collapses to {}, while a
  // comment or foreign permission keeps the file and survives byte-intact.
  editJsoncFile(settingsPath, ["permissions", "allow"], next.length > 0 ? next : undefined);
}

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

// A symlinked target is written through rather than replaced (see copyDir), so
// files can land somewhere other than the configured path. Naming both keeps
// that redirect auditable instead of silent, in the shortened form the rest of
// the managed-content output uses.
function formatCopyDestination(
  target: ManagedContentTarget,
  writtenPath: string,
  root: string
): string {
  if (writtenPath === target.targetPath) return target.label;
  // The written path came back from realpath, so shorten it against the same:
  // a workspace reached through a link (macOS /var, a symlinked home) would
  // otherwise never look relative to its own root.
  return `${target.label} -> ${formatManagedPathLabel(writtenPath, realpathOrSelf(root))}`;
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
        // opencode's config sits at the project root, but its skills/agents
        // live under .opencode/; globally both live under ~/.config/opencode/.
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

// Rule content is injected into config.toml's `developer_instructions`,
// delimited by markers so update/remove never touch user content.

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
  const re = new RegExp(
    `${escapeStringRegexp(ARGENT_RULES_START)}[\\s\\S]*?${escapeStringRegexp(ARGENT_RULES_END)}`
  );
  if (re.test(existing)) return existing.replace(re, section);
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
      const written = copyDir(rulesDir, target.targetPath);
      if (written) {
        results.push(`  Copied rules to ${formatCopyDestination(target, written, root)}`);
      }
    } catch (err) {
      results.push(`  Could not copy rules to ${target.targetPath}: ${err}`);
    }
  }

  for (const target of managedTargets.agentTargets) {
    try {
      const written = copyDir(agentsDir, target.targetPath);
      if (written) {
        results.push(`  Copied agents to ${formatCopyDestination(target, written, root)}`);
      }
    } catch (err) {
      results.push(`  Could not copy agents to ${target.targetPath}: ${err}`);
    }
  }

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
