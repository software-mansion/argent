import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Module mocks ─────────────────────────────────────────────────────────────
// These are hoisted so `vi.mock` can reference them. They let the network-
// dependent helpers (`isOnline`, `isSkillsCliAvailable`) be tested
// deterministically without touching DNS or spawning `npx`.

const { dnsLookupMock, execSyncMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    default: { ...actual, lookup: dnsLookupMock },
    lookup: dnsLookupMock,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, execSync: execSyncMock },
    execSync: execSyncMock,
  };
});

import {
  readJson,
  writeJson,
  copyDir,
  dirExists,
  detectPackageManager,
  extractFlag,
  globalInstallCommand,
  globalUninstallCommand,
  formatShellCommand,
  getGlobalSkillLockPath,
  getProjectSkillLockPath,
  listArgentSkillsInLock,
  isNewerVersion,
  isOnline,
  isSkillsCliAvailable,
  listBundledSkills,
  resolveProjectRoot,
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
} from "../../src/cli/utils.js";
import { NPM_REGISTRY } from "../../src/cli/constants.js";

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

// ── resolveProjectRoot ────────────────────────────────────────────────────────

describe("resolveProjectRoot", () => {
  it("returns the nearest managed project root", () => {
    const projectRoot = path.join(tmpDir, "project");
    const nestedDir = path.join(projectRoot, "src", "deep");
    fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    expect(resolveProjectRoot(nestedDir)).toBe(projectRoot);
  });

  it("prefers a nearer managed root over an ancestor git root", () => {
    const repoRoot = path.join(tmpDir, "repo");
    const nestedProjectRoot = path.join(repoRoot, "packages", "app");
    const nestedDir = path.join(nestedProjectRoot, "src");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(nestedProjectRoot, ".cursor"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    expect(resolveProjectRoot(nestedDir)).toBe(nestedProjectRoot);
  });

  it("falls back to git root when no managed markers exist", () => {
    const repoRoot = path.join(tmpDir, "repo");
    const nestedDir = path.join(repoRoot, "src");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    expect(resolveProjectRoot(nestedDir)).toBe(repoRoot);
  });

  it("falls back to the starting directory when no markers exist", () => {
    const nestedDir = path.join(tmpDir, "plain", "src");
    fs.mkdirSync(nestedDir, { recursive: true });

    expect(resolveProjectRoot(nestedDir)).toBe(nestedDir);
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

// ── extractFlag ──────────────────────────────────────────────────────────────

describe("extractFlag", () => {
  it("returns the value that follows the flag", () => {
    expect(extractFlag(["update", "--from", "./pkg.tgz"], "--from")).toBe("./pkg.tgz");
  });

  it("returns null when the flag is absent", () => {
    expect(extractFlag(["update", "--yes"], "--from")).toBeNull();
  });

  it("returns null when the flag has no value (last arg)", () => {
    expect(extractFlag(["update", "--from"], "--from")).toBeNull();
  });

  it("picks the first occurrence when the flag is repeated", () => {
    expect(extractFlag(["--from", "a", "--from", "b"], "--from")).toBe("a");
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

// ── isNewerVersion ───────────────────────────────────────────────────────────

describe("isNewerVersion", () => {
  it("returns true when candidate is a higher patch", () => {
    expect(isNewerVersion("0.5.3", "0.5.2")).toBe(true);
  });

  it("returns true when candidate is a higher minor", () => {
    expect(isNewerVersion("0.6.0", "0.5.9")).toBe(true);
  });

  it("returns true when candidate is a higher major", () => {
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewerVersion("0.5.3", "0.5.3")).toBe(false);
  });

  it("returns false when candidate is older — the bug fix", () => {
    // Before the fix init.ts used `latest !== version`, which prompted a
    // "downgrade" when running a local prerelease newer than npm's latest.
    expect(isNewerVersion("0.5.2", "0.5.3")).toBe(false);
  });

  it("treats a prerelease as older than the matching release", () => {
    expect(isNewerVersion("0.5.3-alpha.1", "0.5.3")).toBe(false);
    expect(isNewerVersion("0.5.3", "0.5.3-alpha.1")).toBe(true);
  });

  it("still allows upgrades from a prerelease to a newer release", () => {
    expect(isNewerVersion("0.5.4", "0.5.4-beta.0")).toBe(true);
  });
});

// ── listBundledSkills ────────────────────────────────────────────────────────

describe("listBundledSkills", () => {
  it("returns an empty list for a non-existent directory", () => {
    expect(listBundledSkills(path.join(tmpDir, "does-not-exist"))).toEqual([]);
  });

  it("returns only subdirectories that contain a SKILL.md", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "argent-alpha"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "argent-alpha", "SKILL.md"), "# alpha");
    fs.mkdirSync(path.join(skillsDir, "argent-beta"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "argent-beta", "SKILL.md"), "# beta");
    // An orphan directory without SKILL.md must be excluded — it is not a skill.
    fs.mkdirSync(path.join(skillsDir, "not-a-skill"), { recursive: true });
    // Stray files at the top level must also be excluded.
    fs.writeFileSync(path.join(skillsDir, "README.md"), "");

    expect(listBundledSkills(skillsDir)).toEqual(["argent-alpha", "argent-beta"]);
  });

  it("returns results in a stable sorted order", () => {
    const skillsDir = path.join(tmpDir, "skills");
    for (const name of ["zulu", "alpha", "mike"]) {
      fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), "");
    }
    expect(listBundledSkills(skillsDir)).toEqual(["alpha", "mike", "zulu"]);
  });
});

// ── skills lock helpers ──────────────────────────────────────────────────────

describe("getProjectSkillLockPath", () => {
  it("resolves to skills-lock.json under the provided cwd", () => {
    expect(getProjectSkillLockPath("/some/project")).toBe("/some/project/skills-lock.json");
  });
});

describe("getGlobalSkillLockPath", () => {
  const originalXdg = process.env.XDG_STATE_HOME;

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalXdg;
  });

  it("falls back to ~/.agents/.skill-lock.json when XDG_STATE_HOME is unset", () => {
    delete process.env.XDG_STATE_HOME;
    expect(getGlobalSkillLockPath()).toBe(path.join(os.homedir(), ".agents", ".skill-lock.json"));
  });

  it("uses $XDG_STATE_HOME/skills/.skill-lock.json when set", () => {
    process.env.XDG_STATE_HOME = "/tmp/xdg";
    expect(getGlobalSkillLockPath()).toBe("/tmp/xdg/skills/.skill-lock.json");
  });
});

describe("listArgentSkillsInLock", () => {
  it("returns an empty list when the lock file does not exist", () => {
    expect(listArgentSkillsInLock(path.join(tmpDir, "missing.json"))).toEqual([]);
  });

  it("returns an empty list for a malformed JSON lock", () => {
    const lockPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(lockPath, "not json");
    expect(listArgentSkillsInLock(lockPath)).toEqual([]);
  });

  it("returns only skills whose name starts with argent-", () => {
    const lockPath = path.join(tmpDir, "lock.json");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        skills: {
          "argent-create-flow": {},
          "argent-old-workflow": {}, // still in lock even if no longer bundled
          "some-other-skill": {},
          "vercel-labs/agent-skills": {},
        },
      })
    );
    // Result is sorted so callers can rely on a stable order.
    expect(listArgentSkillsInLock(lockPath)).toEqual(["argent-create-flow", "argent-old-workflow"]);
  });

  it("returns an empty list when the lock has no skills object", () => {
    const lockPath = path.join(tmpDir, "empty.json");
    fs.writeFileSync(lockPath, JSON.stringify({ version: 1 }));
    expect(listArgentSkillsInLock(lockPath)).toEqual([]);
  });

  it("returns an empty list when no argent-prefixed entry is tracked", () => {
    const lockPath = path.join(tmpDir, "lock.json");
    fs.writeFileSync(lockPath, JSON.stringify({ version: 1, skills: { "other-skill": {} } }));
    expect(listArgentSkillsInLock(lockPath)).toEqual([]);
  });
});

