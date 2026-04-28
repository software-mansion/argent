import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ALL_ADAPTERS,
  getMcpEntry,
  addClaudePermission,
  removeClaudePermission,
} from "../src/mcp-configs.js";
import { readToml } from "../src/utils.js";
import {
  cleanupSkillsLockFile,
  getBundledSkillNames,
  removeBundledContent,
  removeBundledSkillInstalls,
} from "../src/uninstall.js";

let tmpDir: string;

function readConfigFile(filePath: string): Record<string, unknown> {
  if (filePath.endsWith(".toml")) return readToml(filePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeFile(filePath: string, contents = "test"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
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
      expect(fs.existsSync(configPath)).toBe(false);
    });
  }

  it("handles removal from non-existent files gracefully", () => {
    for (const adapter of ALL_ADAPTERS) {
      expect(adapter.remove(path.join(tmpDir, "nonexistent.json"))).toBe(false);
    }
  });
});

// ── Permissions cleanup ───────────────────────────────────────────────────────

describe("uninstall — permissions cleanup", () => {
  it("removes mcp__argent permission when present", () => {
    addClaudePermission(tmpDir, "local");
    removeClaudePermission(tmpDir, "local");

    const settingsPath = path.join(tmpDir, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(false);
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

// ── Skills cleanup helpers ────────────────────────────────────────────────────

describe("uninstall — skills cleanup helpers", () => {
  it("discovers bundled skill names from frontmatter", () => {
    const skillsDir = path.join(tmpDir, "skills");

    writeFile(
      path.join(skillsDir, "argent-create-flow", "SKILL.md"),
      ["---", "name: argent-create-flow", "description: test", "---", "", "body"].join("\n")
    );
    writeFile(
      path.join(skillsDir, "argent-react-native-optimization", "SKILL.md"),
      [
        "---",
        'name: "argent-react-native-optimization"',
        "description: test",
        "---",
        "",
        "body",
      ].join("\n")
    );
    writeFile(path.join(skillsDir, "references", "guide.md"));

    expect(getBundledSkillNames(skillsDir)).toEqual([
      "argent-create-flow",
      "argent-react-native-optimization",
    ]);
  });

  it("removes installed skill entries by current skill names only", () => {
    const targetDir = path.join(tmpDir, ".claude", "skills");
    const storeDir = path.join(tmpDir, ".agents", "skills", "argent-create-flow");

    writeFile(path.join(storeDir, "SKILL.md"), "skill");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(
      path.relative(targetDir, path.join(tmpDir, ".agents", "skills", "argent-create-flow")),
      path.join(targetDir, "argent-create-flow")
    );
    writeFile(path.join(targetDir, "argent-react-native-optimization", "SKILL.md"), "argent");
    writeFile(path.join(targetDir, "react-native-optimization", "SKILL.md"), "unrelated");
    writeFile(path.join(targetDir, "vendor-skill", "SKILL.md"), "vendor");

    const result = removeBundledSkillInstalls(
      ["argent-create-flow", "argent-react-native-optimization"],
      targetDir
    );

    expect(result.removedPaths.sort()).toEqual([
      "argent-create-flow",
      "argent-react-native-optimization",
    ]);
    expect(fs.existsSync(path.join(targetDir, "argent-create-flow"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "argent-react-native-optimization"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "react-native-optimization"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "vendor-skill"))).toBe(true);
    expect(fs.existsSync(storeDir)).toBe(true);
  });

  it("removes only Argent entries from skills-lock.json", () => {
    const lockPath = path.join(tmpDir, "skills-lock.json");
    writeFile(
      lockPath,
      JSON.stringify(
        {
          version: 1,
          skills: {
            "argent-create-flow": { source: "argent" },
            "argent-react-native-optimization": { source: "argent" },
            "react-native-optimization": { source: "vendor" },
            "vendor-skill": { source: "vendor" },
          },
        },
        null,
        2
      )
    );

    const result = cleanupSkillsLockFile(lockPath, [
      "argent-create-flow",
      "argent-react-native-optimization",
    ]);

    expect(result).toEqual({
      removedSkills: ["argent-create-flow", "argent-react-native-optimization"],
      removedFile: false,
    });

    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(parsed.skills).toEqual({
      "react-native-optimization": { source: "vendor" },
      "vendor-skill": { source: "vendor" },
    });
  });

  it("deletes skills-lock.json when only Argent entries remain", () => {
    const lockPath = path.join(tmpDir, "skills-lock.json");
    writeFile(
      lockPath,
      JSON.stringify(
        {
          version: 1,
          skills: {
            "argent-create-flow": { source: "argent" },
          },
        },
        null,
        2
      )
    );

    const result = cleanupSkillsLockFile(lockPath, ["argent-create-flow"]);

    expect(result).toEqual({
      removedSkills: ["argent-create-flow"],
      removedFile: true,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ── Bundled content pruning ───────────────────────────────────────────────────

describe("uninstall — prune bundled content", () => {
  it("removes only Argent-owned files and keeps unrelated content", () => {
    const bundledDir = path.join(tmpDir, "bundled");
    const targetDir = path.join(tmpDir, ".claude", "agents");

    writeFile(path.join(bundledDir, "argent-environment-inspector.md"));
    writeFile(path.join(bundledDir, "references", "quality-control-checklist.md"));

    writeFile(path.join(targetDir, "argent-environment-inspector.md"), "argent");
    writeFile(path.join(targetDir, "other-vendor.md"), "vendor");
    writeFile(path.join(targetDir, "references", "quality-control-checklist.md"), "argent");
    writeFile(path.join(targetDir, "references", "vendor-checklist.md"), "vendor");
    writeFile(path.join(targetDir, "custom", "notes.md"), "user");

    const result = removeBundledContent(bundledDir, targetDir);

    expect(result.removedPaths.sort()).toEqual(
      [
        "argent-environment-inspector.md",
        path.join("references", "quality-control-checklist.md"),
      ].sort()
    );
    expect(result.removedRoot).toBe(false);

    expect(fs.existsSync(path.join(targetDir, "argent-environment-inspector.md"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "references", "quality-control-checklist.md"))).toBe(
      false
    );
    expect(fs.existsSync(path.join(targetDir, "other-vendor.md"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "references", "vendor-checklist.md"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "custom", "notes.md"))).toBe(true);
  });

  it("removes now-empty directories after deleting Argent content", () => {
    const bundledDir = path.join(tmpDir, "bundled");
    const targetDir = path.join(tmpDir, ".cursor", "rules");

    writeFile(path.join(bundledDir, "argent.md"));
    writeFile(path.join(bundledDir, "nested", "guide.md"));
    writeFile(path.join(targetDir, "argent.md"), "argent");
    writeFile(path.join(targetDir, "nested", "guide.md"), "argent");

    const result = removeBundledContent(bundledDir, targetDir);

    expect(result.removedPaths.sort()).toEqual(
      ["argent.md", path.join("nested", "guide.md")].sort()
    );
    expect(result.removedRoot).toBe(true);
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("handles missing source or target directories gracefully", () => {
    const result = removeBundledContent(path.join(tmpDir, "missing"), path.join(tmpDir, "target"));
    expect(result).toEqual({ removedPaths: [], removedRoot: false });
  });
});
