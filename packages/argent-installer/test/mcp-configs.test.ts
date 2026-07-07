import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import { parse as parseJsonc } from "jsonc-parser";
import {
  ALL_ADAPTERS,
  getMcpEntry,
  isArgentManagedEntry,
  resolveLocalCommandMode,
  addClaudePermission,
  removeClaudePermission,
  copyRulesAndAgents,
  findConfiguredAdapterScopes,
  getManagedContentTargets,
  injectCodexRules,
  removeCodexRules,
} from "../src/mcp-configs.js";

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

// Stub the tool-server CLI shell-out used by the Codex adapter's allowlist
// logic so tests don't need the bundled `tool-server.cjs` on disk.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: vi.fn(() =>
      JSON.stringify([{ id: "tool-a" }, { id: "tool-b" }, { id: "tool-c" }])
    ),
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

// JSONC-tolerant variant for tests that read back files the Zed adapter
// wrote — those preserve user comments and trailing commas, so strict
// JSON.parse rejects them.
function readJsoncFile(filePath: string): Record<string, unknown> {
  return parseJsonc(fs.readFileSync(filePath, "utf8"), [], {
    allowTrailingComma: true,
  }) as Record<string, unknown>;
}

function readYamlFile(filePath: string): Record<string, unknown> {
  return parseYaml(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  tmpDir = setupTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── isArgentManagedEntry ──────────────────────────────────────────────────────

describe("isArgentManagedEntry", () => {
  it("accepts every shape argent itself writes", () => {
    expect(isArgentManagedEntry({ command: "argent", args: ["mcp"] })).toBe(true);
    expect(
      isArgentManagedEntry({
        command: "node",
        args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"],
      })
    ).toBe(true);
    // Windows separators in a committed relative path still count as managed.
    expect(
      isArgentManagedEntry({
        command: "node",
        args: ["node_modules\\@swmansion\\argent\\dist\\cli.js", "mcp"],
      })
    ).toBe(true);
    // The fallback shapes getLocalArgentBinRelPath emits for hoisted
    // workspaces and pnpm store layouts are argent-authored too.
    expect(
      isArgentManagedEntry({
        command: "node",
        args: ["../../node_modules/@swmansion/argent/dist/cli.js", "mcp"],
      })
    ).toBe(true);
    expect(
      isArgentManagedEntry({
        command: "node",
        args: [
          "node_modules/.pnpm/@swmansion+argent@1.0.0/node_modules/@swmansion/argent/dist/cli.js",
          "mcp",
        ],
      })
    ).toBe(true);
    expect(isArgentManagedEntry({ command: "yarn", args: ["argent", "mcp"] })).toBe(true);
    expect(isArgentManagedEntry({ command: "npx", args: ["--no-install", "argent", "mcp"] })).toBe(
      true
    );
  });

  it("rejects customized and unrecognizable entries", () => {
    // A dev checkout: node with an absolute / out-of-tree path.
    expect(
      isArgentManagedEntry({ command: "node", args: ["/home/dev/argent/cli.js", "mcp"] })
    ).toBe(false);
    expect(isArgentManagedEntry({ command: "node", args: ["../elsewhere/cli.js", "mcp"] })).toBe(
      false
    );
    // Env vars mark a hand-tuned entry even on the stock command.
    expect(
      isArgentManagedEntry({ command: "argent", args: ["mcp"], env: { PATH: "/custom" } })
    ).toBe(false);
    // Extra or missing args.
    expect(isArgentManagedEntry({ command: "argent", args: ["mcp", "--flag"] })).toBe(false);
    expect(isArgentManagedEntry({ command: "argent", args: [] })).toBe(false);
    // The unreadable-entry sentinel and absent entries.
    expect(isArgentManagedEntry({ command: "", args: [] })).toBe(false);
    expect(isArgentManagedEntry(null)).toBe(false);
    expect(isArgentManagedEntry({ command: "docker", args: ["run", "argent", "mcp"] })).toBe(false);
  });
});

// ── getArgentEntry env passthrough ────────────────────────────────────────────

describe("getArgentEntry env passthrough", () => {
  it("surfaces env vars so classification can see hand-tuned entries", () => {
    const cursor = ALL_ADAPTERS.find((a) => a.name === "Cursor")!;
    const configPath = path.join(tmpDir, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          argent: { command: "argent", args: ["mcp"], env: { PATH: "/custom/bin" } },
        },
      })
    );

    expect(cursor.getArgentEntry(configPath)).toEqual({
      command: "argent",
      args: ["mcp"],
      env: { PATH: "/custom/bin" },
    });
  });

  it("maps opencode's `environment` key onto env", () => {
    const opencode = ALL_ADAPTERS.find((a) => a.name === "opencode")!;
    const configPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcp: {
          argent: {
            type: "local",
            command: ["argent", "mcp"],
            enabled: true,
            environment: { FOO: "bar" },
          },
        },
      })
    );

    expect(opencode.getArgentEntry(configPath)).toEqual({
      command: "argent",
      args: ["mcp"],
      env: { FOO: "bar" },
    });
  });
});

// ── getMcpEntry ───────────────────────────────────────────────────────────────