// ── isOnline ──────────────────────────────────────────────────────────────────
// `isOnline` wraps `dns.lookup` with a timeout. All tests below run against
// the mocked `dns.lookup` set up at the top of this file — they never touch
// real DNS, which keeps them deterministic on offline runners and CI machines
// that deny outbound network access.

describe("isOnline", () => {
  beforeEach(() => {
    dnsLookupMock.mockReset();
  });

  it("returns true when DNS resolution succeeds", async () => {
    dnsLookupMock.mockImplementation((_host: string, callback: (err: Error | null) => void) => {
      setImmediate(() => callback(null));
    });

    await expect(isOnline()).resolves.toBe(true);
    expect(dnsLookupMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when DNS resolution errors", async () => {
    dnsLookupMock.mockImplementation((_host: string, callback: (err: Error | null) => void) => {
      setImmediate(() => callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })));
    });

    await expect(isOnline()).resolves.toBe(false);
  });

  it("returns false when DNS never responds before the timeout", async () => {
    dnsLookupMock.mockImplementation(() => {
      // Never invoke the callback — simulate a hanging DNS query.
    });

    const start = Date.now();
    const result = await isOnline(30);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(500);
  });

  it("looks up the hostname from NPM_REGISTRY", async () => {
    const expectedHost = new URL(NPM_REGISTRY).hostname;
    dnsLookupMock.mockImplementation((_host: string, callback: (err: Error | null) => void) => {
      setImmediate(() => callback(null));
    });

    await isOnline();

    expect(dnsLookupMock).toHaveBeenCalledWith(expectedHost, expect.any(Function));
  });

  it("settles once even if DNS responds after the timeout has already fired", async () => {
    let dnsCallback: ((err: Error | null) => void) | null = null;
    dnsLookupMock.mockImplementation((_host: string, callback: (err: Error | null) => void) => {
      dnsCallback = callback;
    });

    const result = await isOnline(10);
    expect(result).toBe(false);

    // Late DNS callback must not throw, log, or re-resolve the already-
    // settled promise. This mirrors what happens when DNS responds after
    // we have already given up waiting.
    expect(() => dnsCallback?.(null)).not.toThrow();
  });
});

