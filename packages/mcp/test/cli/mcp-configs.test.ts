import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ALL_ADAPTERS,
  getMcpEntry,
  addClaudePermission,
  addCodexApprovalAllowlist,
  removeClaudePermission,
  removeCodexApprovalAllowlist,
  copyRulesAndAgents,
  injectCodexRules,
  removeCodexRules,
  type McpConfigAdapter,
} from "../../src/cli/mcp-configs.js";
import { readToml } from "../../src/cli/utils.js";
import { getRegisteredToolIds } from "../../../tool-server/src/utils/registered-tools";

// ── homedir mock ──────────────────────────────────────────────────────────────
// Allows individual tests to redirect homedir() to a temp path so that
// global-scope operations don't write into the real home directory.
// The variable is read at call time, so TDZ is not a concern.

let homedirOverride: string | undefined;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: vi.fn(() => homedirOverride ?? original.homedir()),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
const isolatedToolNamesManifestPath = path.join(
  os.tmpdir(),
  `argent-tool-names-${process.pid}-mcp-configs.json`
);
fs.writeFileSync(
  isolatedToolNamesManifestPath,
  JSON.stringify([...getRegisteredToolIds()].sort(), null, 2) + "\n"
);
process.env.ARGENT_CODEX_TOOL_MANIFEST = isolatedToolNamesManifestPath;
function setupTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-test-"));
  return dir;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTomlFile(filePath: string): Record<string, unknown> {
  return readToml(filePath);
}

beforeEach(() => {
  tmpDir = setupTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  homedirOverride = undefined;
});

afterAll(() => {
  fs.rmSync(isolatedToolNamesManifestPath, { force: true });
});

// ── getMcpEntry ───────────────────────────────────────────────────────────────

describe("getMcpEntry", () => {
  it("returns an entry with argent as command", () => {
    const entry = getMcpEntry();
    expect(entry.command).toBe("argent");
    expect(entry.args).toEqual(["mcp"]);
    expect(entry.env).toHaveProperty("ARGENT_MCP_LOG");
  });
});

// ── Adapter registry ──────────────────────────────────────────────────────────

describe("ALL_ADAPTERS", () => {
  it("contains all seven adapters", () => {
    const names = ALL_ADAPTERS.map((a) => a.name);
    expect(names).toEqual([
      "Cursor",
      "Claude Code",
      "VS Code",
      "Windsurf",
      "Zed",
      "Gemini",
      "Codex",
    ]);
  });
});

// ── Cursor adapter ────────────────────────────────────────────────────────────

describe("Cursor adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Cursor")!;

  it("writes { mcpServers: { argent: ... } } format", () => {
    const configPath = path.join(tmpDir, ".cursor", "mcp.json");
    const entry = getMcpEntry();

    adapter.write(configPath, entry);

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("argent");
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.command).toBe("argent");
    expect(argent).not.toHaveProperty("type");
  });

  it("removes argent entry and returns true", () => {
    const configPath = path.join(tmpDir, ".cursor", "mcp.json");
    adapter.write(configPath, getMcpEntry());

    const removed = adapter.remove(configPath);
    expect(removed).toBe(true);

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).not.toHaveProperty("argent");
  });

  it("returns false when removing from non-existent file", () => {
    expect(adapter.remove(path.join(tmpDir, "nope.json"))).toBe(false);
  });

  it("returns false when removing from file without argent entry", () => {
    const configPath = path.join(tmpDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

    expect(adapter.remove(configPath)).toBe(false);
  });

  it("preserves other servers when writing", () => {
    const configPath = path.join(tmpDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("other");
    expect(servers).toHaveProperty("argent");
  });

  it("projectPath returns correct path", () => {
    expect(adapter.projectPath("/foo")).toBe(path.join("/foo", ".cursor", "mcp.json"));
  });

  it("globalPath returns path in homedir", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".cursor", "mcp.json"));
  });
});

// ── Claude Code adapter ───────────────────────────────────────────────────────

