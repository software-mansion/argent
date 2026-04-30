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
  writeJson,
  dirExists,
  readToml,
  writeToml,
  readYaml,
  writeYaml,
} from "./utils.js";
import { isMap } from "yaml";

// `installer.mjs` and `tool-server.cjs` are bundled side-by-side into the
// published package's `dist/` directory by scripts/bundle-tools.cjs.
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
  env: Record<string, string>;
}

export interface McpConfigAdapter {
  name: string;
  detect(): boolean;
  projectPath(root: string): string | null;
  globalPath(): string | null;
  write(configPath: string, entry: McpServerEntry): void;
  remove(configPath: string): boolean;
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
  const logFile = path.join(homedir(), ".argent", "mcp-calls.log");
  return {
    command: MCP_BINARY_NAME,
    args: ["mcp"],
    env: { ARGENT_MCP_LOG: logFile },
  };
}

export function getMcpEntry(): McpServerEntry {
  return buildMcpEntry();
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

function pruneEmptyConfig(value: unknown): unknown | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 ? value : undefined;
  }

  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const next = pruneEmptyConfig(entry);
      if (next !== undefined) cleaned[key] = next;
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeJsonOrRemove(filePath: string, data: Record<string, unknown>): void {
  const cleaned = pruneEmptyConfig(data);
  if (!isRecord(cleaned)) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
    return;
  }

  writeJson(filePath, cleaned);
}