// ── isSkillsCliAvailable ─────────────────────────────────────────────────────

describe("isSkillsCliAvailable", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it("returns true when `npx --no-install skills --version` exits successfully", () => {
    execSyncMock.mockReturnValue(Buffer.from("0.1.0\n"));

    expect(isSkillsCliAvailable()).toBe(true);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const [cmd] = execSyncMock.mock.calls[0]!;
    expect(cmd).toBe("npx --no-install skills --version");
  });

  it("returns false when the probe throws (skills CLI not in npx cache)", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("command failed");
    });

    expect(isSkillsCliAvailable()).toBe(false);
  });

  it("fully silences stdio so nothing leaks to the terminal", () => {
    execSyncMock.mockReturnValue(Buffer.from(""));

    isSkillsCliAvailable();

    const opts = execSyncMock.mock.calls[0]![1] as
      | { stdio?: [unknown, unknown, unknown] }
      | undefined;
    expect(opts?.stdio).toEqual(["ignore", "ignore", "ignore"]);
  });

  it("passes a timeout so a wedged npx cannot hang init forever", () => {
    execSyncMock.mockReturnValue(Buffer.from(""));

    isSkillsCliAvailable();

    const opts = execSyncMock.mock.calls[0]![1] as { timeout?: number } | undefined;
    expect(typeof opts?.timeout).toBe("number");
    expect(opts!.timeout!).toBeGreaterThan(0);
  });
});