describe("Claude Code adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;

  it("writes { mcpServers: { argent: { type: 'stdio', ... } } }", () => {
    const configPath = path.join(tmpDir, ".mcp.json");
    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.type).toBe("stdio");
    expect(argent.command).toBe("argent");
  });

  it("removes argent entry", () => {
    const configPath = path.join(tmpDir, ".mcp.json");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    const config = readJsonFile(configPath);
    expect(config.mcpServers as Record<string, unknown>).not.toHaveProperty("argent");
  });

  it("projectPath returns .mcp.json", () => {
    expect(adapter.projectPath("/foo")).toBe(path.join("/foo", ".mcp.json"));
  });

  it("globalPath returns ~/.claude.json", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".claude.json"));
  });
});

// ── VS Code adapter ──────────────────────────────────────────────────────────

describe("VS Code adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "VS Code")!;

  it("writes { servers: { argent: { type: 'stdio', ... } } }", () => {
    const configPath = path.join(tmpDir, ".vscode", "mcp.json");
    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    expect(config).toHaveProperty("servers");
    expect(config).not.toHaveProperty("mcpServers");
    const servers = config.servers as Record<string, unknown>;
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.type).toBe("stdio");
  });

  it("removes from servers key", () => {
    const configPath = path.join(tmpDir, ".vscode", "mcp.json");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    const config = readJsonFile(configPath);
    expect(config.servers as Record<string, unknown>).not.toHaveProperty("argent");
  });

  it("globalPath returns null (project-only)", () => {
    expect(adapter.globalPath()).toBeNull();
  });
});

// ── Windsurf adapter ─────────────────────────────────────────────────────────

describe("Windsurf adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Windsurf")!;

  it("writes { mcpServers: { argent: ... } } without type", () => {
    const configPath = path.join(tmpDir, "mcp_config.json");
    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const argent = (config.mcpServers as Record<string, unknown>).argent as Record<string, unknown>;
    expect(argent.command).toBe("argent");
    expect(argent).not.toHaveProperty("type");
  });

  it("projectPath returns null (global-only)", () => {
    expect(adapter.projectPath("/foo")).toBeNull();
  });

  it("globalPath returns ~/.codeium/windsurf/mcp_config.json", () => {
    expect(adapter.globalPath()).toBe(
      path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json")
    );
  });
});

// ── Zed adapter ──────────────────────────────────────────────────────────────

describe("Zed adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Zed")!;

  it("writes { context_servers: { argent: { source: 'custom', ... } } }", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    expect(config).toHaveProperty("context_servers");
    const servers = config.context_servers as Record<string, unknown>;
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.source).toBe("custom");
    expect(argent.command).toBe("argent");
  });

  it("merges into existing settings.json", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ theme: "dark", context_servers: {} }));

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    expect(config.theme).toBe("dark");
    expect(config.context_servers as Record<string, unknown>).toHaveProperty("argent");
  });

  it("removes from context_servers", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    const config = readJsonFile(configPath);
    expect(config.context_servers as Record<string, unknown>).not.toHaveProperty("argent");
  });

  it("globalPath returns ~/.config/zed/settings.json", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".config", "zed", "settings.json"));
  });
});

// ── Gemini adapter ────────────────────────────────────────────────────────────

