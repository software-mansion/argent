import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ALL_ADAPTERS,
  getMcpEntry,
  addClaudePermission,
  removeClaudePermission,
} from "../src/mcp-configs.js";
import {
  cleanupSkillsLockFile,
  getBundledSkillNames,
  removeBundledContent,
  removeBundledSkillInstalls,
  uninstall,
} from "../src/uninstall.js";

const telemetryMock = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
  forget: vi.fn().mockResolvedValue({
    localIdRemoved: true,
    consentDisabled: false,
  }),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

const childProcessMock = vi.hoisted(() => ({
  execSync: vi.fn(() => "/usr/local/bin/argent\n"),
  execFileSync: vi.fn(),
}));

const toolsClientMock = vi.hoisted(() => ({
  killToolServer: vi.fn().mockResolvedValue(undefined),
  killToolServerForInstallDir: vi.fn().mockResolvedValue(0),
}));

vi.mock("@argent/telemetry", () => telemetryMock);
vi.mock("node:child_process", () => childProcessMock);
vi.mock("@argent/tools-client", () => toolsClientMock);
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
  note: vi.fn(),
}));

let tmpDir: string;
let originalCwd: string;

function writeFile(filePath: string, contents = "test"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-uninstall-test-"));
  originalCwd = process.cwd();
  vi.clearAllMocks();
  childProcessMock.execSync.mockImplementation(() => "/usr/local/bin/argent\n");
  childProcessMock.execFileSync.mockImplementation(() => undefined);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("uninstall — telemetry consent preservation", () => {
  // The prune step resolves global skill/rule/agent targets from homedir(), so
  // point HOME at the empty tmpDir: the prune then finds nothing to remove and
  // has_pruned_content is deterministically false regardless of what the real
  // home contains (these are telemetry-behavior tests, not real-home cleanup).
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  it("does not reset uninstall telemetry identity when no global package was uninstalled", async () => {
    childProcessMock.execSync.mockImplementationOnce(() => {
      throw new Error("not found");
    });
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(childProcessMock.execFileSync).not.toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["uninstall", "-g"])
    );
    expect(telemetryMock.track).toHaveBeenCalledWith("installation:cli_uninstall_complete", {
      has_pruned_content: false,
      has_uninstalled_package: false,
      install_mode: "global",
    });
    expect(telemetryMock.forget).not.toHaveBeenCalled();
  });

  it("resets uninstall telemetry identity without persisting a consent opt-out after global package uninstall", async () => {
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(childProcessMock.execFileSync).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["uninstall", "-g", "@swmansion/argent"]),
      expect.any(Object)
    );
    expect(telemetryMock.forget).toHaveBeenCalledWith({ disableConsent: false });
  });

  it("drains queued uninstall telemetry before deleting the local telemetry id", async () => {
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(telemetryMock.track).toHaveBeenCalledWith("installation:cli_uninstall_complete", {
      has_pruned_content: false,
      has_uninstalled_package: true,
      install_mode: "global",
    });

    const shutdownOrder = telemetryMock.shutdown.mock.invocationCallOrder[0]!;
    const forgetOrder = telemetryMock.forget.mock.invocationCallOrder[0]!;
    expect(shutdownOrder).toBeLessThan(forgetOrder);
  });

  it("does not delete the local telemetry id when global package uninstall fails", async () => {
    process.chdir(tmpDir);
    childProcessMock.execFileSync.mockImplementation((bin: string) => {
      if (bin === "npm") throw new Error("npm failed");
      return undefined;
    });

    await uninstall(["--yes"]);

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_PACKAGE_ACTION_FAILED",
        has_pruned_content: false,
        has_uninstalled_package: false,
      })
    );
    expect(telemetryMock.forget).not.toHaveBeenCalled();
  });

  it("drains uninstall telemetry when package shutdown throws before uninstalling", async () => {
    process.chdir(tmpDir);
    // Stage a resolvable fake global install so the kill (scoped to the install
    // dir being removed) is actually attempted.
    const globalPkg = path.join(tmpDir, "global-argent");
    writeFile(path.join(globalPkg, "package.json"), JSON.stringify({ name: "@swmansion/argent" }));
    writeFile(path.join(globalPkg, "bin", "argent"), "#!/usr/bin/env node\n");
    childProcessMock.execSync.mockImplementation(
      () => path.join(globalPkg, "bin", "argent") + "\n"
    );
    toolsClientMock.killToolServerForInstallDir.mockRejectedValueOnce(
      new Error("tool server busy")
    );

    await expect(uninstall(["--yes"])).rejects.toThrow("tool server busy");
    // The probe follows symlinks (macOS /var → /private/var), so compare realpaths.
    expect(toolsClientMock.killToolServerForInstallDir).toHaveBeenCalledWith(
      fs.realpathSync(globalPkg)
    );

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_TOOLSERVER_STOP_FAILED",
        has_pruned_content: false,
        has_uninstalled_package: false,
      })
    );
    expect(telemetryMock.shutdown).toHaveBeenCalledOnce();
    expect(telemetryMock.forget).not.toHaveBeenCalled();
  });

  it("drains uninstall telemetry on an unclassified throw outside the classified paths", async () => {
    process.chdir(tmpDir);
    // An unexpected failure that no classified handler covers (e.g. a clack
    // prompt or a cleanup step blowing up). The outer wrapper must still flush
    // the buffered cli_uninstall_start with a terminal cli_uninstall_complete.
    const clack = await import("@clack/prompts");
    vi.mocked(clack.log.step).mockImplementationOnce(() => {
      throw new Error("unexpected boom");
    });

    await expect(uninstall(["--yes"])).rejects.toThrow("unexpected boom");

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({
        error_code: "UNINSTALL_UNCLASSIFIED_FAILED",
      })
    );
    expect(telemetryMock.shutdown).toHaveBeenCalledOnce();
    expect(telemetryMock.forget).not.toHaveBeenCalled();
  });
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

  it("resolves the frontmatter name past a trailing YAML comment", () => {
    // The previous `^name:(.+)$` capture + outer-quote strip kept an inline
    // `# …` comment as part of the name. Parsing the YAML block resolves the
    // scalar correctly.
    const skillsDir = path.join(tmpDir, "skills");
    writeFile(
      path.join(skillsDir, "argent-test-ui-flow", "SKILL.md"),
      [
        "---",
        "name: argent-test-ui-flow # managed by argent",
        "description: test",
        "---",
        "",
        "body",
      ].join("\n")
    );
    expect(getBundledSkillNames(skillsDir)).toEqual(["argent-test-ui-flow"]);
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

describe("uninstall — local (committable) mode package removal", () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  function stageLocalProject(): void {
    fs.mkdirSync(path.join(tmpDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    const pkgDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
  }

  it("removes the local devDependency and NEVER the global package", async () => {
    stageLocalProject();
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    const calls = childProcessMock.execFileSync.mock.calls as Array<
      [string, string[], { cwd?: string }?]
    >;
    // Local devDep removal happened: `npm uninstall <pkg>` with cwd, no -g.
    const localCall = calls.find(
      ([bin, args]) =>
        bin === "npm" &&
        Array.isArray(args) &&
        args.includes("uninstall") &&
        args.includes("@swmansion/argent") &&
        !args.includes("-g")
    );
    expect(localCall).toBeTruthy();
    expect(localCall![2]?.cwd).toBeTruthy();

    // The global package is NEVER touched in local mode — even though the
    // (mocked) PATH probe reports a global install present. This is the guard
    // against `argent uninstall` in a repo nuking the user's shared global tool.
    const globalCall = calls.find(([, args]) => Array.isArray(args) && args.includes("-g"));
    expect(globalCall).toBeFalsy();

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ install_mode: "local", has_uninstalled_package: true })
    );
  });

  it("removes the local-mode install record (.argent/install.json) during prune", async () => {
    stageLocalProject();
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    expect(fs.existsSync(path.join(tmpDir, ".argent", "install.json"))).toBe(false);
  });

  it("keeps the machine-wide telemetry identity on a local-only removal", async () => {
    stageLocalProject();
    process.chdir(tmpDir);

    await uninstall(["--yes"]);

    // The local devDependency was removed, but the global install (and other
    // projects) remain in use — the anonymous id must not be erased.
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ has_uninstalled_package: true })
    );
    expect(telemetryMock.forget).not.toHaveBeenCalled();
  });

  it("erases the telemetry identity when the removed local install was the last one", async () => {
    stageLocalProject();
    process.chdir(tmpDir);
    // No global argent anywhere: this local devDependency is the machine's
    // only known install, so removing it must erase the anonymous id like a
    // global uninstall does.
    childProcessMock.execSync.mockImplementation(() => {
      throw new Error("not found");
    });

    await uninstall(["--yes"]);

    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ has_uninstalled_package: true })
    );
    expect(telemetryMock.forget).toHaveBeenCalledWith({ disableConsent: false });
  });

  it("--local skips the package removal when the project never opted into argent", async () => {
    // A resolvable copy with NO committed record and NO manifest declaration —
    // a hoisted transitive dep / workspace symlink. Removing it would rewrite
    // a manifest and lockfile the user never opted into.
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "host" }));
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
    const pkgDir = path.join(tmpDir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
    );
    process.chdir(tmpDir);

    await uninstall(["--yes", "--local"]);

    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => Array.isArray(args) && args.includes("uninstall"))).toBe(false);
    expect(fs.existsSync(path.join(pkgDir, "package.json"))).toBe(true);
    expect(telemetryMock.track).toHaveBeenCalledWith(
      "installation:cli_uninstall_complete",
      expect.objectContaining({ has_uninstalled_package: false })
    );
  });
});