describe("getMcpEntry", () => {
  it("returns an entry with argent as command and no env vars", () => {
    const entry = getMcpEntry();
    expect(entry.command).toBe("argent");
    expect(entry.args).toEqual(["mcp"]);
    // Generated configs are committed and shared, so they must not bake a
    // per-user log path into ARGENT_MCP_LOG (issue #238). The MCP server
    // falls back to ${homedir()}/.argent/mcp-calls.log at runtime.
    expect(entry.env).toBeUndefined();
  });

  it("defaults to the global command when no mode is passed", () => {
    expect(getMcpEntry({ kind: "global" })).toEqual({ command: "argent", args: ["mcp"] });
  });

  it("local-node runs `node <relative bin path> mcp`", () => {
    expect(
      getMcpEntry({ kind: "local-node", binRelPath: "node_modules/@swmansion/argent/dist/cli.js" })
    ).toEqual({
      command: "node",
      args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"],
    });
  });

  it("local-pnp runs `yarn argent mcp`", () => {
    expect(getMcpEntry({ kind: "local-pnp" })).toEqual({
      command: "yarn",
      args: ["argent", "mcp"],
    });
  });

  it("local-npx runs `npx --no-install argent mcp` (never bare npx / -y)", () => {
    expect(getMcpEntry({ kind: "local-npx" })).toEqual({
      command: "npx",
      args: ["--no-install", "argent", "mcp"],
    });
  });

  it("local entries carry no env block", () => {
    expect(getMcpEntry({ kind: "local-node", binRelPath: "x" }).env).toBeUndefined();
    expect(getMcpEntry({ kind: "local-pnp" }).env).toBeUndefined();
  });
});

// ── resolveLocalCommandMode ─────────────────────────────────────────────────

describe("resolveLocalCommandMode", () => {
  function stageLocalArgent(root: string): void {
    const pkgDir = path.join(root, "node_modules", "@swmansion", "argent", "dist");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "@swmansion", "argent", "package.json"),
      JSON.stringify({
        name: "@swmansion/argent",
        version: "1.0.0",
        bin: { argent: "dist/cli.js" },
      })
    );
    fs.writeFileSync(path.join(pkgDir, "cli.js"), "");
  }

  it("returns local-pnp for a Yarn PnP project", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    expect(resolveLocalCommandMode(tmpDir)).toEqual({ kind: "local-pnp" });
  });

  it("returns local-node with the resolved bin path when installed", () => {
    stageLocalArgent(tmpDir);
    expect(resolveLocalCommandMode(tmpDir)).toEqual({
      kind: "local-node",
      binRelPath: "node_modules/@swmansion/argent/dist/cli.js",
    });
  });

  it("falls back to local-npx when the bin can't be resolved", () => {
    expect(resolveLocalCommandMode(tmpDir)).toEqual({ kind: "local-npx" });
  });

  it("opencode writes the local-node entry as a command array", () => {
    const adapter = ALL_ADAPTERS.find((a) => a.name === "opencode")!;
    const configPath = path.join(tmpDir, "opencode.json");
    adapter.write(
      configPath,
      getMcpEntry({ kind: "local-node", binRelPath: "node_modules/@swmansion/argent/dist/cli.js" })
    );
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcp: { argent: { command: string[]; type: string; enabled: boolean } };
    };
    expect(cfg.mcp.argent.command).toEqual([
      "node",
      "node_modules/@swmansion/argent/dist/cli.js",
      "mcp",
    ]);
    expect(cfg.mcp.argent.type).toBe("local");
    expect(cfg.mcp.argent.enabled).toBe(true);
  });
});

// ── Adapter registry ──────────────────────────────────────────────────────────