describe("Gemini adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Gemini")!;

  it("writes { mcpServers: { argent: ... } } without type", () => {
    const configPath = path.join(tmpDir, "settings.json");
    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("argent");
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.command).toBe("argent");
    expect(argent).not.toHaveProperty("type");
  });

  it("removes argent entry and returns true", () => {
    const configPath = path.join(tmpDir, "settings.json");
    adapter.write(configPath, getMcpEntry());

    const removed = adapter.remove(configPath);
    expect(removed).toBe(true);

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).not.toHaveProperty("argent");
  });

  it("returns false when removing from non-existent file", () => {
    expect(adapter.remove(path.join(tmpDir, "nope.json"))).toBe(false);
  });

  it("returns false when removing from file without argent entry", () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    expect(adapter.remove(configPath)).toBe(false);
  });

  it("projectPath returns .gemini/settings.json under project root", () => {
    expect(adapter.projectPath("/foo")).toBe(path.join("/foo", ".gemini", "settings.json"));
  });

  it("detect() returns true when local .gemini dir exists", () => {
    const localGemini = path.join(process.cwd(), ".gemini");
    const existed = fs.existsSync(localGemini);
    if (!existed) fs.mkdirSync(localGemini, { recursive: true });
    try {
      expect(adapter.detect()).toBe(true);
    } finally {
      if (!existed) fs.rmdirSync(localGemini);
    }
  });

  it("globalPath returns ~/.gemini/settings.json", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".gemini", "settings.json"));
  });

  it("preserves existing settings when writing", () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { "other-tool": { command: "npx" } },
        security: { auth: "oauth" },
      })
    );

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("other-tool");
    expect(servers).toHaveProperty("argent");
    expect(config.security).toBeDefined();
  });

  it("addAllowlist sets trust:true on the argent entry (local)", () => {
    const configPath = path.join(tmpDir, ".gemini", "settings.json");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "local");

    const config = readJsonFile(configPath);
    const entry = (config.mcpServers as Record<string, unknown>).argent as Record<string, unknown>;
    expect(entry.trust).toBe(true);
  });

  it("addAllowlist sets trust:true on the argent entry (global)", () => {
    homedirOverride = path.join(tmpDir, "home");
    const configPath = path.join(homedirOverride, ".gemini", "settings.json");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "global");

    const config = readJsonFile(configPath);
    const entry = (config.mcpServers as Record<string, unknown>).argent as Record<string, unknown>;
    expect(entry.trust).toBe(true);
  });

  it("removeAllowlist deletes trust from the argent entry", () => {
    const configPath = path.join(tmpDir, ".gemini", "settings.json");
    adapter.write(configPath, getMcpEntry());
    adapter.addAllowlist!(tmpDir, "local");

    adapter.removeAllowlist!(tmpDir, "local");

    const config = readJsonFile(configPath);
    const entry = (config.mcpServers as Record<string, unknown>).argent as Record<string, unknown>;
    expect(entry).not.toHaveProperty("trust");
  });

  it("removeAllowlist is a no-op when file does not exist", () => {
    expect(() => adapter.removeAllowlist!(tmpDir, "local")).not.toThrow();
  });
});

// ── Codex adapter ────────────────────────────────────────────────────────────

describe("Codex adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Codex")!;

  it("writes [mcp_servers.argent] in TOML format", () => {
    const configPath = path.join(tmpDir, "config.toml");
    adapter.write(configPath, getMcpEntry());

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("[mcp_servers.argent]");
    expect(content).toContain('command = "argent"');
  });

  it("removes argent entry and returns true", () => {
    const configPath = path.join(tmpDir, "config.toml");
    adapter.write(configPath, getMcpEntry());

    const removed = adapter.remove(configPath);
    expect(removed).toBe(true);

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).not.toContain("[mcp_servers.argent]");
  });

  it("returns false when removing from non-existent file", () => {
    expect(adapter.remove(path.join(tmpDir, "nope.toml"))).toBe(false);
  });

  it("returns false when removing from file without argent entry", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, "[mcp_servers]\n");
    expect(adapter.remove(configPath)).toBe(false);
  });

  it("projectPath returns .codex/config.toml under project root", () => {
    expect(adapter.projectPath("/foo")).toBe(path.join("/foo", ".codex", "config.toml"));
  });

  it("detect() returns true when local .codex dir exists", () => {
    const localCodex = path.join(process.cwd(), ".codex");
    const existed = fs.existsSync(localCodex);
    if (!existed) fs.mkdirSync(localCodex, { recursive: true });
    try {
      expect(adapter.detect()).toBe(true);
    } finally {
      if (!existed) fs.rmdirSync(localCodex);
    }
  });

  it("globalPath returns ~/.codex/config.toml", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".codex", "config.toml"));
  });

  it("preserves existing settings when writing", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "npx"\n');

    adapter.write(configPath, getMcpEntry());

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain('model = "o3"');
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain("[mcp_servers.argent]");
  });
});

