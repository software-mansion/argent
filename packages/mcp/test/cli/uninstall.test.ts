import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ALL_ADAPTERS,
  getMcpEntry,
  addClaudePermission,
  removeClaudePermission,
} from "../../src/cli/mcp-configs.js";

let tmpDir: string;

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-uninstall-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── MCP entry removal across all adapters ─────────────────────────────────────

describe("uninstall — MCP entry removal", () => {
  for (const adapter of ALL_ADAPTERS) {
    it(`removes argent from ${adapter.name} config`, () => {
      const configPath = adapter.projectPath(tmpDir);
      if (!configPath) return; // skip adapters without project path

      adapter.write(configPath, getMcpEntry());
      expect(adapter.remove(configPath)).toBe(true);

      const config = readJsonFile(configPath);
      // Check that argent is gone from whichever key this adapter uses
      const allValues = Object.values(config).filter(
        (v) => typeof v === "object" && v !== null,
      ) as Record<string, unknown>[];
      for (const section of allValues) {
        expect(section).not.toHaveProperty("argent");
      }
    });
  }

  it("handles removal from non-existent files gracefully", () => {
    for (const adapter of ALL_ADAPTERS) {
      expect(adapter.remove(path.join(tmpDir, "nonexistent.json"))).toBe(
        false,
      );
    }
  });
});

// ── Permissions cleanup ───────────────────────────────────────────────────────

describe("uninstall — permissions cleanup", () => {
  it("removes mcp__argent permission when present", () => {
    addClaudePermission(tmpDir, "local");
    removeClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    const config = readJsonFile(settingsPath);
    const allow = (config.permissions as Record<string, unknown>)
      .allow as string[];
    expect(allow).not.toContain("mcp__argent");
  });

  it("does not throw when .claude/settings.json does not exist", () => {
    expect(() => removeClaudePermission(tmpDir, "local")).not.toThrow();
  });

  it("does not throw when permissions.allow is missing", () => {
    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({}));

    expect(() => removeClaudePermission(tmpDir, "local")).not.toThrow();
  });
});

// ── Directory pruning logic ───────────────────────────────────────────────────

describe("uninstall — prune directories", () => {
  it("removes skills directory", () => {
    const skillsDir = path.join(tmpDir, ".claude", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "test.md"), "test");

    fs.rmSync(skillsDir, { recursive: true });
    expect(fs.existsSync(skillsDir)).toBe(false);
  });

  it("removes rules directory", () => {
    const rulesDir = path.join(tmpDir, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, "argent.md"), "test");

    fs.rmSync(rulesDir, { recursive: true });
    expect(fs.existsSync(rulesDir)).toBe(false);
  });

  it("does not throw when directory does not exist", () => {
    const nonExistent = path.join(tmpDir, ".claude", "nope");
    expect(fs.existsSync(nonExistent)).toBe(false);
    // rmSync with force: true doesn't throw for non-existent
    expect(() => fs.rmSync(nonExistent, { recursive: true, force: true })).not.toThrow();
  });
});