describe("ALL_ADAPTERS", () => {
  it("contains all ten adapters", () => {
    const names = ALL_ADAPTERS.map((a) => a.name);
    expect(names).toEqual([
      "Cursor",
      "Claude Code",
      "VS Code",
      "Windsurf",
      "Zed",
      "Gemini",
      "Codex",
      "Hermes",
      "opencode",
      "Kiro",
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
    expect(fs.existsSync(configPath)).toBe(false);
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
    expect(fs.existsSync(configPath)).toBe(false);
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
    expect(fs.existsSync(configPath)).toBe(false);
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
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("globalPath returns ~/.config/zed/settings.json", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".config", "zed", "settings.json"));
  });

  // Zed's settings.json is JSONC. The plain JSON.parse → mutate → JSON.stringify
  // round-trip used elsewhere strips every // and /* */ comment, plus trailing
  // commas. The Zed adapter goes through editJsoncFile so user-authored
  // formatting outside the touched key survives byte-for-byte.
  it("preserves user comments and trailing commas across write/remove", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = `{
  // Theme
  "theme": "One Dark",
  /* fonts */
  "buffer_font_size": 14,
}
`;
    fs.writeFileSync(configPath, original);

    adapter.write(configPath, getMcpEntry());
    let after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("// Theme");
    expect(after).toContain("/* fonts */");
    expect(after).toContain('"buffer_font_size": 14');
    // The trailing comma after the last user key must still be present.
    expect(after).toMatch(/14,\s*\n/);
    // And the argent entry actually got written.
    expect(readJsoncFile(configPath).context_servers).toHaveProperty("argent");

    expect(adapter.remove(configPath)).toBe(true);
    after = fs.readFileSync(configPath, "utf8");
    // Comments stay after we leave again.
    expect(after).toContain("// Theme");
    expect(after).toContain("/* fonts */");
    // context_servers wrapper was empty after removing argent and got pruned.
    expect(readJsoncFile(configPath)).not.toHaveProperty("context_servers");
  });

  it("removes the file when only the argent key was present", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    adapter.write(configPath, getMcpEntry());
    // No user keys, just our entry — remove() should clean up the file.
    expect(adapter.remove(configPath)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("addAllowlist/removeAllowlist round-trip preserves comments", () => {
    const configPath = path.join(tmpDir, ".zed", "settings.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      `{
  // user note
  "theme": "Solarized"
}
`
    );

    adapter.addAllowlist!(tmpDir, "local");
    let after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("// user note");
    expect((readJsoncFile(configPath).agent as Record<string, unknown>).tool_permissions).toEqual({
      default: "allow",
    });

    adapter.removeAllowlist!(tmpDir, "local");
    after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("// user note");
    expect((readJsoncFile(configPath).agent as Record<string, unknown>).tool_permissions).toEqual({
      default: "confirm",
    });
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
    expect(fs.existsSync(configPath)).toBe(false);
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
    expect(fs.existsSync(configPath)).toBe(false);
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

  it("addAllowlist writes approval_mode per tool under mcp_servers.argent.tools (local)", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "local");

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("[mcp_servers.argent.tools.tool-a]");
    expect(content).toContain("[mcp_servers.argent.tools.tool-b]");
    expect(content).toContain("[mcp_servers.argent.tools.tool-c]");
    expect(content).toContain('approval_mode = "approve"');
  });

  it("addAllowlist works with global scope", () => {
    homedirOverride = path.join(tmpDir, "home");
    const configPath = path.join(homedirOverride, ".codex", "config.toml");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "global");

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("[mcp_servers.argent.tools.tool-a]");
  });

  it("addAllowlist preserves the existing argent entry", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "local");

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain('command = "argent"');
  });

  it("removeAllowlist deletes tool entries added by addAllowlist", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    adapter.write(configPath, getMcpEntry());
    adapter.addAllowlist!(tmpDir, "local");

    adapter.removeAllowlist!(tmpDir, "local");

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).not.toContain("[mcp_servers.argent.tools.tool-a]");
    expect(content).not.toContain("[mcp_servers.argent.tools.tool-b]");
    expect(content).not.toContain("[mcp_servers.argent.tools.tool-c]");
    expect(content).toContain('command = "argent"');
  });

  it("removeAllowlist is a no-op when no tools section exists", () => {
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    adapter.write(configPath, getMcpEntry());

    expect(() => adapter.removeAllowlist!(tmpDir, "local")).not.toThrow();
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain('command = "argent"');
  });
});

// ── Hermes adapter ──────────────────────────────────────────────────────────

describe("Hermes adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Hermes")!;

  it("writes YAML format with mcp_servers key", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    adapter.write(configPath, getMcpEntry());

    const config = readYamlFile(configPath);
    const servers = config.mcp_servers as Record<string, unknown>;
    expect(servers).toHaveProperty("argent");
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.command).toBe("argent");
    expect(argent.args).toEqual(["mcp"]);
    // No env field unless the entry explicitly carries env vars (issue #238).
    expect(argent).not.toHaveProperty("env");
  });

  it("removes argent entry and drops empty mcp_servers", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    const config = readYamlFile(configPath);
    expect(config).not.toHaveProperty("mcp_servers");
  });

  it("returns false when removing from non-existent file", () => {
    expect(adapter.remove(path.join(tmpDir, "nope.yaml"))).toBe(false);
  });

  it("returns false when removing from file without argent entry", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "mcp_servers: {}\n");

    expect(adapter.remove(configPath)).toBe(false);
  });

  it("preserves other config and servers when writing", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "model: test\nmcp_servers:\n  other:\n    command: other\n");

    adapter.write(configPath, getMcpEntry());

    const config = readYamlFile(configPath);
    expect(config.model).toBe("test");
    const servers = config.mcp_servers as Record<string, unknown>;
    expect(servers).toHaveProperty("other");
    expect(servers).toHaveProperty("argent");
  });

  it("projectPath returns null", () => {
    expect(adapter.projectPath("/foo")).toBeNull();
  });

  it("globalPath returns path in homedir", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".hermes", "config.yaml"));
  });

  it("preserves comments on write", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "# top-of-file comment",
        "model:",
        "  default: claude-opus-4-6 # inline comment",
        "  provider: anthropic",
        "# section comment",
        "agent:",
        "  max_turns: 90",
        "",
      ].join("\n")
    );

    adapter.write(configPath, getMcpEntry());

    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("# top-of-file comment");
    expect(after).toContain("# inline comment");
    expect(after).toContain("# section comment");
    const config = readYamlFile(configPath);
    expect(config.mcp_servers as Record<string, unknown>).toHaveProperty("argent");
    expect((config.model as Record<string, unknown>).default).toBe("claude-opus-4-6");
  });

  it("preserves comments around other keys on remove", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        "# header",
        "model:",
        "  default: claude-opus-4-6",
        "mcp_servers:",
        "  argent:",
        "    command: argent",
        "    args:",
        "      - mcp",
        "    env: {}",
        "  filesystem:",
        "    command: npx # keep me",
        "",
      ].join("\n")
    );

    expect(adapter.remove(configPath)).toBe(true);

    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("# header");
    expect(after).toContain("# keep me");
    const config = readYamlFile(configPath);
    expect(config.mcp_servers as Record<string, unknown>).toHaveProperty("filesystem");
    expect(config.mcp_servers as Record<string, unknown>).not.toHaveProperty("argent");
  });

  it("throws when config.yaml is malformed instead of silently overwriting", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const bogus = "model:\n  default: [unbalanced\nagent: : :\n";
    fs.writeFileSync(configPath, bogus);

    expect(() => adapter.write(configPath, getMcpEntry())).toThrow(/Failed to parse YAML/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(bogus);
  });

  it("throws when mcp_servers is a sequence instead of silently no-op", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "mcp_servers:\n  - foo\n  - bar\n");

    expect(() => adapter.write(configPath, getMcpEntry())).toThrow(/not a YAML mapping/);
  });

  it("handles mcp_servers explicitly null", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "model: test\nmcp_servers:\n");

    adapter.write(configPath, getMcpEntry());

    const config = readYamlFile(configPath);
    expect(config.model).toBe("test");
    expect(config.mcp_servers as Record<string, unknown>).toHaveProperty("argent");
  });

  it("write is idempotent", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    adapter.write(configPath, getMcpEntry());
    const first = fs.readFileSync(configPath, "utf8");
    adapter.write(configPath, getMcpEntry());
    const second = fs.readFileSync(configPath, "utf8");
    expect(second).toBe(first);
  });

  it("creates ~/.hermes/config.yaml when neither file nor directory exists", () => {
    const configPath = path.join(tmpDir, ".hermes-fresh", "config.yaml");
    expect(fs.existsSync(path.dirname(configPath))).toBe(false);

    adapter.write(configPath, getMcpEntry());

    expect(fs.existsSync(configPath)).toBe(true);
    const config = readYamlFile(configPath);
    expect(config.mcp_servers as Record<string, unknown>).toHaveProperty("argent");
  });

  it("does not hard-wrap long user strings (lineWidth disabled)", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const longLine =
      "You are a kawaii assistant! Use cute expressions and be super enthusiastic about everything! Every response should feel warm and adorable.";
    fs.writeFileSync(configPath, `agent:\n  personalities:\n    kawaii: "${longLine}"\n`);

    adapter.write(configPath, getMcpEntry());

    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain(longLine);
    // The full long string must remain on a single content line — the yaml
    // library would wrap at column 80 by default.
    const kawaiiLine = after.split("\n").find((l) => l.includes("kawaii:"));
    expect(kawaiiLine).toBeDefined();
    expect(kawaiiLine!.length).toBeGreaterThan(80);
  });

  it("write+remove on a realistic seed is semantically lossless", () => {
    const configPath = path.join(tmpDir, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const seed = [
      "# managed by hermes",
      "model:",
      "  default: claude-opus-4-6 # selected via hermes model",
      "  provider: anthropic",
      "providers: {}",
      "fallback_providers: []",
      "toolsets:",
      "  - hermes-cli",
      "agent:",
      "  max_turns: 90",
      "  personalities:",
      '    helpful: "You are a helpful assistant."',
      '    kawaii: "You are a kawaii assistant! Use cute expressions and be super enthusiastic."',
      "terminal:",
      "  backend: local",
      "",
    ].join("\n");
    fs.writeFileSync(configPath, seed);
    const before = readYamlFile(configPath);

    adapter.write(configPath, getMcpEntry());
    expect(adapter.remove(configPath)).toBe(true);

    const after = fs.readFileSync(configPath, "utf8");
    const afterParsed = readYamlFile(configPath);
    // Semantic check: parsed JS should equal the original parsed JS
    expect(JSON.stringify(afterParsed)).toBe(JSON.stringify(before));
    // Every comment line in the seed must still be in the output
    const seedComments = seed.split("\n").filter((l) => l.includes("#"));
    for (const c of seedComments) {
      const stripped = c.trim();
      expect(after).toContain(stripped);
    }
  });
});

// ── opencode adapter ────────────────────────────────────────────────────────

describe("opencode adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "opencode")!;

  it("writes { mcp: { argent: { type: 'local', command: [...] } } }", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcp as Record<string, unknown>;
    expect(servers).toHaveProperty("argent");
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.type).toBe("local");
    expect(argent.command).toEqual(["argent", "mcp"]);
    expect(argent.enabled).toBe(true);
    // No environment field unless the entry explicitly carries env vars
    // (issue #238).
    expect(argent).not.toHaveProperty("environment");
  });

  it("removes argent entry and returns true", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("returns false when removing from non-existent file", () => {
    expect(adapter.remove(path.join(tmpDir, "nope.json"))).toBe(false);
  });

  it("returns false when removing from file without argent entry", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcp: {} }));
    expect(adapter.remove(configPath)).toBe(false);
  });

  it("preserves other servers and unrelated settings when writing", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcp: { "other-tool": { type: "local", command: ["npx", "other"] } },
        theme: "dark",
      })
    );

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcp as Record<string, unknown>;
    expect(servers).toHaveProperty("other-tool");
    expect(servers).toHaveProperty("argent");
    expect(config.theme).toBe("dark");
  });

  it("projectPath returns opencode.json at project root", () => {
    expect(adapter.projectPath("/foo")).toBe(path.join("/foo", "opencode.json"));
  });

  it("globalPath returns ~/.config/opencode/opencode.json", () => {
    expect(adapter.globalPath()).toBe(
      path.join(os.homedir(), ".config", "opencode", "opencode.json")
    );
  });

  it("projectPath prefers existing opencode.jsonc over default opencode.json", () => {
    const jsoncPath = path.join(tmpDir, "opencode.jsonc");
    fs.writeFileSync(jsoncPath, "{}");
    expect(adapter.projectPath(tmpDir)).toBe(jsoncPath);
  });

  it("projectPath falls back to opencode.json when no candidate exists", () => {
    expect(adapter.projectPath(tmpDir)).toBe(path.join(tmpDir, "opencode.json"));
  });

  it("globalPath returns legacy config.json when it is the only candidate", () => {
    homedirOverride = path.join(tmpDir, "home");
    const opencodeDir = path.join(homedirOverride, ".config", "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    const configJsonPath = path.join(opencodeDir, "config.json");
    fs.writeFileSync(configJsonPath, "{}");
    expect(adapter.globalPath()).toBe(configJsonPath);
  });

  // Mirrors opencode's own globalConfigFile() precedence so the file argent
  // writes is the same one opencode treats as authoritative.
  it("globalPath prefers opencode.jsonc over opencode.json over config.json", () => {
    homedirOverride = path.join(tmpDir, "home");
    const opencodeDir = path.join(homedirOverride, ".config", "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(opencodeDir, "config.json"), "{}");
    fs.writeFileSync(path.join(opencodeDir, "opencode.json"), "{}");
    fs.writeFileSync(path.join(opencodeDir, "opencode.jsonc"), "{}");
    expect(adapter.globalPath()).toBe(path.join(opencodeDir, "opencode.jsonc"));
  });

  it("globalPath prefers opencode.json over config.json when .jsonc is absent", () => {
    homedirOverride = path.join(tmpDir, "home");
    const opencodeDir = path.join(homedirOverride, ".config", "opencode");
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(opencodeDir, "config.json"), "{}");
    fs.writeFileSync(path.join(opencodeDir, "opencode.json"), "{}");
    expect(adapter.globalPath()).toBe(path.join(opencodeDir, "opencode.json"));
  });

  it("globalPath falls back to opencode.json when no candidate exists", () => {
    homedirOverride = path.join(tmpDir, "home");
    expect(adapter.globalPath()).toBe(
      path.join(homedirOverride, ".config", "opencode", "opencode.json")
    );
  });

  it("addAllowlist sets 'argent*' wildcard in tools (local)", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "local");

    const config = readJsonFile(configPath);
    const tools = config.tools as Record<string, unknown>;
    expect(tools["argent*"]).toBe(true);
  });

  it("addAllowlist sets 'argent*' wildcard in tools (global)", () => {
    homedirOverride = path.join(tmpDir, "home");
    const configPath = path.join(homedirOverride, ".config", "opencode", "opencode.json");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "global");

    const config = readJsonFile(configPath);
    const tools = config.tools as Record<string, unknown>;
    expect(tools["argent*"]).toBe(true);
  });

  it("removeAllowlist deletes the 'argent*' entry", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    adapter.write(configPath, getMcpEntry());
    adapter.addAllowlist!(tmpDir, "local");

    adapter.removeAllowlist!(tmpDir, "local");

    const config = readJsonFile(configPath);
    const tools = config.tools as Record<string, unknown> | undefined;
    expect(tools?.["argent*"]).toBeUndefined();
  });

  it("removeAllowlist is a no-op when file does not exist", () => {
    expect(() => adapter.removeAllowlist!(tmpDir, "local")).not.toThrow();
  });

  it("preserves other tools entries when adding allowlist", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: {}, tools: { "other-mcp*": true, "write": "ask" } })
    );

    adapter.addAllowlist!(tmpDir, "local");

    const config = readJsonFile(configPath);
    const tools = config.tools as Record<string, unknown>;
    expect(tools["other-mcp*"]).toBe(true);
    expect(tools.write).toBe("ask");
    expect(tools["argent*"]).toBe(true);
  });

  // opencode supports both opencode.json (strict JSON) and opencode.jsonc
  // (with comments + trailing commas). Going through editJsoncFile means
  // user-authored comments survive write/remove the same way they do for Zed.
  it("preserves user comments when writing into opencode.jsonc", () => {
    const configPath = path.join(tmpDir, "opencode.jsonc");
    const original = `{
  // top-of-file comment
  "theme": "opencode-dark",
  /* trailing block comment */
}
`;
    fs.writeFileSync(configPath, original);

    adapter.write(configPath, getMcpEntry());

    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain("// top-of-file comment");
    expect(after).toContain("/* trailing block comment */");
    expect(after).toContain('"theme": "opencode-dark"');

    const parsed = readJsoncFile(configPath);
    const servers = parsed.mcp as Record<string, unknown>;
    expect(servers).toHaveProperty("argent");
    expect((servers.argent as Record<string, unknown>).type).toBe("local");
  });
});

// ── Kiro adapter ─────────────────────────────────────────────────────────────

describe("Kiro adapter", () => {
  const adapter = ALL_ADAPTERS.find((a) => a.name === "Kiro")!;

  afterEach(() => {
    homedirOverride = undefined;
  });

  it("writes { mcpServers: { argent: ... } } without type", () => {
    const configPath = path.join(tmpDir, ".kiro", "settings", "mcp.json");
    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("argent");
    const argent = servers.argent as Record<string, unknown>;
    expect(argent.command).toBe("argent");
    expect(argent.args).toEqual(["mcp"]);
    expect(argent).not.toHaveProperty("type");
  });

  it("removes argent entry and returns true", () => {
    const configPath = path.join(tmpDir, ".kiro", "settings", "mcp.json");
    adapter.write(configPath, getMcpEntry());

    expect(adapter.remove(configPath)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("returns false when removing from non-existent file", () => {
    expect(adapter.remove(path.join(tmpDir, "nope.json"))).toBe(false);
  });

  it("returns false when removing from file without argent entry", () => {
    const configPath = path.join(tmpDir, ".kiro", "settings", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    expect(adapter.remove(configPath)).toBe(false);
  });

  it("preserves other servers when writing", () => {
    const configPath = path.join(tmpDir, ".kiro", "settings", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "other" } } }));

    adapter.write(configPath, getMcpEntry());

    const config = readJsonFile(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("other");
    expect(servers).toHaveProperty("argent");
  });

  it("projectPath returns .kiro/settings/mcp.json under project root", () => {
    expect(adapter.projectPath("/foo")).toBe(path.join("/foo", ".kiro", "settings", "mcp.json"));
  });

  it("globalPath returns ~/.kiro/settings/mcp.json", () => {
    expect(adapter.globalPath()).toBe(path.join(os.homedir(), ".kiro", "settings", "mcp.json"));
  });

  it("detect() returns true when local .kiro dir exists", () => {
    const localKiro = path.join(process.cwd(), ".kiro");
    const existed = fs.existsSync(localKiro);
    if (!existed) fs.mkdirSync(localKiro, { recursive: true });
    try {
      expect(adapter.detect()).toBe(true);
    } finally {
      if (!existed) fs.rmdirSync(localKiro);
    }
  });

  it("addAllowlist sets autoApprove: ['*'] on the argent entry (local)", () => {
    const configPath = path.join(tmpDir, ".kiro", "settings", "mcp.json");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "local");

    const config = readJsonFile(configPath);
    const entry = (config.mcpServers as Record<string, unknown>).argent as Record<string, unknown>;
    expect(entry.autoApprove).toEqual(["*"]);
  });

  it("addAllowlist sets autoApprove: ['*'] on the argent entry (global)", () => {
    homedirOverride = path.join(tmpDir, "home");
    const configPath = path.join(homedirOverride, ".kiro", "settings", "mcp.json");
    adapter.write(configPath, getMcpEntry());

    adapter.addAllowlist!(tmpDir, "global");

    const config = readJsonFile(configPath);
    const entry = (config.mcpServers as Record<string, unknown>).argent as Record<string, unknown>;
    expect(entry.autoApprove).toEqual(["*"]);
  });

  it("removeAllowlist deletes autoApprove from the argent entry", () => {
    const configPath = path.join(tmpDir, ".kiro", "settings", "mcp.json");
    adapter.write(configPath, getMcpEntry());
    adapter.addAllowlist!(tmpDir, "local");

    adapter.removeAllowlist!(tmpDir, "local");

    const config = readJsonFile(configPath);
    const entry = (config.mcpServers as Record<string, unknown>).argent as Record<string, unknown>;
    expect(entry).not.toHaveProperty("autoApprove");
  });

  it("removeAllowlist is a no-op when file does not exist", () => {
    expect(() => adapter.removeAllowlist!(tmpDir, "local")).not.toThrow();
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
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it("removeClaudePermission is a no-op when file does not exist", () => {
    expect(() => removeClaudePermission(tmpDir, "local")).not.toThrow();
  });
});

// ── copyRulesAndAgents ────────────────────────────────────────────────────────

describe("getManagedContentTargets", () => {
  afterEach(() => {
    homedirOverride = undefined;
  });

  it("derives local managed paths from adapter definitions", () => {
    const adapters = ALL_ADAPTERS.filter((a) =>
      ["Claude Code", "Cursor", "Gemini", "Codex"].includes(a.name)
    );

    const targets = getManagedContentTargets(adapters, tmpDir, "local");

    expect(targets.skillTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining([".claude/skills", ".cursor/skills", ".agents/skills"])
    );
    expect(targets.ruleTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining([".claude/rules", ".cursor/rules", ".gemini/rules"])
    );
    expect(targets.agentTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining([".claude/agents", ".gemini/agents"])
    );
    expect(targets.codexConfigTargets.map((t) => t.label)).toEqual([".codex/config.toml"]);
    expect(targets.skillsLockTargets.map((t) => t.label)).toEqual(["skills-lock.json"]);
  });

  it("derives global managed paths from adapter definitions", () => {
    homedirOverride = path.join(tmpDir, "home");
    const adapters = ALL_ADAPTERS.filter((a) =>
      ["Claude Code", "Cursor", "Gemini", "Codex"].includes(a.name)
    );

    const targets = getManagedContentTargets(adapters, tmpDir, "global");

    expect(targets.skillTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining(["~/.claude/skills", "~/.cursor/skills", "~/.agents/skills"])
    );
    expect(targets.ruleTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining(["~/.claude/rules", "~/.cursor/rules", "~/.gemini/rules"])
    );
    expect(targets.agentTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining(["~/.claude/agents", "~/.gemini/agents"])
    );
    expect(targets.codexConfigTargets.map((t) => t.label)).toEqual(["~/.codex/config.toml"]);
    expect(targets.skillsLockTargets.map((t) => t.label)).toEqual(["~/skills-lock.json"]);
  });

  it("routes opencode skills/agents under .opencode (local)", () => {
    const adapters = ALL_ADAPTERS.filter((a) => a.name === "opencode");
    const targets = getManagedContentTargets(adapters, tmpDir, "local");

    expect(targets.skillTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining([".opencode/skills"])
    );
    expect(targets.agentTargets.map((t) => t.label)).toEqual([".opencode/agents"]);
    expect(targets.ruleTargets).toEqual([]);
  });

  it("routes opencode skills/agents under ~/.config/opencode (global)", () => {
    homedirOverride = path.join(tmpDir, "home");
    const adapters = ALL_ADAPTERS.filter((a) => a.name === "opencode");
    const targets = getManagedContentTargets(adapters, tmpDir, "global");

    expect(targets.skillTargets.map((t) => t.label)).toEqual(
      expect.arrayContaining(["~/.config/opencode/skills"])
    );
    expect(targets.agentTargets.map((t) => t.label)).toEqual(["~/.config/opencode/agents"]);
  });
});

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

  it("injects Codex rules into developer_instructions in config.toml (local)", () => {
    const codexAdapter = ALL_ADAPTERS.find((a) => a.name === "Codex")!;
    // Pre-create the config.toml so the adapter can find it
    const configPath = path.join(tmpDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "");

    const results = copyRulesAndAgents([codexAdapter], tmpDir, "local", rulesDir, agentsDir);
    expect(results.some((r) => r.includes("developer_instructions"))).toBe(true);
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("argent rules");
    expect(content).toContain("developer_instructions");
  });
});

// ── Codex developer_instructions injection ──────────────────────────────────

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

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("Use argent tools for simulator control.");
    expect(content).not.toContain("alwaysApply");
    expect(content).toContain("argent rules");
  });

  it("preserves existing developer_instructions", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, 'developer_instructions = "Always use TypeScript."\n');

    injectCodexRules(configPath, rulesDir);

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("Always use TypeScript.");
    expect(content).toContain("Use argent tools for simulator control.");
  });

  it("replaces existing argent section on re-inject", () => {
    const configPath = path.join(tmpDir, "config.toml");
    injectCodexRules(configPath, rulesDir);

    // Update rule content and re-inject
    fs.writeFileSync(path.join(rulesDir, "argent.md"), "Updated rule content.");
    injectCodexRules(configPath, rulesDir);

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("Updated rule content.");
    expect(content).not.toContain("Use argent tools for simulator control.");
    // Should only have one pair of markers
    expect(content.split("argent rules").length - 1).toBe(2); // start + end
  });

  it("removeCodexRules strips argent section", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, 'developer_instructions = "Always use TypeScript."\n');
    injectCodexRules(configPath, rulesDir);

    const removed = removeCodexRules(configPath);
    expect(removed).toBe(true);

    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("Always use TypeScript.");
    expect(content).not.toContain("argent rules");
  });

  it("removeCodexRules deletes field when only argent content remains", () => {
    const configPath = path.join(tmpDir, "config.toml");
    injectCodexRules(configPath, rulesDir);

    removeCodexRules(configPath);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("removeCodexRules returns false when no argent section exists", () => {
    const configPath = path.join(tmpDir, "config.toml");
    fs.writeFileSync(configPath, 'model = "o3"\n');
    expect(removeCodexRules(configPath)).toBe(false);
  });

  it("removeCodexRules returns false for non-existent file", () => {
    expect(removeCodexRules(path.join(tmpDir, "nope.toml"))).toBe(false);
  });

  it("returns null when rulesDir does not exist", () => {
    const configPath = path.join(tmpDir, "config.toml");
    expect(injectCodexRules(configPath, path.join(tmpDir, "nonexistent"))).toBeNull();
  });
});

// ── hasArgentEntry / findConfiguredAdapterScopes ─────────────────────────────
// Regression for issue #195: `update` must not (re)create configs for
// editors the user opted out of during `init`, even when their config dir
// exists on disk. The signal is the argent MCP entry in the config file,
// not the editor dir's presence.

describe("hasArgentEntry — non-mutating per-adapter predicate", () => {
  // Pin homedir into tmpDir so global-only adapters (projectPath === null)
  // resolve globalPath() inside the sandbox. Without this, the rmSync below
  // would delete the developer's real Windsurf/Hermes config.
  beforeEach(() => {
    homedirOverride = tmpDir;
  });

  afterEach(() => {
    homedirOverride = undefined;
  });

  for (const adapter of ALL_ADAPTERS) {
    describe(adapter.name, () => {
      it("returns false when the config file does not exist", () => {
        const configPath =
          adapter.projectPath(tmpDir) ?? adapter.globalPath() ?? path.join(tmpDir, "nope");
        // Adapter-provided paths point into tmpDir for project / homedir for
        // global; the test's only invariant is "file doesn't exist yet".
        if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
        expect(adapter.hasArgentEntry(configPath)).toBe(false);
      });

      it("returns true after write(), false after remove()", () => {
        const configPath = adapter.projectPath(tmpDir);
        if (!configPath) return; // global-only adapter — covered by sibling test below
        adapter.write(configPath, getMcpEntry());
        expect(adapter.hasArgentEntry(configPath)).toBe(true);

        adapter.remove(configPath);
        expect(adapter.hasArgentEntry(configPath)).toBe(false);
      });
    });
  }
});

describe("findConfiguredAdapterScopes", () => {
  beforeEach(() => {
    homedirOverride = tmpDir;
  });

  afterEach(() => {
    homedirOverride = undefined;
  });

  it("returns empty when no adapter has argent configured", () => {
    const projectRoot = path.join(tmpDir, "project");
    fs.mkdirSync(projectRoot, { recursive: true });
    // Create the editor dirs without any argent entry to simulate the
    // issue #195 scenario: the user has gemini installed on their machine
    // but never opted argent into it.
    fs.mkdirSync(path.join(projectRoot, ".gemini"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".gemini"), { recursive: true });

    expect(findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot)).toEqual([]);
  });

  it("returns only adapters with an argent entry, not all detected editor dirs", () => {
    const projectRoot = path.join(tmpDir, "project");
    fs.mkdirSync(projectRoot, { recursive: true });

    // Gemini: editor present on disk but argent NOT configured.
    fs.mkdirSync(path.join(tmpDir, ".gemini"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { other: { command: "other" } } })
    );

    // Cursor: argent configured globally (the only scope we should refresh).
    const cursor = ALL_ADAPTERS.find((a) => a.name === "Cursor")!;
    cursor.write(cursor.globalPath()!, getMcpEntry());

    const result = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);
    expect(result.map((r) => `${r.adapter.name}:${r.scope}`)).toEqual(["Cursor:global"]);
  });

  it("returns both scopes when argent is configured in project and global", () => {
    const projectRoot = path.join(tmpDir, "project");
    fs.mkdirSync(projectRoot, { recursive: true });

    const claude = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;
    claude.write(claude.projectPath(projectRoot)!, getMcpEntry());
    claude.write(claude.globalPath()!, getMcpEntry());

    const result = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);
    expect(result.map((r) => `${r.adapter.name}:${r.scope}`).sort()).toEqual([
      "Claude Code:global",
      "Claude Code:project",
    ]);
  });

  it("skips a malformed config instead of aborting detection", () => {
    const projectRoot = path.join(tmpDir, "project");
    fs.mkdirSync(projectRoot, { recursive: true });

    // Hermes' hasArgentEntry parses YAML and throws on broken input. A single
    // unparseable config must not take down detection for every other adapter
    // (regression: it previously propagated out of update()).
    const hermes = ALL_ADAPTERS.find((a) => a.name === "Hermes")!;
    const hermesPath = hermes.globalPath()!;
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    fs.writeFileSync(hermesPath, "mcp_servers: : not: valid: yaml\n  - broken");

    // A properly configured adapter alongside the broken one.
    const claude = ALL_ADAPTERS.find((a) => a.name === "Claude Code")!;
    claude.write(claude.globalPath()!, getMcpEntry());

    let result: ReturnType<typeof findConfiguredAdapterScopes> = [];
    expect(() => {
      result = findConfiguredAdapterScopes(ALL_ADAPTERS, projectRoot);
    }).not.toThrow();
    expect(result.map((r) => `${r.adapter.name}:${r.scope}`)).toContain("Claude Code:global");
    expect(result.map((r) => r.adapter.name)).not.toContain("Hermes");
  });
});

// ── Portability: generated configs must not embed absolute home paths ───────
// Regression coverage for issue #238 — every adapter must produce a config
// that can be checked into git and shared with collaborators on different
// machines.

describe("generated configs are portable across machines (issue #238)", () => {
  function readTextFile(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
  }

  // Pin homedir to a fake user path so we can scan written configs for the
  // literal `/Users/...` segment without false positives from the test
  // runner's real homedir.
  const fakeHome = "/Users/pretend-user";

  beforeEach(() => {
    homedirOverride = fakeHome;
  });

  afterEach(() => {
    homedirOverride = undefined;
  });

  it("no adapter writes an absolute home path into the config", () => {
    for (const adapter of ALL_ADAPTERS) {
      // Use each adapter's own project path so we exercise its real write
      // logic (file extension, key layout) without faking paths.
      const configPath =
        adapter.projectPath(tmpDir) ??
        // Windsurf / Hermes are global-only; route the write into tmp.
        path.join(tmpDir, adapter.name.replace(/\s+/g, "-"), "config");

      adapter.write(configPath, getMcpEntry());
      const written = readTextFile(configPath);
      expect(written, `${adapter.name} embedded a home path: ${written}`).not.toContain(fakeHome);
      expect(written).not.toContain("ARGENT_MCP_LOG");
    }
  });

  it("each adapter still honors env vars when the entry carries them", () => {
    const customEntry = { ...getMcpEntry(), env: { FOO: "bar" } };

    for (const adapter of ALL_ADAPTERS) {
      const configPath =
        adapter.projectPath(tmpDir) ??
        path.join(tmpDir, adapter.name.replace(/\s+/g, "-"), "config");
      adapter.write(configPath, customEntry);
      const written = readTextFile(configPath);
      expect(written, `${adapter.name} dropped a supplied env var`).toContain("FOO");
      expect(written).toContain("bar");
    }
  });
});
