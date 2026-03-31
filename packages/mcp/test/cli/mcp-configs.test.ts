import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ALL_ADAPTERS,
  getMcpEntry,
  addClaudePermission,
  removeClaudePermission,
  copyRulesAndAgents,
  type McpConfigAdapter,
} from "../../src/cli/mcp-configs.js";

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

function setupTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-test-"));
  return dir;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

beforeEach(() => {
  tmpDir = setupTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getMcpEntry ───────────────────────────────────────────────────────────────

describe("getMcpEntry", () => {
  it("returns an entry with argent-mcp as command", () => {
    const entry = getMcpEntry();
    expect(entry.command).toBe("argent-mcp");
    expect(entry.args).toEqual([]);
    expect(entry.env).toHaveProperty("RADON_MCP_LOG");
  });
});

// ── Adapter registry ──────────────────────────────────────────────────────────

describe("ALL_ADAPTERS", () => {
  it("contains all six adapters", () => {
    const names = ALL_ADAPTERS.map((a) => a.name);
    expect(names).toEqual(["Cursor", "Claude Code", "VS Code", "Windsurf", "Zed", "Gemini"]);
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
    expect(argent.command).toBe("argent-mcp");
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
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: "other" } } }),
    );

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("other");
    expect(servers).toHaveProperty("argent");
  });

  it("projectPath returns correct path", () => {
    expect(adapter.projectPath("/foo")).toBe(
      path.join("/foo", ".cursor", "mcp.json"),
    );
  });

  it("globalPath returns path in homedir", () => {
    expect(adapter.globalPath()).toBe(
      path.join(os.homedir(), ".cursor", "mcp.json"),
    );
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
    expect(argent.command).toBe("argent-mcp");
  });

  it("removes argent entry", () => {
    const configPath = path.join(tmpDir, ".mcp.json");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    const config = readJsonFile(configPath);
    expect(
      (config.mcpServers as Record<string, unknown>),
    ).not.toHaveProperty("argent");
  });

  it("projectPath returns .mcp.json", () => {
    expect(adapter.projectPath("/foo")).toBe(path.join("/foo", ".mcp.json"));
  });

  it("globalPath returns ~/.claude.json", () => {
    expect(adapter.globalPath()).toBe(
      path.join(os.homedir(), ".claude.json"),
    );
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
    expect(
      (config.servers as Record<string, unknown>),
    ).not.toHaveProperty("argent");
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
    const argent = (config.mcpServers as Record<string, unknown>)
      .argent as Record<string, unknown>;
    expect(argent.command).toBe("argent-mcp");
    expect(argent).not.toHaveProperty("type");
  });

  it("projectPath returns null (global-only)", () => {
    expect(adapter.projectPath("/foo")).toBeNull();
  });

  it("globalPath returns ~/.codeium/windsurf/mcp_config.json", () => {
    expect(adapter.globalPath()).toBe(
      path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
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
    expect(argent.command).toBe("argent-mcp");
  });

  it("merges into existing settings.json", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ theme: "dark", context_servers: {} }),
    );

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    expect(config.theme).toBe("dark");
    expect(
      (config.context_servers as Record<string, unknown>),
    ).toHaveProperty("argent");
  });

  it("removes from context_servers", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    const config = readJsonFile(configPath);
    expect(
      (config.context_servers as Record<string, unknown>),
    ).not.toHaveProperty("argent");
  });

  it("globalPath returns ~/.config/zed/settings.json", () => {
    expect(adapter.globalPath()).toBe(
      path.join(os.homedir(), ".config", "zed", "settings.json"),
    );
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
    expect(argent.command).toBe("argent-mcp");
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
    expect(adapter.projectPath("/foo")).toBe(
      path.join("/foo", ".gemini", "settings.json"),
    );
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
    expect(adapter.globalPath()).toBe(
      path.join(os.homedir(), ".gemini", "settings.json"),
    );
  });

  it("preserves existing settings when writing", () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { radon: { command: "npx" } }, security: { auth: "oauth" } }),
    );

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("radon");
    expect(servers).toHaveProperty("argent");
    expect(config.security).toBeDefined();
  });
});

