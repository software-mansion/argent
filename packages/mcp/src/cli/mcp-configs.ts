import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { MCP_SERVER_KEY, MCP_BINARY_NAME, PERMISSION_RULE } from "./constants.js";
import { readJson, writeJson, dirExists } from "./utils.js";

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
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function buildMcpEntry(): McpServerEntry {
  const logFile = path.join(homedir(), ".argent", "mcp-calls.log");
  return {
    command: MCP_BINARY_NAME,
    args: [],
    env: { RADON_MCP_LOG: logFile },
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
      dirExists(path.join(homedir(), ".cursor")) ||
      dirExists(path.join(process.cwd(), ".cursor"))
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
};

// ── VS Code adapter ──────────────────────────────────────────────────────────
// Format: { servers: { argent: { type: "stdio", command, args, env } } }
// Project only: .vscode/mcp.json

const vscodeAdapter: McpConfigAdapter = {
  name: "VS Code",

  detect(): boolean {
    return (
      dirExists(path.join(process.cwd(), ".vscode")) ||
      dirExists(path.join(homedir(), ".vscode"))
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
    const servers = config.context_servers as
      | Record<string, unknown>
      | undefined;
    if (!servers?.[MCP_SERVER_KEY]) return false;
    delete servers[MCP_SERVER_KEY];
    writeJson(configPath, config);
    return true;
  },
};

// ── Gemini CLI adapter ────────────────────────────────────────────────────────
// Format: { mcpServers: { argent: { command, args, env } } }
// Global only: ~/.gemini/settings.json

const geminiAdapter: McpConfigAdapter = {
  name: "Gemini",

  detect(): boolean {
    // Check for the settings.json file, not just the directory — ~/.gemini can
    // be created by Google Cloud SDK and other Google tooling unrelated to Gemini CLI.
    return fs.existsSync(path.join(homedir(), ".gemini", "settings.json"));
  },

  projectPath(): string | null {
    return null;
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
};

// ── Registry ──────────────────────────────────────────────────────────────────

export const ALL_ADAPTERS: McpConfigAdapter[] = [
  cursorAdapter,
  claudeAdapter,
  vscodeAdapter,
  windsurfAdapter,
  zedAdapter,
  geminiAdapter,
];

export function detectAdapters(): McpConfigAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.detect());
}

export function getAdapterByName(name: string): McpConfigAdapter | undefined {
  return ALL_ADAPTERS.find(
    (a) => a.name.toLowerCase() === name.toLowerCase(),
  );
}

// ── Claude permissions helpers ────────────────────────────────────────────────

export function addClaudePermission(
  root: string,
  scope: "local" | "global",
): void {
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

export function removeClaudePermission(
  root: string,
  scope: "local" | "global",
): void {
  const settingsPath =
    scope === "global"
      ? path.join(homedir(), ".claude", "settings.json")
      : path.join(root, ".claude", "settings.json");

  if (!fs.existsSync(settingsPath)) return;
  const config = readJson(settingsPath);
  const allow = (config?.permissions as Record<string, unknown>)
    ?.allow as string[];
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
  scope: "local" | "global",
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
          scope === "global"
            ? path.join(homedir(), ".claude")
            : path.join(root, ".claude");
        targets.push({
          editorName: adapter.name,
          rulesDir: path.join(claudeBase, "rules"),
          agentsDir: path.join(claudeBase, "agents"),
        });
        break;
      }
      // Windsurf, Zed, Gemini: no established rules/agents directory convention.
    }
  }

  return targets;
}

export function copyRulesAndAgents(
  adapters: McpConfigAdapter[],
  root: string,
  scope: "local" | "global",
  rulesDir: string,
  agentsDir: string,
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
        results.push(
          `  Could not copy agents to ${target.agentsDir}: ${err}`,
        );
      }
    }
  }

  return results;
}