// ── Claude permissions ────────────────────────────────────────────────────────

describe("addClaudePermission / removeClaudePermission", () => {
  it("adds mcp__argent to .claude/settings.json", () => {
    addClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const config = readJsonFile(settingsPath);
    const allow = (config.permissions as Record<string, unknown>).allow as string[];
    expect(allow).toContain("mcp__argent");
  });

  it("does not duplicate the permission", () => {
    addClaudePermission(tmpDir, "local");
    addClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const config = readJsonFile(settingsPath);
    const allow = (config.permissions as Record<string, unknown>).allow as string[];
    expect(allow.filter((r) => r === "mcp__argent")).toHaveLength(1);
  });

  it("removes the permission", () => {
    addClaudePermission(tmpDir, "local");
    removeClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const config = readJsonFile(settingsPath);
    const allow = (config.permissions as Record<string, unknown>).allow as string[];
    expect(allow).not.toContain("mcp__argent");
  });

  it("removeClaudePermission is a no-op when file does not exist", () => {
    expect(() => removeClaudePermission(tmpDir, "local")).not.toThrow();
  });
});

// ── Codex approvals ───────────────────────────────────────────────────────────

describe("addCodexApprovalAllowlist / removeCodexApprovalAllowlist", () => {
  it("adds per-tool approval entries to .codex/config.toml", () => {
    addCodexApprovalAllowlist(tmpDir, "local");

    const configPath = path.join(tmpDir, ".codex", "config.toml");
    const config = readTomlFile(configPath);
    const servers = config.mcp_servers as Record<string, unknown>;
    const argent = servers.argent as Record<string, unknown>;
    const tools = argent.tools as Record<string, unknown>;

    expect(Object.keys(tools).sort()).toEqual([...getRegisteredToolIds()].sort());
    expect((tools["gesture-tap"] as Record<string, unknown>).approval_mode).toBe("approve");
    expect((tools["describe"] as Record<string, unknown>).approval_mode).toBe("approve");
  });

  it("does not clobber existing Codex MCP server settings", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      'model = "gpt-5.4"\n[mcp_servers.argent]\ncommand = "argent"\n[mcp_servers.argent.env]\nFOO = "bar"\n'
    );

    addCodexApprovalAllowlist(tmpDir, "local");

    const config = readTomlFile(configPath);
    const argent = (config.mcp_servers as Record<string, unknown>).argent as Record<
      string,
      unknown
    >;
    expect(argent.command).toBe("argent");
    expect((argent.env as Record<string, unknown>).FOO).toBe("bar");
    expect(argent.tools).toBeDefined();
  });

  it("adds per-tool approval entries to ~/.codex/config.toml for global scope", () => {
    homedirOverride = path.join(tmpDir, "home");

    addCodexApprovalAllowlist(tmpDir, "global");

    const configPath = path.join(homedirOverride, ".codex", "config.toml");
    const config = readTomlFile(configPath);
    const argent = ((config.mcp_servers as Record<string, unknown>).argent ?? {}) as Record<
      string,
      unknown
    >;
    const tools = (argent.tools ?? {}) as Record<string, unknown>;

    expect(Object.keys(tools).sort()).toEqual([...getRegisteredToolIds()].sort());
    expect((tools["gesture-tap"] as Record<string, unknown>).approval_mode).toBe("approve");
  });

  it("removes only Argent tool approvals from .codex/config.toml", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "[mcp_servers.argent]",
        'command = "argent"',
        '[mcp_servers.argent.tools."gesture-tap"]',
        'approval_mode = "approve"',
        '[mcp_servers.argent.tools."custom-tool"]',
        'approval_mode = "approve"',
      ].join("\n")
    );

    removeCodexApprovalAllowlist(tmpDir, "local");

    const config = readTomlFile(configPath);
    const argent = (config.mcp_servers as Record<string, unknown>).argent as Record<
      string,
      unknown
    >;
    const tools = argent.tools as Record<string, unknown>;
    expect(tools["gesture-tap"]).toBeUndefined();
    expect((tools["custom-tool"] as Record<string, unknown>).approval_mode).toBe("approve");
  });

  it("preserves non-approval settings on Argent tool config during uninstall", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "[mcp_servers.argent]",
        'command = "argent"',
        '[mcp_servers.argent.tools."gesture-tap"]',
        'approval_mode = "approve"',
        "enabled = true",
      ].join("\n")
    );

    removeCodexApprovalAllowlist(tmpDir, "local");

    const config = readTomlFile(configPath);
    const argent = (config.mcp_servers as Record<string, unknown>).argent as Record<
      string,
      unknown
    >;
    const tools = argent.tools as Record<string, unknown>;
    expect((tools["gesture-tap"] as Record<string, unknown>).enabled).toBe(true);
    expect((tools["gesture-tap"] as Record<string, unknown>).approval_mode).toBeUndefined();
  });

  it("removes only approval_mode for registered tools that have extra config", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "[mcp_servers.argent]",
        'command = "argent"',
        '[mcp_servers.argent.tools."gesture-tap"]',
        'approval_mode = "approve"',
        "timeout_ms = 5000",
      ].join("\n")
    );

    removeCodexApprovalAllowlist(tmpDir, "local");

    const config = readTomlFile(configPath);
    const argent = (config.mcp_servers as Record<string, unknown>).argent as Record<
      string,
      unknown
    >;
    const tools = argent.tools as Record<string, unknown>;
    expect((tools["gesture-tap"] as Record<string, unknown>).timeout_ms).toBe(5000);
    expect((tools["gesture-tap"] as Record<string, unknown>).approval_mode).toBeUndefined();
  });

  it("removes the tools table when only Argent approvals remain", () => {
    addCodexApprovalAllowlist(tmpDir, "local");
    removeCodexApprovalAllowlist(tmpDir, "local");

    const configPath = path.join(tmpDir, ".codex", "config.toml");
    const config = readTomlFile(configPath);
    const argent = (config.mcp_servers as Record<string, unknown>).argent as Record<
      string,
      unknown
    >;
    expect(argent.tools).toBeUndefined();
  });

  it("removes global-scope approvals from ~/.codex/config.toml", () => {
    homedirOverride = path.join(tmpDir, "home");

    addCodexApprovalAllowlist(tmpDir, "global");
    removeCodexApprovalAllowlist(tmpDir, "global");

    const configPath = path.join(homedirOverride, ".codex", "config.toml");
    const config = readTomlFile(configPath);
    const argent = (config.mcp_servers as Record<string, unknown>).argent as Record<
      string,
      unknown
    >;
    expect(argent.tools).toBeUndefined();
  });

  it("removeCodexApprovalAllowlist is a no-op when file does not exist", () => {
    expect(() => removeCodexApprovalAllowlist(tmpDir, "local")).not.toThrow();
  });

});

