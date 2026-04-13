import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readJson,
  writeJson,
  copyDir,
  dirExists,
  detectPackageManager,
  globalInstallCommand,
  globalUninstallCommand,
  formatShellCommand,
  isOnline,
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
} from "../../src/cli/utils.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-utils-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── readJson ──────────────────────────────────────────────────────────────────

describe("readJson", () => {
  it("returns empty object for non-existent file", () => {
    expect(readJson(path.join(tmpDir, "nope.json"))).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const file = path.join(tmpDir, "bad.json");
    fs.writeFileSync(file, "not json");
    expect(readJson(file)).toEqual({});
  });

  it("reads valid JSON", () => {
    const file = path.join(tmpDir, "ok.json");
    fs.writeFileSync(file, JSON.stringify({ foo: "bar" }));
    expect(readJson(file)).toEqual({ foo: "bar" });
  });
});

// ── writeJson ─────────────────────────────────────────────────────────────────

describe("writeJson", () => {
  it("creates parent directories", () => {
    const file = path.join(tmpDir, "a", "b", "c.json");
    writeJson(file, { x: 1 });
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ x: 1 });
  });

  it("overwrites existing files", () => {
    const file = path.join(tmpDir, "x.json");
    writeJson(file, { v: 1 });
    writeJson(file, { v: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ v: 2 });
  });

  it("pretty-prints with 2-space indent and trailing newline", () => {
    const file = path.join(tmpDir, "pretty.json");
    writeJson(file, { a: 1 });
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).toBe('{\n  "a": 1\n}\n');
  });
});

// ── copyDir ───────────────────────────────────────────────────────────────────

describe("copyDir", () => {
  it("returns false when source does not exist", () => {
    expect(copyDir(path.join(tmpDir, "nope"), path.join(tmpDir, "dest"))).toBe(false);
  });

  it("copies directory recursively", () => {
    const src = path.join(tmpDir, "src");
    const dest = path.join(tmpDir, "dest");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "hello");
    fs.writeFileSync(path.join(src, "sub", "b.txt"), "world");

    expect(copyDir(src, dest)).toBe(true);
    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("hello");
    expect(fs.readFileSync(path.join(dest, "sub", "b.txt"), "utf8")).toBe("world");
  });
});

// ── dirExists ─────────────────────────────────────────────────────────────────

describe("dirExists", () => {
  it("returns true for existing directory", () => {
    expect(dirExists(tmpDir)).toBe(true);
  });

  it("returns false for non-existent path", () => {
    expect(dirExists(path.join(tmpDir, "nope"))).toBe(false);
  });

  it("returns false for a file", () => {
    const file = path.join(tmpDir, "file.txt");
    fs.writeFileSync(file, "");
    expect(dirExists(file)).toBe(false);
  });
});

// ── detectPackageManager ──────────────────────────────────────────────────────

describe("detectPackageManager", () => {
  const original = process.env.npm_config_user_agent;

  afterEach(() => {
    if (original === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = original;
  });

  it("returns npm when agent is unset", () => {
    delete process.env.npm_config_user_agent;
    expect(detectPackageManager()).toBe("npm");
  });

  it("returns yarn for yarn agent", () => {
    process.env.npm_config_user_agent = "yarn/4.0.0";
    expect(detectPackageManager()).toBe("yarn");
  });

  it("returns pnpm for pnpm agent", () => {
    process.env.npm_config_user_agent = "pnpm/9.0.0";
    expect(detectPackageManager()).toBe("pnpm");
  });

  it("returns bun for bun agent", () => {
    process.env.npm_config_user_agent = "bun/1.0.0";
    expect(detectPackageManager()).toBe("bun");
  });
});

// ── globalInstallCommand / globalUninstallCommand ─────────────────────────────

describe("globalInstallCommand", () => {
  it("npm", () => {
    expect(globalInstallCommand("npm", "pkg")).toEqual({
      bin: "npm",
      args: ["install", "-g", "pkg"],
    });
  });
  it("yarn", () => {
    expect(globalInstallCommand("yarn", "pkg")).toEqual({
      bin: "yarn",
      args: ["global", "add", "pkg"],
    });
  });
  it("pnpm", () => {
    expect(globalInstallCommand("pnpm", "pkg")).toEqual({
      bin: "pnpm",
      args: ["add", "-g", "pkg"],
    });
  });
  it("bun", () => {
    expect(globalInstallCommand("bun", "pkg")).toEqual({ bin: "bun", args: ["add", "-g", "pkg"] });
  });
  it("preserves paths with spaces", () => {
    const cmd = globalInstallCommand("npm", "/path/with spaces/pkg.tgz");
    expect(cmd.args[2]).toBe("/path/with spaces/pkg.tgz");
  });
});

describe("globalUninstallCommand", () => {
  it("npm", () => {
    expect(globalUninstallCommand("npm", "pkg")).toEqual({
      bin: "npm",
      args: ["uninstall", "-g", "pkg"],
    });
  });
  it("yarn", () => {
    expect(globalUninstallCommand("yarn", "pkg")).toEqual({
      bin: "yarn",
      args: ["global", "remove", "pkg"],
    });
  });
  it("pnpm", () => {
    expect(globalUninstallCommand("pnpm", "pkg")).toEqual({
      bin: "pnpm",
      args: ["remove", "-g", "pkg"],
    });
  });
  it("bun", () => {
    expect(globalUninstallCommand("bun", "pkg")).toEqual({
      bin: "bun",
      args: ["remove", "-g", "pkg"],
    });
  });
});

// ── formatShellCommand ───────────────────────────────────────────────────────

describe("formatShellCommand", () => {
  it("joins bin and args", () => {
    expect(formatShellCommand({ bin: "npm", args: ["install", "-g", "pkg"] })).toBe(
      "npm install -g pkg"
    );
  });

  it("quotes args that contain spaces", () => {
    expect(
      formatShellCommand({ bin: "npm", args: ["install", "-g", "/path/with spaces/pkg.tgz"] })
    ).toBe('npm install -g "/path/with spaces/pkg.tgz"');
  });
});

// ── Bundled paths ─────────────────────────────────────────────────────────────

describe("bundled paths", () => {
  it("SKILLS_DIR is a string ending with skills", () => {
    expect(SKILLS_DIR).toMatch(/skills$/);
  });

  it("RULES_DIR is a string ending with rules", () => {
    expect(RULES_DIR).toMatch(/rules$/);
  });

  it("AGENTS_DIR is a string ending with agents", () => {
    expect(AGENTS_DIR).toMatch(/agents$/);
  });
});

// ── isOnline ──────────────────────────────────────────────────────────────────

describe("isOnline", () => {
  it("resolves to false within the timeout when DNS does not respond", async () => {
    const start = Date.now();
    const result = await isOnline(50);
    const elapsed = Date.now() - start;
    expect(typeof result).toBe("boolean");
    expect(elapsed).toBeLessThan(500);
  });
});
