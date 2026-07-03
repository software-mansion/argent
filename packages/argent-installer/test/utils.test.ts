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
  localInstallCommand,
  localUninstallCommand,
  detectProjectPackageManager,
  hasProjectPackageJson,
  isYarnPnp,
  isLocallyInstalled,
  getLocallyInstalledVersion,
  getLocalArgentBinRelPath,
  probeLocalInstall,
  isDeclaredLocally,
  getInstallRecordPath,
  readInstallRecord,
  writeInstallRecord,
  removeInstallRecord,
  resolveInstallMode,
  resolveInstallModeFromFlags,
  InstallModeFlagError,
} from "../src/utils.js";
import { NPM_REGISTRY, PACKAGE_NAME } from "../src/constants.js";

// Stage a fake project-local @swmansion/argent install under `root`, returning
// the bin entry's project-relative POSIX path.
function stageLocalArgent(
  root: string,
  opts: { version?: string; bin?: unknown; withBinFile?: boolean } = {}
): string {
  const pkgDir = path.join(root, "node_modules", PACKAGE_NAME);
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  const bin = opts.bin ?? { "argent": "dist/cli.js", "argent-simulator-server": "bin/x.cjs" };
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: opts.version ?? "1.2.3", bin })
  );
  if (opts.withBinFile !== false) {
    fs.writeFileSync(path.join(pkgDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  }
  return `node_modules/${PACKAGE_NAME}/dist/cli.js`;
}

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

  it("recognizes opencode.jsonc as a project root marker", () => {
    const projectRoot = path.join(tmpDir, "project");
    const nestedDir = path.join(projectRoot, "src");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "opencode.jsonc"), "{}");

    expect(resolveProjectRoot(nestedDir)).toBe(projectRoot);
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

  it("probes `npx --force --no-install skills --version` and returns true on success", () => {
    execSyncMock.mockReturnValue(Buffer.from("0.1.0\n"));

    expect(isSkillsCliAvailable()).toBe(true);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const [cmd] = execSyncMock.mock.calls[0]!;
    // `--force` softens the host project's npm engine gate so the probe can't
    // hard-fail with EBADDEVENGINES in a devEngines-pinned repo (#298).
    expect(cmd).toBe("npx --force --no-install skills --version");
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

// ── localInstallCommand / localUninstallCommand ──────────────────────────────

describe("localInstallCommand", () => {
  it("uses --save-dev for npm", () => {
    expect(localInstallCommand("npm", "pkg")).toEqual({
      bin: "npm",
      args: ["install", "--save-dev", "pkg"],
    });
  });
  it("uses add --dev for yarn", () => {
    expect(localInstallCommand("yarn", "pkg")).toEqual({
      bin: "yarn",
      args: ["add", "--dev", "pkg"],
    });
  });
  it("uses add -D for pnpm", () => {
    expect(localInstallCommand("pnpm", "pkg")).toEqual({ bin: "pnpm", args: ["add", "-D", "pkg"] });
  });
  it("uses add -d for bun", () => {
    expect(localInstallCommand("bun", "pkg")).toEqual({ bin: "bun", args: ["add", "-d", "pkg"] });
  });
});

describe("localUninstallCommand", () => {
  it("uses uninstall (project) for npm — not -g", () => {
    expect(localUninstallCommand("npm", "pkg")).toEqual({ bin: "npm", args: ["uninstall", "pkg"] });
  });
  it("uses remove for yarn/pnpm/bun without -g", () => {
    expect(localUninstallCommand("yarn", "pkg")).toEqual({ bin: "yarn", args: ["remove", "pkg"] });
    expect(localUninstallCommand("pnpm", "pkg")).toEqual({ bin: "pnpm", args: ["remove", "pkg"] });
    expect(localUninstallCommand("bun", "pkg")).toEqual({ bin: "bun", args: ["remove", "pkg"] });
  });
});

// ── detectProjectPackageManager ──────────────────────────────────────────────

describe("detectProjectPackageManager", () => {
  it("detects pnpm from pnpm-lock.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectProjectPackageManager(tmpDir)).toBe("pnpm");
  });
  it("detects yarn from yarn.lock", () => {
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectProjectPackageManager(tmpDir)).toBe("yarn");
  });
  it("detects bun from bun.lockb", () => {
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
    expect(detectProjectPackageManager(tmpDir)).toBe("bun");
  });
  it("detects npm from package-lock.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
    expect(detectProjectPackageManager(tmpDir)).toBe("npm");
  });
  it("pnpm wins over yarn when both lockfiles exist", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectProjectPackageManager(tmpDir)).toBe("pnpm");
  });
  it("falls back to a valid PM when no lockfile is present", () => {
    expect(["npm", "yarn", "pnpm", "bun"]).toContain(detectProjectPackageManager(tmpDir));
  });
  it("honors the corepack packageManager field over lockfiles", () => {
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.1.0" })
    );
    expect(detectProjectPackageManager(tmpDir)).toBe("pnpm");
  });
  it("walks up to a workspace-root lockfile (monorepo sub-package)", () => {
    // pnpm/yarn workspaces keep the single lockfile at the monorepo root.
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    const sub = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "package.json"), "{}");
    expect(detectProjectPackageManager(sub)).toBe("pnpm");
  });
  it("stops the upward walk at a repo boundary (.git)", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    const repo = path.join(tmpDir, "other-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    // The sibling repo has no lockfile of its own; the outer pnpm lockfile
    // must NOT bleed through the .git boundary.
    expect(["npm", "yarn", "bun"]).toContain(detectProjectPackageManager(repo));
  });
});