// ── copyRulesAndAgents ────────────────────────────────────────────────────────

describe("copyRulesAndAgents", () => {
  let rulesDir: string;
  let agentsDir: string;

  afterEach(() => {
    homedirOverride = undefined;
  });

  beforeEach(() => {
    rulesDir = path.join(tmpDir, "src-rules");
    agentsDir = path.join(tmpDir, "src-agents");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "argent.md"), "# Rule");
    fs.writeFileSync(path.join(agentsDir, "environment-inspector.md"), "# Agent");
  });

  it("copies rules to .claude/rules for Claude Code adapter (local)", () => {
    const claudeAdapter = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;
    const results = copyRulesAndAgents([claudeAdapter], tmpDir, "local", rulesDir, agentsDir);

    expect(results.some((r) => r.includes("rules"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".claude", "rules", "argent.md"))).toBe(true);
  });

  it("copies agents to .claude/agents for Claude Code adapter", () => {
    const claudeAdapter = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;
    copyRulesAndAgents([claudeAdapter], tmpDir, "local", rulesDir, agentsDir);

    expect(fs.existsSync(path.join(tmpDir, ".claude", "agents", "environment-inspector.md"))).toBe(
      true
    );
  });

  it("copies rules to .cursor/rules for Cursor adapter (local)", () => {
    const cursorAdapter = ALL_ADAPTERS.find((a) => a.name === "Cursor")!;
    copyRulesAndAgents([cursorAdapter], tmpDir, "local", rulesDir, agentsDir);

    expect(fs.existsSync(path.join(tmpDir, ".cursor", "rules", "argent.md"))).toBe(true);
  });

  it("returns empty array for adapters without rules/agents targets", () => {
    const windsurfAdapter = ALL_ADAPTERS.find((a) => a.name === "Windsurf")!;
    const results = copyRulesAndAgents([windsurfAdapter], tmpDir, "local", rulesDir, agentsDir);
    expect(results).toHaveLength(0);
  });

  it("copies rules and agents to .gemini/ for Gemini adapter (local)", () => {
    const geminiAdapter = ALL_ADAPTERS.find((a) => a.name === "Gemini")!;
    const results = copyRulesAndAgents([geminiAdapter], tmpDir, "local", rulesDir, agentsDir);
    expect(results.some((r) => r.includes("rules"))).toBe(true);
    expect(results.some((r) => r.includes("agents"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".gemini", "rules", "argent.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".gemini", "agents", "environment-inspector.md"))).toBe(
      true
    );
  });

  it("copies rules and agents to ~/.gemini/ for Gemini adapter (global)", () => {
    const geminiAdapter = ALL_ADAPTERS.find((a) => a.name === "Gemini")!;
    homedirOverride = path.join(tmpDir, "home");
    const results = copyRulesAndAgents([geminiAdapter], tmpDir, "global", rulesDir, agentsDir);
    expect(results.some((r) => r.includes("rules"))).toBe(true);
    expect(results.some((r) => r.includes("agents"))).toBe(true);
    expect(fs.existsSync(path.join(homedirOverride, ".gemini", "rules", "argent.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(homedirOverride, ".gemini", "agents", "environment-inspector.md"))
    ).toBe(true);
  });

  it("injects Codex rules into a model instructions file referenced by config.toml (local)", () => {
    const codexAdapter = ALL_ADAPTERS.find((a) => a.name === "Codex")!;
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "");

    const results = copyRulesAndAgents([codexAdapter], tmpDir, "local", rulesDir, agentsDir);
    expect(results.some((r) => r.includes("model_instructions_file"))).toBe(true);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).toContain('model_instructions_file = "model_instructions.md"');

    const instructionsPath = path.join(tmpDir, ".codex", "model_instructions.md");
    const instructionsContent = fs.readFileSync(instructionsPath, "utf8");
    expect(instructionsContent).toContain("argent rules");
  });

  it("injects Codex rules into ~/.codex/model_instructions.md for global scope", () => {
    const codexAdapter = ALL_ADAPTERS.find((a) => a.name === "Codex")!;
    homedirOverride = path.join(tmpDir, "home");

    const results = copyRulesAndAgents([codexAdapter], tmpDir, "global", rulesDir, agentsDir);
    expect(results.some((r) => r.includes("model_instructions_file"))).toBe(true);

    const configPath = path.join(homedirOverride, ".codex", "config.toml");
    const instructionsPath = path.join(homedirOverride, ".codex", "model_instructions.md");

    expect(fs.readFileSync(configPath, "utf8")).toContain("model_instructions_file");
    expect(fs.readFileSync(instructionsPath, "utf8")).toContain("argent rules");
  });
});

