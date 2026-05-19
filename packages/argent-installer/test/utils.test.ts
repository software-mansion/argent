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
  getLocallyInstalledVersion,
  globalInstallCommand,
  globalUninstallCommand,
  localDevInstallCommand,
  formatShellCommand,
  getGlobalSkillLockPath,
  getProjectSkillLockPath,
  hasPackageJson,
  isLocallyInstalled,
  isNewerVersion,
  isOnline,
  isSkillsCliAvailable,
  isTempRunnerPath,
  isYarnPnp,
  listArgentSkillsInLock,
  listBundledSkills,
  resolveProjectRoot,
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
} from "../src/utils.js";
import { NPM_REGISTRY } from "../src/constants.js";

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

// ── detectPackageManager — lockfile-based ──────────────────────────────────
// Resolution must prefer the project's lockfile over the runtime user
// agent. Without this, `npx @swmansion/argent init` from a yarn or pnpm
// workspace would try to drive npm (npx sets npm_config_user_agent to
// npm/...), and yarn-only protocols like `link:` fail under npm. The
// regression that motivated this was bsky/social-app (yarn project
// shipping `link:./eslint`).

describe("detectPackageManager — lockfile-based detection", () => {
  const original = process.env.npm_config_user_agent;

  afterEach(() => {
    if (original === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = original;
  });

  it("returns yarn when yarn.lock is present, regardless of user-agent", () => {
    process.env.npm_config_user_agent = "npm/10.0.0"; // hostile: pretend npx is driving
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("returns pnpm when pnpm-lock.yaml is present", () => {
    process.env.npm_config_user_agent = "npm/10.0.0";
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("returns bun for bun.lock (text format, Bun 1.1+)", () => {
    process.env.npm_config_user_agent = "npm/10.0.0";
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("returns bun for bun.lockb (legacy binary format)", () => {
    process.env.npm_config_user_agent = "npm/10.0.0";
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("returns npm when package-lock.json is present", () => {
    delete process.env.npm_config_user_agent;
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  it("returns npm when npm-shrinkwrap.json is present", () => {
    delete process.env.npm_config_user_agent;
    fs.writeFileSync(path.join(tmpDir, "npm-shrinkwrap.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  it("prefers pnpm over yarn when both lockfiles exist (migration leftover)", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("falls through to user-agent when no lockfile exists", () => {
    process.env.npm_config_user_agent = "yarn/4.0.0";
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("falls through to npm default when neither lockfile nor user-agent helps", () => {
    delete process.env.npm_config_user_agent;
    expect(detectPackageManager(tmpDir)).toBe("npm");
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

// ── localDevInstallCommand ───────────────────────────────────────────────────

describe("localDevInstallCommand", () => {
  it("npm uses --save-dev", () => {
    expect(localDevInstallCommand("npm", "pkg")).toEqual({
      bin: "npm",
      args: ["install", "--save-dev", "pkg"],
    });
  });
  it("pnpm uses -D", () => {
    expect(localDevInstallCommand("pnpm", "pkg")).toEqual({
      bin: "pnpm",
      args: ["add", "-D", "pkg"],
    });
  });
  it("yarn uses --dev (works on both v1 and berry node-modules linker)", () => {
    expect(localDevInstallCommand("yarn", "pkg")).toEqual({
      bin: "yarn",
      args: ["add", "--dev", "pkg"],
    });
  });
  it("bun uses -d", () => {
    expect(localDevInstallCommand("bun", "pkg")).toEqual({
      bin: "bun",
      args: ["add", "-d", "pkg"],
    });
  });
  it("preserves tarball paths with spaces (--from)", () => {
    const cmd = localDevInstallCommand("npm", "/path/with spaces/argent.tgz");
    expect(cmd.args[2]).toBe("/path/with spaces/argent.tgz");
  });
});

// ── hasPackageJson ──────────────────────────────────────────────────────────

describe("hasPackageJson", () => {
  it("returns false when the file is missing", () => {
    expect(hasPackageJson(tmpDir)).toBe(false);
  });
  it("returns true when a package.json exists at the root", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    expect(hasPackageJson(tmpDir)).toBe(true);
  });
  it("does not walk up — checks the exact directory provided", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    const child = path.join(tmpDir, "src");
    fs.mkdirSync(child, { recursive: true });
    expect(hasPackageJson(child)).toBe(false);
  });
});

// ── isLocallyInstalled ──────────────────────────────────────────────────────
// The check is intentionally two-part: the package must be declared as a
// dependency in the project's package.json AND its files must be on disk
// under node_modules. The declaration check disambiguates a real consumer
// from an npm/yarn workspace where node_modules/@swmansion/argent is just
// a symlink to the workspace source.

function writeProjectPackageJson(
  dir: string,
  manifest: Record<string, unknown> = { devDependencies: { "@swmansion/argent": "^0.7.0" } }
): void {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
}

function writeArgentInNodeModules(dir: string): void {
  const argentDir = path.join(dir, "node_modules", "@swmansion", "argent");
  fs.mkdirSync(argentDir, { recursive: true });
  fs.writeFileSync(
    path.join(argentDir, "package.json"),
    '{"name":"@swmansion/argent","version":"0.7.0"}'
  );
}

describe("isLocallyInstalled", () => {
  it("returns false when nothing about the project mentions argent", () => {
    expect(isLocallyInstalled(tmpDir)).toBe(false);
  });

  it("returns true when argent is in devDependencies AND present on disk", () => {
    writeProjectPackageJson(tmpDir);
    writeArgentInNodeModules(tmpDir);
    expect(isLocallyInstalled(tmpDir)).toBe(true);
  });

  it("returns true for dependencies / peerDependencies / optionalDependencies too", () => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      const subDir = fs.mkdtempSync(path.join(os.tmpdir(), `argent-locinst-${field}-`));
      try {
        writeProjectPackageJson(subDir, { [field]: { "@swmansion/argent": "^0.7.0" } });
        writeArgentInNodeModules(subDir);
        expect(isLocallyInstalled(subDir)).toBe(true);
      } finally {
        fs.rmSync(subDir, { recursive: true, force: true });
      }
    }
  });

  it("returns false when the files are on disk but the project doesn't declare argent as a dep", () => {
    // This is the npm-workspace case that bit us in the field:
    // node_modules/@swmansion/argent is a workspace symlink to
    // packages/argent. The root package.json does NOT list argent as
    // its own dependency, so this is a development checkout, not a
    // consumer install.
    writeProjectPackageJson(tmpDir, { name: "my-workspace", workspaces: ["packages/*"] });
    writeArgentInNodeModules(tmpDir);
    expect(isLocallyInstalled(tmpDir)).toBe(false);
  });

  it("returns false when the project declares argent but it isn't installed yet", () => {
    // User edited package.json but hasn't run npm install. Treating
    // this as "installed" would skip the install step and leave them
    // with broken MCP config pointing at a non-existent binary.
    writeProjectPackageJson(tmpDir);
    expect(isLocallyInstalled(tmpDir)).toBe(false);
  });

  it("returns false when the project's package.json is malformed", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "not json");
    writeArgentInNodeModules(tmpDir);
    expect(isLocallyInstalled(tmpDir)).toBe(false);
  });

  it("returns false when node_modules/@swmansion/argent has the directory but no package.json", () => {
    writeProjectPackageJson(tmpDir);
    const argentDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentDir, { recursive: true });
    expect(isLocallyInstalled(tmpDir)).toBe(false);
  });
});

// ── isYarnPnp ────────────────────────────────────────────────────────────────

describe("isYarnPnp", () => {
  it("returns false when neither .pnp.cjs nor .pnp.loader.mjs exist", () => {
    expect(isYarnPnp(tmpDir)).toBe(false);
  });
  it("returns true when .pnp.cjs exists at the project root", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    expect(isYarnPnp(tmpDir)).toBe(true);
  });
  it("returns true when .pnp.loader.mjs exists (Yarn 4+ ESM loader)", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.loader.mjs"), "");
    expect(isYarnPnp(tmpDir)).toBe(true);
  });
  it("does not walk up — checks the exact directory provided", () => {
    fs.writeFileSync(path.join(tmpDir, ".pnp.cjs"), "");
    const child = path.join(tmpDir, "src");
    fs.mkdirSync(child, { recursive: true });
    expect(isYarnPnp(child)).toBe(false);
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

// ── isTempRunnerPath ─────────────────────────────────────────────────────────
// Regression coverage for the npx/dlx/bunx cache detection. The existing
// getGlobalBinaryPath() relies on these markers to avoid reporting a
// transient `npx @swmansion/argent` as a "true" global install. We keep
// the matchers under test so a future refactor that drops a cache layout
// shows up here instead of silently making the install check wrong.

describe("isTempRunnerPath", () => {
  it("matches the standard npm npx cache", () => {
    expect(isTempRunnerPath("/Users/me/.npm/_npx/abc123/node_modules/.bin/argent")).toBe(true);
  });

  it("matches pnpm dlx caches (POSIX)", () => {
    expect(isTempRunnerPath("/Users/me/.local/share/pnpm/dlx-7a8b/node_modules/.bin/argent")).toBe(
      true
    );
  });

  it("matches pnpm dlx caches (Windows backslashes)", () => {
    expect(isTempRunnerPath("C:\\Users\\me\\AppData\\Local\\pnpm\\dlx-7a8b\\argent.cmd")).toBe(
      true
    );
  });

  it("matches bunx caches", () => {
    expect(isTempRunnerPath("/Users/me/.bun/install/cache/@swmansion/argent/bin/argent")).toBe(
      true
    );
  });

  it("returns false for a genuine global install (npm prefix)", () => {
    expect(isTempRunnerPath("/usr/local/lib/node_modules/@swmansion/argent/dist/cli.js")).toBe(
      false
    );
  });

  it("returns false for a project-local node_modules install", () => {
    expect(isTempRunnerPath("/Users/me/project/node_modules/.bin/argent")).toBe(false);
  });
});

// ── npx-cache cannot fool the local install check ────────────────────────────
// The user's concern: when init runs via `npx @swmansion/argent`, the
// running module lives in `~/.npm/_npx/<hash>/node_modules/...` — that's a
// transient cache, not a "real" install. isLocallyInstalled must continue
// to report only on the project's own node_modules, never on the npx cache.

describe("isLocallyInstalled — npx invocation", () => {
  it("returns false when the only argent on disk is in an npx cache layout", () => {
    // Simulate ~/.npm/_npx/<hash>/node_modules/@swmansion/argent without a
    // project install. The npx cache lives under home, so projectRoot is
    // some unrelated directory.
    const fakeNpxCache = path.join(tmpDir, ".npm", "_npx", "abc123");
    const argentInCache = path.join(fakeNpxCache, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentInCache, { recursive: true });
    fs.writeFileSync(path.join(argentInCache, "package.json"), '{"name":"@swmansion/argent"}');

    const projectRoot = path.join(tmpDir, "my-project");
    fs.mkdirSync(projectRoot, { recursive: true });

    expect(isLocallyInstalled(projectRoot)).toBe(false);
  });

  it("correctly reports a real local install even when an npx cache also exists", () => {
    // The npx cache copy must not mask the project's own install.
    const projectRoot = path.join(tmpDir, "my-project");
    fs.mkdirSync(projectRoot, { recursive: true });
    writeProjectPackageJson(projectRoot);
    writeArgentInNodeModules(projectRoot);

    const fakeNpxCache = path.join(tmpDir, ".npm", "_npx", "abc123");
    const argentInCache = path.join(fakeNpxCache, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentInCache, { recursive: true });
    fs.writeFileSync(path.join(argentInCache, "package.json"), '{"name":"@swmansion/argent"}');

    expect(isLocallyInstalled(projectRoot)).toBe(true);
  });
});

// ── getLocallyInstalledVersion ──────────────────────────────────────────────
// Companion to isLocallyInstalled. The helper exists specifically so that
// post-install version reporting reflects what landed on disk, not the npx
// cache copy that's still running the init flow.

describe("getLocallyInstalledVersion", () => {
  it("returns null when no local install is present", () => {
    expect(getLocallyInstalledVersion(tmpDir)).toBeNull();
  });

  it("returns the version from the project's node_modules", () => {
    const argentDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentDir, { recursive: true });
    fs.writeFileSync(
      path.join(argentDir, "package.json"),
      '{"name":"@swmansion/argent","version":"0.7.0"}'
    );
    expect(getLocallyInstalledVersion(tmpDir)).toBe("0.7.0");
  });

  it("reports the local version even when invoked via npx (which would otherwise return latest)", () => {
    // The local devDep is pinned to an older version than what `npx`
    // would download. The helper must read from the project, not from
    // the running process's PACKAGE_ROOT.
    const argentDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentDir, { recursive: true });
    fs.writeFileSync(
      path.join(argentDir, "package.json"),
      '{"name":"@swmansion/argent","version":"0.5.3"}'
    );
    expect(getLocallyInstalledVersion(tmpDir)).toBe("0.5.3");
  });

  it("returns null when the package.json is malformed", () => {
    const argentDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentDir, { recursive: true });
    fs.writeFileSync(path.join(argentDir, "package.json"), "not json");
    expect(getLocallyInstalledVersion(tmpDir)).toBeNull();
  });

  it("returns null when the package.json exists but has no version field", () => {
    const argentDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(argentDir, { recursive: true });
    fs.writeFileSync(path.join(argentDir, "package.json"), '{"name":"@swmansion/argent"}');
    expect(getLocallyInstalledVersion(tmpDir)).toBeNull();
  });
});