// ── Local install detection ──────────────────────────────────────────────────

describe("hasProjectPackageJson", () => {
  it("is false without and true with a package.json", () => {
    expect(hasProjectPackageJson(tmpDir)).toBe(false);
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    expect(hasProjectPackageJson(tmpDir)).toBe(true);
  });
});

describe("isYarnPnp", () => {
  it("detects .pnp.cjs and .pnp.loader.mjs", () => {
    expect(isYarnPnp(tmpDir)).toBe(false);
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    expect(isYarnPnp(tmpDir)).toBe(true);
    fs.rmSync(path.join(tmpDir, ".pnp.cjs"));
    fs.writeFileSync(path.join(tmpDir, ".pnp.loader.mjs"), "");
    expect(isYarnPnp(tmpDir)).toBe(true);
  });
});

describe("isLocallyInstalled / getLocallyInstalledVersion", () => {
  it("is false / null when not installed", () => {
    expect(isLocallyInstalled(tmpDir)).toBe(false);
    expect(getLocallyInstalledVersion(tmpDir)).toBeNull();
  });
  it("is true and reads version from node_modules package.json", () => {
    stageLocalArgent(tmpDir, { version: "9.9.9" });
    expect(isLocallyInstalled(tmpDir)).toBe(true);
    expect(getLocallyInstalledVersion(tmpDir)).toBe("9.9.9");
  });
});