// ── Codex model_instructions_file injection ─────────────────────────────────

describe("injectCodexRules / removeCodexRules", () => {
  let rulesDir: string;

  beforeEach(() => {
    rulesDir = path.join(tmpDir, "src-rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, "argent.md"),
      "---\ndescription: Test rule\nalwaysApply: true\n---\n\nUse argent tools for simulator control."
    );
  });

  it("injects rules content with frontmatter stripped", () => {
    const configPath = path.join(tmpDir, "config.toml");
    injectCodexRules(configPath, rulesDir);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).toContain('model_instructions_file = "model_instructions.md"');

    const instructionsContent = fs.readFileSync(path.join(tmpDir, "model_instructions.md"), "utf8");
    expect(instructionsContent).toContain("Use argent tools for simulator control.");
    expect(instructionsContent).not.toContain("alwaysApply");
    expect(instructionsContent).toContain("argent rules");
  });

  it("preserves existing developer_instructions", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, 'developer_instructions = "Always use TypeScript."\n');

    injectCodexRules(configPath, rulesDir);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).toContain("Always use TypeScript.");

    const instructionsContent = fs.readFileSync(path.join(tmpDir, "model_instructions.md"), "utf8");
    expect(instructionsContent).toContain("Use argent tools for simulator control.");
  });

  it("replaces existing argent section on re-inject", () => {
    const configPath = path.join(tmpDir, "config.toml");
    injectCodexRules(configPath, rulesDir);

    // Update rule content and re-inject
    fs.writeFileSync(path.join(rulesDir, "argent.md"), "Updated rule content.");
    injectCodexRules(configPath, rulesDir);

    const instructionsContent = fs.readFileSync(path.join(tmpDir, "model_instructions.md"), "utf8");
    expect(instructionsContent).toContain("Updated rule content.");
    expect(instructionsContent).not.toContain("Use argent tools for simulator control.");
    // Should only have one pair of markers
    expect(instructionsContent.split("argent rules").length - 1).toBe(2); // start + end
  });

  it("reuses an existing model_instructions_file target", () => {
    const configPath = path.join(tmpDir, "config.toml");
    const instructionsPath = path.join(tmpDir, "custom-instructions.md");
    fs.writeFileSync(
      configPath,
      `model_instructions_file = "${instructionsPath}"\ndeveloper_instructions = "Always use TypeScript."\n`
    );
    fs.writeFileSync(instructionsPath, "Keep existing content.");

    injectCodexRules(configPath, rulesDir);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).toContain(`model_instructions_file = "${instructionsPath}"`);
    expect(configContent).toContain("Always use TypeScript.");

    const instructionsContent = fs.readFileSync(instructionsPath, "utf8");
    expect(instructionsContent).toContain("Keep existing content.");
    expect(instructionsContent).toContain("Use argent tools for simulator control.");
  });

  it("resolves relative model_instructions_file paths relative to config.toml", () => {
    const configPath = path.join(tmpDir, "nested", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model_instructions_file = "instructions/custom.md"\n');

    injectCodexRules(configPath, rulesDir);

    const expectedPath = path.join(tmpDir, "nested", "instructions", "custom.md");
    expect(fs.readFileSync(expectedPath, "utf8")).toContain("Use argent tools for simulator control.");
  });

  it("migrates legacy argent content out of developer_instructions", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        'developer_instructions = "Always use TypeScript.\\n\\n# --- argent rules (managed by argent init — do not edit) ---\\nLegacy argent rules.\\n# --- end argent rules ---"',
      ].join("\n")
    );

    injectCodexRules(configPath, rulesDir);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).toContain("Always use TypeScript.");
    expect(configContent).not.toContain("Legacy argent rules.");
    expect(configContent).toContain("model_instructions_file");

    const instructionsContent = fs.readFileSync(path.join(tmpDir, "model_instructions.md"), "utf8");
    expect(instructionsContent).toContain("Use argent tools for simulator control.");
  });

  it("removeCodexRules strips argent section", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, 'developer_instructions = "Always use TypeScript."\n');
    injectCodexRules(configPath, rulesDir);

    const removed = removeCodexRules(configPath);
    expect(removed).toBe(true);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).toContain("Always use TypeScript.");
    expect(configContent).not.toContain("argent rules");
    expect(configContent).not.toContain("model_instructions_file");
    expect(fs.existsSync(path.join(tmpDir, "model_instructions.md"))).toBe(false);
  });

  it("removeCodexRules deletes the default file reference when only argent content remains", () => {
    const configPath = path.join(tmpDir, "config.toml");
    injectCodexRules(configPath, rulesDir);

    removeCodexRules(configPath);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).not.toContain("developer_instructions");
    expect(configContent).not.toContain("model_instructions_file");
    expect(fs.existsSync(path.join(tmpDir, "model_instructions.md"))).toBe(false);
  });

  it("removeCodexRules preserves a custom model_instructions_file target", () => {
    const configPath = path.join(tmpDir, "config.toml");
    const instructionsPath = path.join(tmpDir, "custom-instructions.md");
    fs.writeFileSync(configPath, `model_instructions_file = "${instructionsPath}"\n`);
    injectCodexRules(configPath, rulesDir);

    const removed = removeCodexRules(configPath);
    expect(removed).toBe(true);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).toContain(`model_instructions_file = "${instructionsPath}"`);
    expect(fs.readFileSync(instructionsPath, "utf8")).toBe("");
  });

  it("removeCodexRules preserves user-authored text in the default instructions file", () => {
    const configPath = path.join(tmpDir, "config.toml");
    injectCodexRules(configPath, rulesDir);

    const instructionsPath = path.join(tmpDir, "model_instructions.md");
    fs.writeFileSync(
      instructionsPath,
      ["Keep this guidance.", fs.readFileSync(instructionsPath, "utf8")].join("\n\n")
    );

    const removed = removeCodexRules(configPath);
    expect(removed).toBe(true);

    expect(fs.readFileSync(configPath, "utf8")).toContain("model_instructions_file");
    expect(fs.readFileSync(instructionsPath, "utf8")).toBe("Keep this guidance.\n");
  });

  it("removeCodexRules preserves user-authored text in a custom instructions file", () => {
    const configPath = path.join(tmpDir, "config.toml");
    const instructionsPath = path.join(tmpDir, "custom-instructions.md");
    fs.writeFileSync(configPath, `model_instructions_file = "${instructionsPath}"\n`);
    fs.writeFileSync(instructionsPath, "Existing user guidance.");
    injectCodexRules(configPath, rulesDir);

    const removed = removeCodexRules(configPath);
    expect(removed).toBe(true);

    expect(fs.readFileSync(configPath, "utf8")).toContain(
      `model_instructions_file = "${instructionsPath}"`
    );
    expect(fs.readFileSync(instructionsPath, "utf8")).toBe("Existing user guidance.\n");
  });

  it("removeCodexRules returns false when no argent section exists", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, 'model = "o3"\n');
    expect(removeCodexRules(configPath)).toBe(false);
  });

  it("removeCodexRules also cleans legacy developer_instructions-only installs", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(
      configPath,
      'developer_instructions = "# --- argent rules (managed by argent init — do not edit) ---\\nLegacy argent rules.\\n# --- end argent rules ---"\n'
    );

    const removed = removeCodexRules(configPath);
    expect(removed).toBe(true);

    const configContent = fs.readFileSync(configPath, "utf8");
    expect(configContent).not.toContain("developer_instructions");
  });

  it("removeCodexRules returns false for non-existent file", () => {
    expect(removeCodexRules(path.join(tmpDir, "nope.toml"))).toBe(false);
  });

  it("returns null when rulesDir does not exist", () => {
    const configPath = path.join(tmpDir, "config.toml");
    expect(injectCodexRules(configPath, path.join(tmpDir, "nonexistent"))).toBeNull();
  });
});