// ── Claude permissions ────────────────────────────────────────────────────────

describe("addClaudePermission / removeClaudePermission", () => {
  it("adds mcp__argent to .claude/settings.json", () => {
    addClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const config = readJsonFile(settingsPath);
    const allow = (config.permissions as Record<string, unknown>)
      .allow as string[];
    expect(allow).toContain("mcp__argent");
  });

  it("does not duplicate the permission", () => {
    addClaudePermission(tmpDir, "local");
    addClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const config = readJsonFile(settingsPath);
    const allow = (config.permissions as Record<string, unknown>)
      .allow as string[];
    expect(allow.filter((r) => r === "mcp__argent")).toHaveLength(1);
  });

  it("removes the permission", () => {
    addClaudePermission(tmpDir, "local");
    removeClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const config = readJsonFile(settingsPath);
    const allow = (config.permissions as Record<string, unknown>)
      .allow as string[];
    expect(allow).not.toContain("mcp__argent");
  });

  it("removeClaudePermission is a no-op when file does not exist", () => {
    expect(() => removeClaudePermission(tmpDir, "local")).not.toThrow();
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
    fs.writeFileSync(
      path.join(agentsDir, "environment-inspector.md"),
      "# Agent",
    );
  });

  it("copies rules to .claude/rules for Claude Code adapter (local)", () => {
    const claudeAdapter = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;
    const results = copyRulesAndAgents(
      [claudeAdapter],
      tmpDir,
      "local",
      rulesDir,
      agentsDir,
    );

    expect(results.some((r) => r.includes("rules"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".claude", "rules", "argent.md")),
    ).toBe(true);
  });

  it("copies agents to .claude/agents for Claude Code adapter", () => {
    const claudeAdapter = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;
    copyRulesAndAgents([claudeAdapter], tmpDir, "local", rulesDir, agentsDir);

    expect(
      fs.existsSync(
        path.join(tmpDir, ".claude", "agents", "environment-inspector.md"),
      ),
    ).toBe(true);
  });

  it("copies rules to .cursor/rules for Cursor adapter (local)", () => {
    const cursorAdapter = ALL_ADAPTERS.find((a) => a.name === "Cursor")!;
    copyRulesAndAgents([cursorAdapter], tmpDir, "local", rulesDir, agentsDir);

    expect(
      fs.existsSync(path.join(tmpDir, ".cursor", "rules", "argent.md")),
    ).toBe(true);
  });

  it("returns empty array for adapters without rules/agents targets", () => {
    const windsurfAdapter = ALL_ADAPTERS.find((a) => a.name === "Windsurf")!;
    const results = copyRulesAndAgents(
      [windsurfAdapter],
      tmpDir,
      "local",
      rulesDir,
      agentsDir,
    );
    expect(results).toHaveLength(0);
  });

  it("copies rules and agents to .gemini/ for Gemini adapter (local)", () => {
    const geminiAdapter = ALL_ADAPTERS.find((a) => a.name === "Gemini")!;
    const results = copyRulesAndAgents(
      [geminiAdapter],
      tmpDir,
      "local",
      rulesDir,
      agentsDir,
    );
    expect(results.some((r) => r.includes("rules"))).toBe(true);
    expect(results.some((r) => r.includes("agents"))).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, ".gemini", "rules", "argent.md")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(tmpDir, ".gemini", "agents", "environment-inspector.md"),
      ),
    ).toBe(true);
  });

  it("copies rules and agents to ~/.gemini/ for Gemini adapter (global)", () => {
    const geminiAdapter = ALL_ADAPTERS.find((a) => a.name === "Gemini")!;
    homedirOverride = path.join(tmpDir, "home");
    const results = copyRulesAndAgents(
      [geminiAdapter],
      tmpDir,
      "global",
      rulesDir,
      agentsDir,
    );
    expect(results.some((r) => r.includes("rules"))).toBe(true);
    expect(results.some((r) => r.includes("agents"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(homedirOverride, ".gemini", "rules", "argent.md"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          homedirOverride,
          ".gemini",
          "agents",
          "environment-inspector.md",
        ),
      ),
    ).toBe(true);
  });
});