// ── Scoped config cleanup (scopesToClean) ─────────────────────────────────────
// The entry/allowlist/content cleanup protects the scopes that keep a RETAINED
// install wired up, on implicit defaults as well as explicit flags. HOME is the
// temp dir; the PROJECT lives in a subdir so project-scope and global-scope
// config paths never collide (Cursor uses .cursor/mcp.json for both).

describe("uninstall — scoped config cleanup", () => {
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let projDir: string;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir, { recursive: true });
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });

  function stageProject(opts: { materialized: boolean }): void {
    writeFile(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "proj", devDependencies: { "@swmansion/argent": "^1.0.0" } })
    );
    writeFile(
      path.join(projDir, ".argent", "install.json"),
      JSON.stringify({ mode: "local", package: "@swmansion/argent" })
    );
    if (opts.materialized) {
      writeFile(
        path.join(projDir, "node_modules", "@swmansion", "argent", "package.json"),
        JSON.stringify({ name: "@swmansion/argent", version: "1.0.0" })
      );
    }
  }

  function stageConfigs(): { projectMcp: string; globalCursor: string } {
    const projectMcp = path.join(projDir, ".mcp.json");
    const globalCursor = path.join(tmpDir, ".cursor", "mcp.json");
    writeFile(projectMcp, JSON.stringify({ mcpServers: { argent: getMcpEntry() } }));
    writeFile(globalCursor, JSON.stringify({ mcpServers: { argent: getMcpEntry() } }));
    return { projectMcp, globalCursor };
  }

  // The adapters delete a config file that becomes empty after removing the
  // argent entry, so "file gone" also reads as "entry removed".
  function hasArgentEntry(configPath: string): boolean {
    if (!fs.existsSync(configPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(parsed.mcpServers && "argent" in parsed.mcpServers);
  }

  it("coexistence --yes removes the local install but keeps the global install's configs", async () => {
    stageProject({ materialized: true });
    const { projectMcp, globalCursor } = stageConfigs();
    process.chdir(projDir);

    await uninstall(["--yes"]);

    // Project-scope entry (runs the removed local copy) is gone…
    expect(hasArgentEntry(projectMcp)).toBe(false);
    // …but the RETAINED global install stays wired up in global scope.
    expect(hasArgentEntry(globalCursor)).toBe(true);

    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args.includes("-g"))).toBe(false);
  });

  it("--global keeps the committed project entries and the local-mode record", async () => {
    stageProject({ materialized: true });
    const { projectMcp, globalCursor } = stageConfigs();
    process.chdir(projDir);

    await uninstall(["--yes", "--global"]);

    // The retained local install's committed files survive…
    expect(hasArgentEntry(projectMcp)).toBe(true);
    expect(fs.existsSync(path.join(projDir, ".argent", "install.json"))).toBe(true);
    // …while the removed global install is unwired and uninstalled.
    expect(hasArgentEntry(globalCursor)).toBe(false);
    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args.includes("-g"))).toBe(true);
  });

  it("fresh clone --yes (record, dep not materialized) removes the present global but keeps committed team files", async () => {
    stageProject({ materialized: false });
    const { projectMcp, globalCursor } = stageConfigs();
    process.chdir(projDir);

    await uninstall(["--yes"]);

    // The present global install was the target: unwired and uninstalled…
    expect(hasArgentEntry(globalCursor)).toBe(false);
    const calls = childProcessMock.execFileSync.mock.calls as Array<[string, string[]]>;
    expect(calls.some(([, args]) => args.includes("-g"))).toBe(true);
    // …while the not-yet-materialized local mode's committed files survive.
    expect(hasArgentEntry(projectMcp)).toBe(true);
    expect(fs.existsSync(path.join(projDir, ".argent", "install.json"))).toBe(true);
  });
});