function writeTomlOrRemove(filePath: string, data: Record<string, unknown>): void {
  const cleaned = pruneEmptyConfig(data);
  if (!isRecord(cleaned)) {
    fs.rmSync(filePath, { force: true });
    removeDirIfEmpty(path.dirname(filePath));
    return;
  }

  writeToml(filePath, cleaned);
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

  write(configPath: string, entry: McpServerEntry): void {
    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
    config.mcpServers = servers;
    writeJson(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJson(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJsonOrRemove(configPath, config);
    return true;
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

  write(configPath: string, entry: McpServerEntry): void {
    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      type: "stdio",
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
    config.mcpServers = servers;
    writeJson(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJson(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJsonOrRemove(configPath, config);
    return true;
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

  write(configPath: string, entry: McpServerEntry): void {
    const config = readJson(configPath);
    const servers = (config.servers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      type: "stdio",
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
    config.servers = servers;
    writeJson(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJson(configPath);
    const servers = config.servers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJsonOrRemove(configPath, config);
    return true;
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

  write(configPath: string, entry: McpServerEntry): void {
    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
    config.mcpServers = servers;
    writeJson(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJson(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJsonOrRemove(configPath, config);
    return true;
  },

  addAllowlist(): void {
    const configPath = path.join(homedir(), ".codeium", "windsurf", "mcp_config.json");
    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const entry = servers[MCP_SERVER_KEY];
    if (!entry) return;
    entry.alwaysAllow = ["*"];
    writeJson(configPath, config);
  },

  removeAllowlist(): void {
    const configPath = path.join(homedir(), ".codeium", "windsurf", "mcp_config.json");
    if (!fs.existsSync(configPath)) return;
    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const entry = servers[MCP_SERVER_KEY];
    if (!entry?.alwaysAllow) return;
    delete entry.alwaysAllow;
    writeJsonOrRemove(configPath, config);
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

  write(configPath: string, entry: McpServerEntry): void {
    const config = readJson(configPath);
    const servers = (config.context_servers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      source: "custom",
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
    config.context_servers = servers;
    writeJson(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJson(configPath);
    const servers = config.context_servers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJsonOrRemove(configPath, config);
    return true;
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
    const config = readJson(settingsPath);
    const agent = (config.agent ?? {}) as Record<string, unknown>;
    const perms = (agent.tool_permissions ?? {}) as Record<string, unknown>;
    perms.default = "allow";
    agent.tool_permissions = perms;
    config.agent = agent;
    writeJson(settingsPath, config);
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const settingsPath =
      scope === "global"
        ? path.join(homedir(), ".config", "zed", "settings.json")
        : path.join(root, ".zed", "settings.json");
    if (!fs.existsSync(settingsPath)) return;
    const config = readJson(settingsPath);
    const perms = (config.agent as Record<string, unknown>)?.tool_permissions as
      | Record<string, unknown>
      | undefined;
    if (!perms || perms.default !== "allow") return;
    perms.default = "confirm";
    writeJsonOrRemove(settingsPath, config);
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

  write(configPath: string, entry: McpServerEntry): void {
    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
    config.mcpServers = servers;
    writeJson(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJson(configPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJsonOrRemove(configPath, config);
    return true;
  },

  addAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);

    if (!configPath) {
      return;
    }

    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const entry = servers[MCP_SERVER_KEY];
    if (!entry) return;
    entry.trust = true;
    writeJson(configPath, config);
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);

    if (!configPath || !fs.existsSync(configPath)) {
      return;
    }

    const config = readJson(configPath);
    const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
    const entry = servers?.[MCP_SERVER_KEY];
    if (!entry?.trust) return;
    delete entry.trust;
    writeJsonOrRemove(configPath, config);
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
      env: entry.env,
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
    writeTomlOrRemove(configPath, config);
    return true;
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
      env: entry.env,
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

function hasOpenCodeBinary(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFileSync(cmd, [OPENCODE_BINARY], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const openCodeAdapter: McpConfigAdapter = {
  name: "opencode",

  detect(): boolean {
    return hasOpenCodeBinary();
  },

  projectPath(root: string): string | null {
    return path.join(root, "opencode.json");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".config", "opencode", "opencode.json");
  },

  write(configPath: string, entry: McpServerEntry): void {
    const config = readJson(configPath);
    const servers = (config.mcp ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_KEY] = {
      type: "local",
      command: [entry.command, ...entry.args],
      enabled: true,
      environment: entry.env,
    };
    config.mcp = servers;
    writeJson(configPath, config);
  },

  remove(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const config = readJson(configPath);
    const servers = config.mcp as Record<string, unknown> | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJsonOrRemove(configPath, config);
    return true;
  },

  addAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);
    if (!configPath) return;
    const config = readJson(configPath);
    const tools = (config.tools ?? {}) as Record<string, unknown>;
    tools[OPENCODE_ALLOWLIST_PATTERN] = true;
    config.tools = tools;
    writeJson(configPath, config);
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const configPath = scope === "global" ? this.globalPath() : this.projectPath(root);
    if (!configPath || !fs.existsSync(configPath)) return;
    const config = readJson(configPath);
    const tools = config.tools as Record<string, unknown> | undefined;
    if (!tools || !(OPENCODE_ALLOWLIST_PATTERN in tools)) return;
    delete tools[OPENCODE_ALLOWLIST_PATTERN];
    writeJsonOrRemove(configPath, config);
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
];

export function detectAdapters(): McpConfigAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.detect());
}

export function getAdapterByName(name: string): McpConfigAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.name.toLowerCase() === name.toLowerCase());
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
  const allow = (config?.permissions as Record<string, unknown>)?.allow as string[];
  if (!Array.isArray(allow)) return;
  const idx = allow.indexOf(PERMISSION_RULE);
  if (idx === -1) return;
  allow.splice(idx, 1);
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
    `${escapeRegExp(ARGENT_RULES_START)}[\\s\\S]*?${escapeRegExp(ARGENT_RULES_END)}`
  );
  if (re.test(existing)) return existing.replace(re, section);
  // Append after user content
  return `${existing}\n\n${section}`;
}

function removeArgentSection(existing: string): string {
  const re = new RegExp(
    `\\n*${escapeRegExp(ARGENT_RULES_START)}[\\s\\S]*?${escapeRegExp(ARGENT_RULES_END)}\\n*`
  );
  return existing.replace(re, "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