describe("getLocalArgentBinRelPath", () => {
  it("returns null when not installed", () => {
    expect(getLocalArgentBinRelPath(tmpDir)).toBeNull();
  });
  it("derives the bin path from the package.json bin map", () => {
    const rel = stageLocalArgent(tmpDir);
    expect(getLocalArgentBinRelPath(tmpDir)).toBe(rel);
    expect(getLocalArgentBinRelPath(tmpDir)).toBe(`node_modules/${PACKAGE_NAME}/dist/cli.js`);
  });
  it("supports a string bin field", () => {
    stageLocalArgent(tmpDir, { bin: "dist/cli.js" });
    expect(getLocalArgentBinRelPath(tmpDir)).toBe(`node_modules/${PACKAGE_NAME}/dist/cli.js`);
  });
  it("returns null when the resolved bin file is missing on disk", () => {
    stageLocalArgent(tmpDir, { withBinFile: false });
    expect(getLocalArgentBinRelPath(tmpDir)).toBeNull();
  });
  it("uses forward slashes (committable / cross-platform)", () => {
    stageLocalArgent(tmpDir);
    expect(getLocalArgentBinRelPath(tmpDir)).not.toContain("\\");
  });
  it.skipIf(process.platform === "win32")(
    "commits the stable node_modules path, not the pnpm version-pinned store dir",
    () => {
      // Mimic pnpm: the real package lives in a version-suffixed .pnpm store dir
      // and node_modules/<pkg> is a symlink to it. Node's module resolution
      // returns the realpath (the store dir); committing that would bake the
      // version into the MCP command and break on the next bump. The committed
      // path must be the stable symlink path instead.
      const storeDir = path.join(
        tmpDir,
        "node_modules",
        ".pnpm",
        "@swmansion+argent@0.13.0",
        "node_modules",
        PACKAGE_NAME
      );
      fs.mkdirSync(path.join(storeDir, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(storeDir, "package.json"),
        JSON.stringify({ name: PACKAGE_NAME, version: "0.13.0", bin: { argent: "dist/cli.js" } })
      );
      fs.writeFileSync(path.join(storeDir, "dist", "cli.js"), "#!/usr/bin/env node\n");
      const linkPath = path.join(tmpDir, "node_modules", PACKAGE_NAME);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(storeDir, linkPath);

      const rel = getLocalArgentBinRelPath(tmpDir);
      expect(rel).toBe(`node_modules/${PACKAGE_NAME}/dist/cli.js`);
      expect(rel).not.toContain(".pnpm");
      expect(rel).not.toContain("0.13.0");
    }
  );
});

describe("probeLocalInstall / isDeclaredLocally", () => {
  it("resolves a hoisted install from a sub-package (workspace layout)", () => {
    // The package lives in the workspace-root node_modules; the project root
    // is a sub-package. A hardcoded <root>/node_modules probe misses this.
    stageLocalArgent(tmpDir, { version: "3.2.1" });
    const sub = path.join(tmpDir, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "package.json"), "{}");
    const probe = probeLocalInstall(sub);
    expect(probe.installed).toBe(true);
    expect(probe.version).toBe("3.2.1");
    expect(probe.packageDir).toBeTruthy();
  });
  it("treats a declared dep under Yarn PnP as installed (no node_modules)", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ devDependencies: { [PACKAGE_NAME]: "1.4.0" } })
    );
    const probe = probeLocalInstall(tmpDir);
    expect(probe.installed).toBe(true);
    expect(probe.version).toBe("1.4.0"); // exact specifier doubles as the version
    expect(probe.packageDir).toBeNull();
  });
  it("PnP with a range specifier is installed but version-unknown", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ devDependencies: { [PACKAGE_NAME]: "^1.4.0" } })
    );
    const probe = probeLocalInstall(tmpDir);
    expect(probe.installed).toBe(true);
    expect(probe.version).toBeNull();
  });
  it("PnP without a declaration is not installed", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    expect(probeLocalInstall(tmpDir).installed).toBe(false);
  });
  it("isDeclaredLocally reads dependencies and devDependencies", () => {
    expect(isDeclaredLocally(tmpDir)).toBe(false);
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { [PACKAGE_NAME]: "*" } })
    );
    expect(isDeclaredLocally(tmpDir)).toBe(true);
  });
});

// ── Install-mode record (.argent/install.json) ───────────────────────────────

