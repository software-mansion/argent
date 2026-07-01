import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import {
  MCP_SERVER_KEY,
  MCP_BINARY_NAME,
  PERMISSION_RULE,
  CURSOR_ALLOWLIST_PATTERN,
} from "./constants.js";
import {
  readJson,
  readJsonc,
  writeJson,
  dirExists,
  readToml,
  writeToml,
  readYaml,
  writeYaml,
  editJsoncFile,
} from "./utils.js";
import { isMap } from "yaml";
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

function buildMcpEntry(): McpServerEntry {
  // No env vars by default: the MCP server falls back to
  // `${homedir()}/.argent/mcp-calls.log` when ARGENT_MCP_LOG is unset, so we
  // keep this generated config portable — see issue #238.
  return {
    command: MCP_BINARY_NAME,
    args: ["mcp"],
  };
}

export function getMcpEntry(): McpServerEntry {
  return buildMcpEntry();
}

function hasEnv(entry: McpServerEntry): entry is McpServerEntry & { env: Record<string, string> } {
  return entry.env != null && Object.keys(entry.env).length > 0;
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

// After a remover deletes the argent entry, collapse the now-empty container it
// lived in (e.g. an emptied `mcpServers`) so a config that held only argent
// reduces to {} and writeJsonOrRemove can delete the file. Only this one key is
// touched — foreign sibling keys and empty values elsewhere in the tree are
// preserved byte-for-byte (the contract is "only touch argent").
function deleteIfEmpty(parent: Record<string, unknown>, key: string): void {
  const value = parent[key];
  if (
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  ) {
    delete parent[key];
  }
}

// Writes `data` unchanged, except: when it has no own keys the file (and an
// empty parent directory) is removed instead. This deliberately does NOT
// recursively prune empty objects/arrays — the previous deep-prune silently
// stripped foreign servers' `args: []` / `env: {}` and deleted any user key
// holding an empty object/array, violating the "only touch argent" contract.
// Removers collapse their own emptied argent container via deleteIfEmpty before
// calling here, so "config held only argent" still results in file deletion.
function writeJsonOrRemove(filePath: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
    return;
  }

  writeJson(filePath, data);
}

// Writes `data` unchanged, except: when it has no own keys the file (and an
// empty parent directory) is removed instead. Mirrors writeJsonOrRemove (see
// its comment above) — this deliberately does NOT recursively prune empty
// tables/arrays, so a foreign TOML server's `args = []` and any sibling empty
// value survive. Callers collapse their own emptied argent container via
// deleteIfEmpty before calling here.
function writeTomlOrRemove(filePath: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
    return;
  }

  writeToml(filePath, data);
}

// ── Cursor adapter ────────────────────────────────────────────────────────────
// MARK: Cursor
// Format: { mcpServers: { argent: { command, args, env } } }

const cursorAdapter: McpConfigAdapter = {
  name: "Cursor",

  detect(): boolean {
    return (
      dirExists(path.join(homedir(), ".cursor")) || dirExists(path.join(process.cwd(), ".cursor"))
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
  },

  addAllowlist(): void {
    const permPath = path.join(homedir(), ".cursor", "permissions.json");
    const config = readJson(permPath);
    const list = (config.mcpAllowlist ?? []) as string[];
    if (!list.includes(CURSOR_ALLOWLIST_PATTERN)) {
      list.push(CURSOR_ALLOWLIST_PATTERN);
      config.mcpAllowlist = list;
      writeJson(permPath, config);
    }
  },

  removeAllowlist(): void {
    const permPath = path.join(homedir(), ".cursor", "permissions.json");
    if (!fs.existsSync(permPath)) return;
    const config = readJson(permPath);
    const list = config.mcpAllowlist as string[] | undefined;
    if (!Array.isArray(list)) return;
    const idx = list.indexOf(CURSOR_ALLOWLIST_PATTERN);
    if (idx === -1) return;
    list.splice(idx, 1);
    config.mcpAllowlist = list;
    deleteIfEmpty(config, "mcpAllowlist");
    writeJsonOrRemove(permPath, config);
  },
};

// ── Claude Code adapter ───────────────────────────────────────────────────────
// MARK: Claude
// Format: { mcpServers: { argent: { type: "stdio", command, args, env } } }
// Project: .mcp.json   Global: ~/.claude.json
// Also manages permissions in .claude/settings.json

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
    editJsoncFile(configPath, ["mcpServers", MCP_SERVER_KEY], undefined);
    return true;
  },

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.servers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
  },
};

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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
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

  removeAllowlist(): void {
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.context_servers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
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
      dirExists(path.join(homedir(), CODEX_FILENAME)) ||
      dirExists(path.join(process.cwd(), CODEX_FILENAME))
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readToml(configPath);
    const servers = config.mcp_servers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const doc = readYaml(configPath);
    const servers = doc.get("mcp_servers");
    if (!isMap(servers)) return false;
    return servers.has(MCP_SERVER_KEY);
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcp as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
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

  hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJsonc(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    return Boolean(servers?.[MCP_SERVER_KEY]);
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

  const config = readJson(settingsPath);
  const permissions = (config.permissions ?? {}) as Record<string, unknown>;
  const allow = (permissions.allow ?? []) as string[];
  if (!allow.includes(PERMISSION_RULE)) {
    allow.push(PERMISSION_RULE);
    permissions.allow = allow;
    config.permissions = permissions;
    writeJson(settingsPath, config);
  }
}

export function removeClaudePermission(root: string, scope: "local" | "global"): void {
  const settingsPath =
    scope === "global"
      ? path.join(homedir(), ".claude", "settings.json")
      : path.join(root, ".claude", "settings.json");

  if (!fs.existsSync(settingsPath)) return;
  const config = readJson(settingsPath);
  const permissions = config?.permissions as Record<string, unknown> | undefined;
  const allow = permissions?.allow as string[] | undefined;
  if (!permissions || !Array.isArray(allow)) return;
  const idx = allow.indexOf(PERMISSION_RULE);
  if (idx === -1) return;
  allow.splice(idx, 1);
  deleteIfEmpty(permissions, "allow");
  deleteIfEmpty(config, "permissions");
  writeJsonOrRemove(settingsPath, config);
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
