import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  MCP_SERVER_KEY,
  MCP_BINARY_NAME,
  PERMISSION_RULE,
  CURSOR_ALLOWLIST_PATTERN,
} from "./constants.js";
import { readJson, writeJson, dirExists, readToml, writeToml } from "./utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Cursor adapter ────────────────────────────────────────────────────────────
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
    writeJson(configPath, config);
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
    writeJson(permPath, config);
  },
};

// ── Claude Code adapter ───────────────────────────────────────────────────────
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
    writeJson(configPath, config);
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
    writeJson(configPath, config);
    return true;
  },
};

// ── Windsurf adapter ─────────────────────────────────────────────────────────
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
    writeJson(configPath, config);
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
    writeJson(configPath, config);
  },
};

// ── Zed adapter ──────────────────────────────────────────────────────────────
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
    writeJson(configPath, config);
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
    writeJson(settingsPath, config);
  },
};

// ── Gemini CLI adapter ────────────────────────────────────────────────────────
// Format: { mcpServers: { argent: { command, args, env } } }
// Project: <root>/.gemini/settings.json   Global: ~/.gemini/settings.json

const geminiAdapter: McpConfigAdapter = {
  name: "Gemini",

  detect(): boolean {
    return (
      dirExists(path.join(homedir(), ".gemini")) || dirExists(path.join(process.cwd(), ".gemini"))
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".gemini", "settings.json");
  },

  globalPath(): string | null {
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
    writeJson(configPath, config);
    return true;
  },

  addAllowlist(root: string, scope: "local" | "global"): void {
    const configPath =
      scope === "global"
        ? path.join(homedir(), ".gemini", "settings.json")
        : path.join(root, ".gemini", "settings.json");
    const config = readJson(configPath);
    const servers = (config.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const entry = servers[MCP_SERVER_KEY];
    if (!entry) return;
    entry.trust = true;
    writeJson(configPath, config);
  },

  removeAllowlist(root: string, scope: "local" | "global"): void {
    const configPath =
      scope === "global"
        ? path.join(homedir(), ".gemini", "settings.json")
        : path.join(root, ".gemini", "settings.json");
    if (!fs.existsSync(configPath)) return;
    const config = readJson(configPath);
    const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
    const entry = servers?.[MCP_SERVER_KEY];
    if (!entry?.trust) return;
    delete entry.trust;
    writeJson(configPath, config);
  },
};

// ── Codex CLI adapter ────────────────────────────────────────────────────────
// Format (TOML): [mcp_servers.argent] command = "argent" args = ["mcp"] env = { ... }
// Project: <root>/.codex/config.toml   Global: ~/.codex/config.toml

const codexAdapter: McpConfigAdapter = {
  name: "Codex",

  detect(): boolean {
    return (
      dirExists(path.join(homedir(), ".codex")) || dirExists(path.join(process.cwd(), ".codex"))
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".codex", "config.toml");
  },

  globalPath(): string | null {
    return path.join(homedir(), ".codex", "config.toml");
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
    writeToml(configPath, config);
    return true;
  },
};

// ── Trae adapter ────────────────────────────────────────────────────────────
// Format: { mcpServers: { argent: { command, args, env } } }
// Project: <root>/.trae/mcp.json
// Global (macOS): ~/Library/Application Support/Trae/User/mcp.json

const traeAdapter: McpConfigAdapter = {
  name: "Trae",

  detect(): boolean {
    return (
      dirExists(path.join(process.cwd(), ".trae")) ||
      dirExists(
        path.join(homedir(), "Library", "Application Support", "Trae", "User")
      )
    );
  },

  projectPath(root: string): string | null {
    return path.join(root, ".trae", "mcp.json");
  },

  globalPath(): string | null {
    return path.join(
      homedir(),
      "Library",
      "Application Support",
      "Trae",
      "User",
      "mcp.json"
    );
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
    writeJson(configPath, config);
    return true;
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

export const ALL_ADAPTERS: McpConfigAdapter[] = [
  cursorAdapter,
  claudeAdapter,
  vscodeAdapter,
  windsurfAdapter,
  zedAdapter,
  geminiAdapter,
  codexAdapter,
  traeAdapter,
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
  writeJson(settingsPath, config);
}

// ── Rules / Agents copy helpers ───────────────────────────────────────────────

interface CopyTarget {
  editorName: string;
  rulesDir: string;
  agentsDir?: string;
}

function getCopyTargets(
  adapters: McpConfigAdapter[],
  root: string,
  scope: "local" | "global"
): CopyTarget[] {
  const targets: CopyTarget[] = [];

  for (const adapter of adapters) {
    const base =
      scope === "global"
        ? adapter.globalPath()
          ? path.dirname(adapter.globalPath()!)
          : null
        : adapter.projectPath(root)
          ? path.dirname(adapter.projectPath(root)!)
          : null;

    if (!base) continue;

    switch (adapter.name) {
      case "Cursor":
        targets.push({
          editorName: adapter.name,
          rulesDir: path.join(base, "rules"),
        });
        break;
      case "Claude Code": {
        const claudeBase =
          scope === "global" ? path.join(homedir(), ".claude") : path.join(root, ".claude");
        targets.push({
          editorName: adapter.name,
          rulesDir: path.join(claudeBase, "rules"),
          agentsDir: path.join(claudeBase, "agents"),
        });
        break;
      }
      case "Gemini": {
        const geminiBase =
          scope === "global" ? path.join(homedir(), ".gemini") : path.join(root, ".gemini");
        targets.push({
          editorName: adapter.name,
          rulesDir: path.join(geminiBase, "rules"),
          agentsDir: path.join(geminiBase, "agents"),
        });
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
  writeToml(configPath, config);
  return true;
}

// ── Copy orchestrator ────────────────────────────────────────────────────────

export function copyRulesAndAgents(
  adapters: McpConfigAdapter[],
  root: string,
  scope: "local" | "global",
  rulesDir: string,
  agentsDir: string
): string[] {
  const results: string[] = [];
  const targets = getCopyTargets(adapters, root, scope);

  for (const target of targets) {
    try {
      if (fs.existsSync(rulesDir)) {
        fs.mkdirSync(target.rulesDir, { recursive: true });
        fs.cpSync(rulesDir, target.rulesDir, { recursive: true });
        results.push(`  Copied rules to ${target.rulesDir}`);
      }
    } catch (err) {
      results.push(`  Could not copy rules to ${target.rulesDir}: ${err}`);
    }

    if (target.agentsDir) {
      try {
        if (fs.existsSync(agentsDir)) {
          fs.mkdirSync(target.agentsDir, { recursive: true });
          fs.cpSync(agentsDir, target.agentsDir, { recursive: true });
          results.push(`  Copied agents to ${target.agentsDir}`);
        }
      } catch (err) {
        results.push(`  Could not copy agents to ${target.agentsDir}: ${err}`);
      }
    }
  }

  // Codex: inject rules into developer_instructions in config.toml
  for (const adapter of adapters) {
    if (adapter.name !== "Codex") continue;
    const configPath = scope === "global" ? adapter.globalPath() : adapter.projectPath(root);
    if (!configPath) continue;
    try {
      const injected = injectCodexRules(configPath, rulesDir);
      if (injected) {
        results.push(`  Injected rules into ${configPath} (developer_instructions)`);
      }
    } catch (err) {
      results.push(`  Could not inject rules into ${configPath}: ${err}`);
    }
  }

  return results;
}