describe("install record", () => {
  it("getInstallRecordPath points at <root>/.argent/install.json", () => {
    expect(getInstallRecordPath(tmpDir)).toBe(path.join(tmpDir, ".argent", "install.json"));
  });
  it("write then read round-trips", () => {
    writeInstallRecord(tmpDir, { mode: "local", package: PACKAGE_NAME, writtenBy: "1.0.0" });
    expect(readInstallRecord(tmpDir)).toEqual({
      mode: "local",
      package: PACKAGE_NAME,
      writtenBy: "1.0.0",
    });
  });
  it("read returns null on a missing or malformed file", () => {
    expect(readInstallRecord(tmpDir)).toBeNull();
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(getInstallRecordPath(tmpDir), "{ not json");
    expect(readInstallRecord(tmpDir)).toBeNull();
  });
  it("read rejects an unknown mode value", () => {
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(getInstallRecordPath(tmpDir), JSON.stringify({ mode: "bogus" }));
    expect(readInstallRecord(tmpDir)).toBeNull();
  });
  it("removeInstallRecord deletes the file and prunes an emptied .argent dir", () => {
    writeInstallRecord(tmpDir, { mode: "local", package: PACKAGE_NAME });
    expect(removeInstallRecord(tmpDir)).toBe(true);
    expect(fs.existsSync(getInstallRecordPath(tmpDir))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".argent"))).toBe(false);
    expect(removeInstallRecord(tmpDir)).toBe(false);
  });
  it("removeInstallRecord keeps .argent when other files remain (e.g. flags.json)", () => {
    writeInstallRecord(tmpDir, { mode: "local", package: PACKAGE_NAME });
    fs.writeFileSync(path.join(tmpDir, ".argent", "flags.json"), "{}");
    expect(removeInstallRecord(tmpDir)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".argent"))).toBe(true);
  });
});

describe("resolveInstallMode", () => {
  const declareLocalArgent = (root: string) =>
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "host", devDependencies: { [PACKAGE_NAME]: "^1.2.3" } })
    );
  it("defaults to global with no record and no local install", () => {
    expect(resolveInstallMode(tmpDir)).toBe("global");
  });
  it("does NOT infer local from mere node_modules presence (hoisted / transitive copy)", () => {
    // A copy that merely exists in node_modules is not intent — acting on it
    // would rewrite a manifest the user never opted into.
    stageLocalArgent(tmpDir);
    expect(resolveInstallMode(tmpDir)).toBe("global");
  });
  it("infers local from a dependency the project manifest declares (no record)", () => {
    stageLocalArgent(tmpDir);
    declareLocalArgent(tmpDir);
    expect(resolveInstallMode(tmpDir)).toBe("local");
  });
  it("the committed record wins over inference", () => {
    writeInstallRecord(tmpDir, { mode: "local", package: PACKAGE_NAME });
    expect(resolveInstallMode(tmpDir)).toBe("local");
    writeInstallRecord(tmpDir, { mode: "global", package: PACKAGE_NAME });
    stageLocalArgent(tmpDir);
    expect(resolveInstallMode(tmpDir)).toBe("global");
  });
});

// ── resolveInstallModeFromFlags ──────────────────────────────────────────────

describe("resolveInstallModeFromFlags", () => {
  it("returns local for --local (even with --yes)", () => {
    expect(resolveInstallModeFromFlags({ local: true, global: false, nonInteractive: true })).toBe(
      "local"
    );
  });
  it("returns global for --global", () => {
    expect(resolveInstallModeFromFlags({ local: false, global: true, nonInteractive: false })).toBe(
      "global"
    );
  });
  it("non-interactive with no flag defaults to global", () => {
    expect(resolveInstallModeFromFlags({ local: false, global: false, nonInteractive: true })).toBe(
      "global"
    );
  });
  it("non-interactive honors a committed local record (no silent revert to global)", () => {
    expect(
      resolveInstallModeFromFlags({
        local: false,
        global: false,
        nonInteractive: true,
        recordedMode: "local",
      })
    ).toBe("local");
  });
  it("an explicit --global still overrides a committed local record", () => {
    expect(
      resolveInstallModeFromFlags({
        local: false,
        global: true,
        nonInteractive: true,
        recordedMode: "local",
      })
    ).toBe("global");
  });
  it("returns null (prompt) when interactive with no flag", () => {
    expect(
      resolveInstallModeFromFlags({ local: false, global: false, nonInteractive: false })
    ).toBeNull();
  });
  it("throws on conflicting --local and --global", () => {
    expect(() =>
      resolveInstallModeFromFlags({ local: true, global: true, nonInteractive: false })
    ).toThrow(InstallModeFlagError);
  });
});
